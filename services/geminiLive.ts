
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { createPcmBlob, decodeAudioData, blobToBase64 } from './audioUtils';
import { AppConfig, LogEntry } from '../types';
import { ANIMATION_NAMES } from '../constants';
import RobotBridge from './robotBridge';

// Construct a helpful description mapping for the model
const ANIMATION_DESC = ANIMATION_NAMES.map(a => `- ID "${a.id}": ${a.description}`).join('\n');

// Define tools available to the model (matching pupster.txt logic)
const TOOLS: FunctionDeclaration[] = [
  {
    name: 'queue_activate_walking',
    description: 'Activate walking mode (motors on). Required before moving.',
  },
  {
    name: 'queue_deactivate',
    description: 'Deactivate motors (relax/sleep). Use this when the user says sleep or relax.',
  },
  {
    name: 'immediate_stop',
    description: 'Emergency stop. Clears queue and stops robot immediately.',
  },
  {
    name: 'set_follow_mode',
    description: 'Enable or disable "follow me" mode where the robot tracks and follows a person.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        enabled: { type: Type.BOOLEAN, description: 'True to start following, False to stop.' }
      },
      required: ['enabled']
    }
  },
  {
    name: 'queue_animation',
    description: `Play a pre-recorded animation. Use the user's description to select the closest matching ID from the list below.\nAvailable Animations:\n${ANIMATION_DESC}`,
    parameters: {
      type: Type.OBJECT,
      properties: {
        animation_name: { 
          type: Type.STRING, 
          description: 'The exact ID of the animation to play.',
          enum: ANIMATION_NAMES.map(a => a.id)
        }
      },
      required: ['animation_name']
    }
  },
  {
    name: 'move_robot',
    description: 'Move the robot in a specific direction (Forward, Backward, Left, Right).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        direction: { type: Type.STRING, enum: ['forward', 'backward', 'left', 'right'], description: 'Direction to move.' },
        speed: { type: Type.NUMBER, description: 'Speed 0.5 to 0.75 (default 0.).' },
        duration: { type: Type.NUMBER, description: 'Duration in seconds (default 1.0).' }
      },
      required: ['direction']
    }
  },
  {
    name: 'turn_robot',
    description: 'Turn the robot Left or Right.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        direction: { type: Type.STRING, enum: ['left', 'right'], description: 'Direction to turn.' },
        angle: { type: Type.NUMBER, description: 'Approximate angle in degrees to turn (e.g. 90, 180).' }
      },
      required: ['direction']
    }
  },
  {
    name: 'queue_move',
    description: 'Advanced movement control. Use "move_robot" or "turn_robot" unless you need complex vector movement.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        forward_backward_velocity: { type: Type.NUMBER, description: 'Speed in m/s.' },
        right_left_velocity: { type: Type.NUMBER, description: 'Speed in m/s.' },
        turning_velocity: { type: Type.NUMBER, description: 'Turn rate in deg/s.' },
        duration: { type: Type.NUMBER, description: 'Duration in seconds.' },
      },
      required: ['forward_backward_velocity', 'right_left_velocity', 'turning_velocity', 'duration']
    }
  },
  {
    name: 'speak',
    description: 'Speak a message out loud to the user via voice synthesis. Use this tool whenever you want to talk, reply, narrate actions, or converse.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: {
          type: Type.STRING,
          description: 'The text message to synthesize and speak aloud.'
        }
      },
      required: ['text']
    }
  }
];

export function isAudioOutputModel(modelName: string): boolean {
  const name = modelName.toLowerCase();
  if (name.includes('robotics') || name.includes('er-2') || name.includes('er2')) {
    return false;
  }
  return true;
}

export class GeminiLiveService {
  private ai: GoogleGenAI | null = null;
  private sessionPromise: Promise<any> | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private inputScriptProcessor: ScriptProcessorNode | null = null;
  private mediaStream: MediaStream | null = null;
  private nextStartTime = 0;
  private videoInterval: number | null = null;
  private volumeInterval: number | null = null;
  private queuedSources: AudioBufferSourceNode[] = [];
  private connected = false;
  private config: AppConfig;

  public robotBridge: RobotBridge;

  // Callbacks
  onLog: (entry: LogEntry) => void;
  onAudioLevel: (level: number) => void;
  onDisconnect: () => void;

  constructor(
    config: AppConfig,
    onLog: (entry: LogEntry) => void,
    onAudioLevel: (level: number) => void,
    onDisconnect: () => void
  ) {
    this.config = config;
    this.robotBridge = new RobotBridge(config.robotApiUrl);
    this.onLog = onLog;
    this.onAudioLevel = onAudioLevel;
    this.onDisconnect = onDisconnect;
    this.queuedSources = [];
  }

  async connect(apiKey: string, config: AppConfig, videoElement: HTMLVideoElement) {
    this.config = config;
    this.ai = new GoogleGenAI({ apiKey: apiKey });

    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    
    // Create Analyser for output audio to visualize speaker sound
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.1;
    this.analyser.connect(this.audioContext.destination);

    this.startOutputVolumeMonitoring();

    const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const tracks: MediaStreamTrack[] = [];

      // Try acquiring audio
      if (config.enableAudio) {
        try {
          const audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
            }
          });
          tracks.push(...audioStream.getAudioTracks());
          this.log('info', 'Microphone connected successfully');
        } catch (audioErr: any) {
          this.log('error', `Microphone access failed: ${audioErr.message || audioErr}`);
          console.warn('Microphone error:', audioErr);
        }
      }

      // Try acquiring video
      if (config.enableVideo && config.cameraSource === 'browser') {
        try {
          const videoStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 } }
          });
          tracks.push(...videoStream.getVideoTracks());
          this.log('info', 'Camera connected successfully');
        } catch (videoErr: any) {
          this.log('error', `Camera access failed: ${videoErr.message || videoErr}`);
          console.warn('Camera error:', videoErr);
        }
      }

      if (tracks.length > 0) {
        this.mediaStream = new MediaStream(tracks);
      }
    } else {
      this.log('error', 'MediaDevices API not available. Ensure you are on HTTPS or http://localhost');
      console.warn('MediaDevices API not available. Ensure you are on HTTPS or http://localhost');
    }

    if (config.enableVideo && config.cameraSource === 'browser' && videoElement && this.mediaStream && this.mediaStream.getVideoTracks().length > 0) {
      videoElement.srcObject = this.mediaStream;
      videoElement.play().catch(e => console.error("Video play failed", e));
    }

    const modelName = config.modelName === 'gemini-2.5-flash-native-audio-preview'
      ? 'gemini-2.5-flash-native-audio-preview-12-2025'
      : config.modelName;
    const isAudioOutput = isAudioOutputModel(modelName);

    let systemInstruction = config.systemInstruction;
    if (!isAudioOutput) {
      systemInstruction += '\n\nIMPORTANT: You do not have direct voice audio output. To speak out loud to the user or narrate your actions, you MUST invoke the "speak" function tool with your response text.';
    }

    const functionDeclarations = isAudioOutput
      ? TOOLS.filter(tool => tool.name !== 'speak')
      : TOOLS;

    const liveConfig: any = {
      responseModalities: isAudioOutput ? [Modality.AUDIO] : [Modality.TEXT],
      systemInstruction: systemInstruction,
      tools: [{ functionDeclarations }],
      contextWindowCompression: { slidingWindow: {} },
    };

    if (isAudioOutput) {
      liveConfig.speechConfig = {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voiceName } },
      };
      // Gemini 3.1 Flash Live rejects these Gemini 2.5-only options during
      // session setup, which otherwise looks like a successful connection
      // followed immediately by an unexplained WebSocket close.
      const supportsExperimentalAudioFeatures = !modelName.toLowerCase().includes('gemini-3.1');
      if (supportsExperimentalAudioFeatures && config.enableAffectiveDialog) {
        liveConfig.enableAffectiveDialog = true;
      }
      if (supportsExperimentalAudioFeatures && config.enableProactiveAudio) {
        liveConfig.proactivity = { proactiveAudio: true };
      }
    }

    // Connect and store the promise
    this.log('info', `Connecting to ${modelName} (Audio Output: ${isAudioOutput ? 'Native' : 'Flash TTS via speak tool'})...`);
    this.sessionPromise = this.ai.live.connect({
      model: modelName,
      config: liveConfig,
      callbacks: {
        onopen: () => {
          this.connected = true;
          this.log('info', 'Session connected');
          if (this.mediaStream) {
            this.setupAudioInput(inputCtx, this.mediaStream);
          }
          if (config.enableVideo) {
            this.setupVideoInput(videoElement, config.cameraSource);
          }
        },
        onmessage: async (msg: LiveServerMessage) => {
          if (!this.connected) return;
          await this.handleMessage(msg);
        },
        onclose: (event: CloseEvent) => {
          const details = [
            event.code ? `code ${event.code}` : '',
            event.reason || '',
          ].filter(Boolean).join(': ');
          this.log('error', `Session closed${details ? ` (${details})` : ''}`);
          this.cleanup();
          this.onDisconnect();
        },
        onerror: (err: ErrorEvent) => {
          const details = err.message || err.error?.message || String(err.error || 'WebSocket error');
          this.log('error', `Session error: ${details}`);
          console.log(err);
        }
      }
    });

    // Wait for connection to ensure validity
    await this.sessionPromise;
  }

  private startOutputVolumeMonitoring() {
    if (this.volumeInterval) clearInterval(this.volumeInterval);
    this.volumeInterval = window.setInterval(() => {
      if (!this.analyser) return;
      
      const array = new Uint8Array(this.analyser.fftSize);
      this.analyser.getByteTimeDomainData(array);
      
      let sum = 0;
      for (let i = 0; i < array.length; i++) {
        const a = (array[i] - 128) / 128;
        sum += a * a;
      }
      const rms = Math.sqrt(sum / array.length);
      // Boost factor to make mouth movement more visible
      this.onAudioLevel(Math.min(1.0, rms * 3)); 
    }, 50);
  }

  private setupAudioInput(ctx: AudioContext, stream: MediaStream) {
    const source = ctx.createMediaStreamSource(stream);
    this.inputScriptProcessor = ctx.createScriptProcessor(4096, 1, 1);
    
    this.inputScriptProcessor.onaudioprocess = (e) => {
      if (!this.connected || !this.sessionPromise) return;

      const inputData = e.inputBuffer.getChannelData(0);
      const pcmBlob = createPcmBlob(inputData);
      
      this.sessionPromise.then(session => {
        if (!this.connected) return;
        try {
           session.sendRealtimeInput({ 
             audio: { 
               data: pcmBlob.data, 
               mimeType: pcmBlob.mimeType 
             } 
           });
        } catch(err) {
           // Ignore errors if session is closing
        }
      });
    };

    source.connect(this.inputScriptProcessor);
    this.inputScriptProcessor.connect(ctx.destination);
  }

  private setupVideoInput(videoEl: HTMLVideoElement, source: 'browser' | 'server') {
    if (this.videoInterval) clearInterval(this.videoInterval);
    
    if (source === 'browser') {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        this.videoInterval = window.setInterval(async () => {
          if (!this.connected || !this.sessionPromise || !ctx || !videoEl.videoWidth) return;
          
          canvas.width = videoEl.videoWidth * 0.5;
          canvas.height = videoEl.videoHeight * 0.5;
          ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
          
          canvas.toBlob(async (blob) => {
            if (!blob || !this.connected) return;
            const base64 = await blobToBase64(blob);
            this.sessionPromise?.then(session => {
                if (!this.connected) return;
                try {
                    session.sendRealtimeInput({ 
                      video: { 
                        mimeType: 'image/jpeg', 
                        data: base64 
                      }
                    })
                } catch(err) {}
            });
          }, 'image/jpeg', 0.6);
        }, 1000);
    } else {
        // Server source
        this.videoInterval = window.setInterval(async () => {
             if (!this.connected || !this.sessionPromise) return;
             const blob = await this.robotBridge.getCameraImage();
             if (blob && this.connected) {
                 const base64 = await blobToBase64(blob);
                 this.sessionPromise?.then(session => {
                    if (!this.connected) return;
                    try {
                        session.sendRealtimeInput({ 
                          video: { 
                            mimeType: 'image/jpeg', 
                            data: base64 
                          }
                        })
                    } catch(err) {}
                });
             }
        }, 1000); // 2Hz
    }
  }

  private async playAudioBase64(audioData: string): Promise<void> {
    if (!this.audioContext || !this.analyser) return;
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    this.nextStartTime = Math.max(this.nextStartTime, this.audioContext.currentTime);
    const buffer = await decodeAudioData(audioData, this.audioContext);
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);
    source.start(this.nextStartTime);
    this.queuedSources.push(source);
    this.nextStartTime += buffer.duration;

    // Streaming callers must be able to enqueue the next chunk immediately;
    // waiting for playback to finish here would recreate full-response latency.
    source.onended = () => {
      const idx = this.queuedSources.indexOf(source);
      if (idx !== -1) {
        this.queuedSources.splice(idx, 1);
      }
    };
  }

  private async synthesizeAndPlaySpeech(text: string): Promise<void> {
    try {
      if (!this.ai) return;
      const configuredModel = this.config.ttsModelName || "gemini-3.1-flash-tts-preview";
      const ttsModel = configuredModel === "gemini-2.5-flash-preview"
        ? "gemini-2.5-flash-preview-tts"
        : configuredModel;
      const supportsStreaming = ttsModel.startsWith("gemini-3.1-");
      this.log("info", "Synthesizing speech via " + ttsModel + (supportsStreaming ? " (streaming)..." : "..."));

      const request: any = {
        model: ttsModel,
        contents: [{ parts: [{ text }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.config.voiceName || "Puck",
              }
            }
          }
        }
      };

      let receivedAudio = false;
      if (supportsStreaming) {
        const responseStream = await this.ai.models.generateContentStream(request);
        for await (const chunk of responseStream) {
          const parts = chunk.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            const audioData = part.inlineData?.data;
            if (audioData) {
              receivedAudio = true;
              await this.playAudioBase64(audioData);
            }
          }
        }
      } else {
        const response = await this.ai.models.generateContent(request);
        const parts = response.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          const audioData = part.inlineData?.data;
          if (audioData) {
            receivedAudio = true;
            await this.playAudioBase64(audioData);
          }
        }
      }

      if (!receivedAudio) {
        console.warn("No audio data returned by TTS model, using browser speech fallback");
        this.speakWithWebSpeech(text);
      }
    } catch (err: any) {
      this.log("error", "TTS error: " + (err.message || err) + ". Using browser speech fallback.");
      this.speakWithWebSpeech(text);
    }
  }

  private speakWithWebSpeech(text: string): void {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      let interval: number | null = null;
      utterance.onstart = () => {
        interval = window.setInterval(() => {
          this.onAudioLevel(0.2 + Math.random() * 0.3);
        }, 100);
      };
      const stopVisual = () => {
        if (interval) clearInterval(interval);
        this.onAudioLevel(0);
      };
      utterance.onend = stopVisual;
      utterance.onerror = stopVisual;
      window.speechSynthesis.speak(utterance);
    }
  }

  private async handleMessage(message: LiveServerMessage) {
    // Check for native audio output
    const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
    if (audioData && this.audioContext && this.analyser) {
      await this.playAudioBase64(audioData);
    }

    // Check for text output (useful for ER2 streaming / text models)
    const textPart = message.serverContent?.modelTurn?.parts?.find((p: any) => p.text)?.text;
    if (textPart) {
      this.log('model', `Text: ${textPart}`);
    }

    if (message.toolCall) {
      for (const fc of message.toolCall.functionCalls) {
        this.log('function', `Call: ${fc.name}(${JSON.stringify(fc.args)})`);
        let result: any = { success: true };
        
        try {
          // Helper args
          const args = fc.args as any;

          switch (fc.name) {
            case 'speak':
            case 'say':
            case 'narrate':
              if (isAudioOutputModel(this.config.modelName)) {
                result = { success: false, error: 'Native-audio models must speak through their Live API audio response' };
                break;
              }
              const speechText = args.text || args.message || args.content || '';
              if (speechText) {
                this.log('model', `Pupster: "${speechText}"`);
                await this.synthesizeAndPlaySpeech(speechText);
                result = { success: true, spoken: true, text: speechText };
              } else {
                result = { success: false, error: 'No text provided to speak' };
              }
              break;
            case 'queue_activate_walking':
              await this.robotBridge.queueActivateWalking();
              break;
            case 'queue_deactivate':
              await this.robotBridge.queueDeactivate();
              break;
            case 'immediate_stop':
              await this.robotBridge.immediateStop();
              break;
            case 'set_follow_mode':
              await this.robotBridge.setFollowMode(args.enabled);
              break;
            case 'queue_animation':
              await this.robotBridge.queueAnimation(args.animation_name);
              break;
            case 'queue_move':
              await this.robotBridge.queueMove(args);
              break;
            case 'move_robot':
              const speed = args.speed || 0.5;
              const duration = args.duration || 1.0;
              let vx = 0, vy = 0;
              if (args.direction === 'forward') vx = speed;
              else if (args.direction === 'backward') vx = -speed;
              else if (args.direction === 'left') vy = -speed; // Robot frame usually left is +y
              else if (args.direction === 'right') vy = speed;
              await this.robotBridge.queueMove({ vx, vy, wz: 0, duration });
              break;
            case 'turn_robot':
              const angle = args.angle || 45;
              const turnDir = args.direction === 'left' ? -1 : 1;
              const turnSpeed = 60; // deg/s
              const turnDuration = angle / turnSpeed;
              await this.robotBridge.queueMove({ vx: 0, vy: 0, wz: turnDir * turnSpeed, duration: turnDuration });
              break;
            default:
              result = { error: 'Unknown tool' };
          }
        } catch (e: any) {
          result = { error: e.message };
        }

        if (this.connected && this.sessionPromise) {
          this.sessionPromise.then(session => {
            if (!this.connected) return;
            try {
              session.sendToolResponse({
                functionResponses: {
                  id: fc.id,
                  name: fc.name,
                  response: { result }
                }
              });
            } catch (err) {
              // Session may have closed between check and send
            }
          });
        }
      }
    }

    if (message.serverContent?.interrupted) {
      this.log('info', 'Model interrupted');
      this.queuedSources.forEach(s => {
        try { s.stop(); } catch (e) {}
      });
      this.queuedSources = [];
      this.nextStartTime = 0;
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    }
  }

  /**
   * Stop all intervals and null out session/resources.
   * Called both on explicit disconnect and on server-side onclose.
   */
  private cleanup() {
    this.connected = false;

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }

    if (this.inputScriptProcessor) {
      this.inputScriptProcessor.disconnect();
      this.inputScriptProcessor = null;
    }
    if (this.videoInterval) {
      clearInterval(this.videoInterval);
      this.videoInterval = null;
    }
    if (this.volumeInterval) {
      clearInterval(this.volumeInterval);
      this.volumeInterval = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
    this.analyser = null;
    this.queuedSources = [];
    this.nextStartTime = 0;
  }

  public async disconnect() {
    // Set flag first to stop all in-flight sends immediately
    this.connected = false;
    this.cleanup();

    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    // Critical: Close the session to allow reconnection
    if (this.sessionPromise) {
      try {
        const session = await this.sessionPromise;
        await session.close();
      } catch (e) {
        console.error("Error closing session", e);
      }
    }

    this.sessionPromise = null;
    this.ai = null;
  }

  private log(type: LogEntry['type'], message: string) {
    this.onLog({
      id: Math.random().toString(36),
      timestamp: Date.now(),
      type,
      message
    });
  }
}
