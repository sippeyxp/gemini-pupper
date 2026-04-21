
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
  }
];

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
  private queuedSources = [];
  private connected = false;

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
    this.robotBridge = new RobotBridge(config.robotApiUrl);
    this.onLog = onLog;
    this.onAudioLevel = onAudioLevel;
    this.onDisconnect = onDisconnect;
    this.queuedSources = [];
  }

  async connect(apiKey: string, config: AppConfig, videoElement: HTMLVideoElement) {
    // this.ai = new GoogleGenAI({ apiKey }); // keep this comment
    this.ai = new GoogleGenAI({ apiKey: apiKey });

    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    
    // Create Analyser for output audio to visualize speaker sound
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.1;
    this.analyser.connect(this.audioContext.destination);

    this.startOutputVolumeMonitoring();

    const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });

    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: (config.enableVideo && config.cameraSource === 'browser') ? { width: 640, height: 480 } : false
      };
      
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('MediaDevices API not available (likely non-secure context or blocked iframe)');
      }

      try {
        this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (videoErr: any) {
        // If searching for video failed, try audio only
        if (constraints.video) {
          this.log('info', 'Video access failed, falling back to audio only');
          this.mediaStream = await navigator.mediaDevices.getUserMedia({ 
            audio: constraints.audio 
          });
        } else {
          throw videoErr;
        }
      }
    } catch (e: any) {
      const errorMsg = e.message || 'Unknown error';
      this.log('error', `Failed to access audio: ${errorMsg}`);
      console.error('getUserMedia error:', e);
      throw e;
    }

    if (config.enableVideo && config.cameraSource === 'browser' && videoElement && this.mediaStream) {
      videoElement.srcObject = this.mediaStream;
      videoElement.play().catch(e => console.error("Video play failed", e));
    }

    // Connect and store the promise
    console.log("Start connecting...");
    this.sessionPromise = this.ai.live.connect({
      model: config.modelName,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voiceName } },
        },
        systemInstruction: config.systemInstruction,
        tools: [{ functionDeclarations: TOOLS }],
        contextWindowCompression: { slidingWindow: {} },
        // enableAffectiveDialog: config.enableAffectiveDialog,
        // proactivity: config.enableProactiveAudio ? { proactiveAudio: true } : undefined
      },
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
        onclose: () => {
          this.log('error', 'Session closed');
          this.cleanup();
          this.onDisconnect();
        },
        onerror: (err) => {
          this.log('error', `Session error: ${err}`);
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

  private async handleMessage(message: LiveServerMessage) {
    const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
    if (audioData && this.audioContext && this.analyser) {
      this.nextStartTime = Math.max(this.nextStartTime, this.audioContext.currentTime);
      const buffer = await decodeAudioData(audioData, this.audioContext);
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.analyser);
      source.start(this.nextStartTime);
      this.queuedSources.push(source);
      this.nextStartTime += buffer.duration;
    }

    if (message.toolCall) {
      for (const fc of message.toolCall.functionCalls) {
        this.log('function', `Call: ${fc.name}(${JSON.stringify(fc.args)})`);
        let result: any = { success: true };
        
        try {
          // Helper args
          const args = fc.args as any;

          switch (fc.name) {
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
      this.queuedSources.forEach(s => s.stop());
      this.queuedSources = []
      this.nextStartTime = 0;
    }
  }

  /**
   * Stop all intervals and null out session/resources.
   * Called both on explicit disconnect and on server-side onclose.
   */
  private cleanup() {
    this.connected = false;

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
