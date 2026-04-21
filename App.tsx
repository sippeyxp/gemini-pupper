import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ConnectionState, AppConfig, LogEntry, SystemStatus } from './types';
import { DEFAULT_CONFIG } from './constants';
import DogFace from './components/DogFace';
import DebugPanel from './components/DebugPanel';
import Settings from './components/Settings';
import { GeminiLiveService } from './services/geminiLive';
import RobotBridge from './services/robotBridge';

// Icons
const CogIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.47a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
);
const TerminalIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
);
const FaceIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
);
const PowerIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
);
const MoonIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
);

const App: React.FC = () => {
  const [view, setView] = useState<'face' | 'debug'>('face');
  const [showSettings, setShowSettings] = useState(false);
  const [connState, setConnState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  
  // Load API Key from localStorage
  const [apiKey, setApiKey] = useState(() => {
    return localStorage.getItem('pupster_api_key') || '';
  });

  // Load Config from localStorage
  const [config, setConfig] = useState<AppConfig>(() => {
    const saved = localStorage.getItem('pupster_config');
    if (saved) {
      try {
        return { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
      } catch (e) {
        console.error("Failed to parse saved config", e);
      }
    }
    return DEFAULT_CONFIG;
  });
  
  // Persist API Key changes
  useEffect(() => {
    localStorage.setItem('pupster_api_key', apiKey);
  }, [apiKey]);

  // Persist Config changes
  useEffect(() => {
    localStorage.setItem('pupster_config', JSON.stringify(config));
  }, [config]);

  // Runtime State
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [audioLevel, setAudioLevel] = useState(0);
  
  // Create a persistent video element
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
  const hiddenVideoContainerRef = useRef<HTMLDivElement>(null);

  // UI Visibility State (for auto-hiding footer)
  const [isUiVisible, setIsUiVisible] = useState(true);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  useEffect(() => {
    const v = document.createElement('video');
    v.autoplay = true;
    v.muted = true;
    v.playsInline = true;
    setVideoElement(v);
    return () => {
        v.srcObject = null;
    };
  }, []);

  // When in Face mode, park the video element in the hidden container so it stays active
  useEffect(() => {
    if (view === 'face' && videoElement && hiddenVideoContainerRef.current) {
        hiddenVideoContainerRef.current.appendChild(videoElement);
    }
  }, [view, videoElement]);

  // Activity Monitor for Auto-Hiding UI
  useEffect(() => {
    const resetIdleTimer = () => {
      setIsUiVisible(true);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      
      // Only set auto-hide timer if we are in face mode
      if (view === 'face') {
        idleTimerRef.current = setTimeout(() => {
          setIsUiVisible(false);
        }, 5000); // 5 seconds
      }
    };

    // Attach listeners
    window.addEventListener('mousemove', resetIdleTimer);
    window.addEventListener('mousedown', resetIdleTimer);
    window.addEventListener('touchstart', resetIdleTimer);
    window.addEventListener('keydown', resetIdleTimer);

    // Initial trigger
    resetIdleTimer();

    return () => {
      window.removeEventListener('mousemove', resetIdleTimer);
      window.removeEventListener('mousedown', resetIdleTimer);
      window.removeEventListener('touchstart', resetIdleTimer);
      window.removeEventListener('keydown', resetIdleTimer);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [view]);

  const geminiRef = useRef<GeminiLiveService | null>(null);
  // Persistent bridge instance for polling
  const bridgeRef = useRef<RobotBridge>(new RobotBridge(config.robotApiUrl));

  useEffect(() => {
    bridgeRef.current = new RobotBridge(config.robotApiUrl);
  }, [config.robotApiUrl]);

  const addLog = useCallback((entry: LogEntry) => {
    setLogs(prev => [...prev.slice(-99), entry]); // Keep last 100 logs
  }, []);

  // Background System Polling Loop (Slow, for critical battery alerts)
  useEffect(() => {
    const interval = setInterval(async () => {
        const status = await bridgeRef.current.getSystemStatus();
        setSystemStatus(status);
        // Do not log here to avoid spam. DebugPanel will handle its own fast polling.
    }, 60000); // Poll every 60s
    return () => clearInterval(interval);
  }, [addLog]);

  const handleConnect = async () => {
    if (!apiKey) {
      addLog({ id: 'err-key', timestamp: Date.now(), type: 'error', message: 'API Key missing' });
      setShowSettings(true);
      return;
    }
    
    if (!videoElement) {
        addLog({ id: 'err-vid', timestamp: Date.now(), type: 'error', message: 'Video initialization failed' });
        return;
    }

    try {
      setConnState(ConnectionState.CONNECTING);
      
      const service = new GeminiLiveService(
        config,
        addLog,
        (level) => setAudioLevel(level),
        () => setConnState(ConnectionState.DISCONNECTED)
      );

      await service.connect(apiKey, config, videoElement);
      geminiRef.current = service;
      setConnState(ConnectionState.CONNECTED);
    } catch (err: any) {
      console.error(err);
      addLog({ id: 'conn-err', timestamp: Date.now(), type: 'error', message: err.message });
      setConnState(ConnectionState.ERROR);
    }
  };

  const handleDisconnect = async () => {
    if (geminiRef.current) {
      try {
        await geminiRef.current.robotBridge.queueDeactivate();
      } catch (e) { console.error(e); }
      await geminiRef.current.disconnect();
      geminiRef.current = null;
    }
    
    if (videoElement) {
        videoElement.srcObject = null;
    }
    
    setConnState(ConnectionState.DISCONNECTED);
  };

  return (
    <div className="h-screen w-screen bg-black flex flex-col font-sans text-gray-100 overflow-hidden relative">
      
      <div 
        ref={hiddenVideoContainerRef} 
        style={{ position: 'absolute', top: 0, left: 0, width: '1px', height: '1px', opacity: 0, overflow: 'hidden', pointerEvents: 'none' }} 
      />

      <main 
        className="flex-1 relative overflow-hidden"
      >
        {view === 'face' ? (
          <DogFace 
            isListening={connState === ConnectionState.CONNECTED}
            isSpeaking={audioLevel > 0.05} 
            audioLevel={audioLevel}
            systemStatus={systemStatus}
            config={config}
            videoElement={videoElement}
          />
        ) : (
          <DebugPanel 
            logs={logs} 
            videoElement={videoElement}
            robotBridge={geminiRef.current ? (geminiRef.current as any).robotBridge : bridgeRef.current} 
            systemStatus={systemStatus}
            onStatusUpdate={setSystemStatus}
            cameraSource={config.cameraSource}
          />
        )}

        {connState === ConnectionState.DISCONNECTED && (
           <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm z-10 pointer-events-auto">
              <button 
                onClick={handleConnect}
                className="bg-cyan-500 hover:bg-cyan-400 text-black font-bold py-4 px-8 rounded-full shadow-[0_0_30px_rgba(34,211,238,0.5)] transform hover:scale-105 transition-all text-xl flex items-center gap-2"
              >
                <PowerIcon /> WAKE PUPSTER
              </button>
           </div>
        )}
      </main>

      <footer className={`
        h-16 flex items-center justify-between px-4 z-20 transition-all duration-500 ease-in-out
        ${view === 'face' ? 'absolute bottom-0 left-0 right-0 border-t-0 bg-gray-900/60 backdrop-blur-sm' : 'relative bg-gray-900 border-t border-gray-800'}
        ${view === 'face' && !isUiVisible ? 'translate-y-full opacity-0 pointer-events-none' : 'translate-y-0 opacity-100 pointer-events-auto'}
      `}>
        <div className="flex items-center space-x-3 w-32">
           <div className={`w-3 h-3 rounded-full ${
             connState === ConnectionState.CONNECTED ? 'bg-green-500 shadow-[0_0_10px_#22c55e]' : 
             connState === ConnectionState.CONNECTING ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'
           }`} />
           <span className="text-xs font-mono text-gray-400 uppercase">{connState}</span>
        </div>

        <div className="flex bg-gray-800 rounded-lg p-1">
          <button 
            onClick={() => setView('face')}
            className={`p-2 rounded ${view === 'face' ? 'bg-gray-700 text-cyan-400' : 'text-gray-500'}`}
          >
            <FaceIcon />
          </button>
          <button 
            onClick={() => setView('debug')}
            className={`p-2 rounded ${view === 'debug' ? 'bg-gray-700 text-cyan-400' : 'text-gray-500'}`}
          >
            <TerminalIcon />
          </button>
        </div>

        <div className="flex items-center space-x-2 w-32 justify-end">
          {connState === ConnectionState.CONNECTED ? (
             <button 
               onClick={handleDisconnect}
               title="Sleep / Disconnect"
               className="bg-red-900/50 hover:bg-red-900 text-red-200 p-2 rounded-full border border-red-800 transition-colors"
             >
               <PowerIcon />
             </button>
          ) : (
            <div className="text-gray-500 flex items-center gap-1 mr-2" title="Sleeping">
              <MoonIcon />
              <span className="text-xs font-medium">SLEEPING</span>
            </div>
          )}
          <button 
            onClick={() => {
              setShowSettings(true);
              if (document.fullscreenElement) {
                document.exitFullscreen().catch(e => console.error(e));
              }
            }}
            className="p-2 text-gray-400 hover:text-white"
            title="Settings"
          >
            <CogIcon />
          </button>
        </div>
      </footer>

      {showSettings && (
        <Settings 
          apiKey={apiKey} 
          setApiKey={setApiKey} 
          config={config} 
          setConfig={setConfig} 
          onClose={() => setShowSettings(false)} 
        />
      )}
    </div>
  );
};

export default App;