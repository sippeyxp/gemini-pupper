import React, { useEffect, useState, useRef } from 'react';
import { SystemStatus, AppConfig } from '../types';
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

interface DogFaceProps {
  isListening: boolean;
  isSpeaking: boolean;
  audioLevel: number;
  systemStatus: SystemStatus | null;
  config: AppConfig;
  videoElement: HTMLVideoElement | null;
}

// Interfaces for ZMQ Detections
interface PersonLocation {
    x: number;
    y: number;
    width: number;
    height: number;
    heading: number; // degrees
    elevation: number; // degrees
    id: number;
}

interface PeopleDetections {
    people: PersonLocation[];
    timestamp: number;
}

// Configuration
const EYE_TRACKING = {
  sensitivity: 0.6, 
  maxPupilOffset: 40.0, 
  maxEyeOffset: 60.0,
  combinedPupilRatio: 0.6,
  smoothing: 0.15,
};

// SVG Geometry helpers
const getQuadraticBezier = (start: {x:number, y:number}, ctrl: {x:number, y:number}, end: {x:number, y:number}) => {
  return `M ${start.x} ${start.y} Q ${ctrl.x} ${ctrl.y} ${end.x} ${end.y}`;
};

const Eye: React.FC<{
  cx: number;
  cy: number;
  scale: number;
  pupilOffset: { x: number; y: number };
}> = ({ cx, cy, scale, pupilOffset }) => {
  const colors = {
    ringOuter: '#2a2f36',
    ringBlue: '#4b95b5',
    underHighlight: '#326688',
    pupil: '#000000',
    gloss: 'rgba(255, 255, 255, 0.95)',
  };

  const rOuter = 140 * scale;
  const rBezel = 132 * scale;
  const rPupil = 100 * scale;

  const px = cx + pupilOffset.x;
  const py = cy + pupilOffset.y;

  return (
    <g>
      {/* Outer Dark Ring */}
      <circle cx={cx} cy={cy} r={rOuter} fill="none" stroke={colors.ringOuter} strokeWidth={8 * scale} />
      
      {/* Blue Bezel */}
      <circle cx={cx} cy={cy} r={rBezel} fill={colors.ringBlue} />

      {/* Pupil */}
      <circle cx={px} cy={py} r={rPupil} fill={colors.pupil} />

      {/* Under Highlight Arc */}
      <path 
        d={`M ${px + (56*scale)} ${py + (56*scale)} A ${80*scale} ${80*scale} 0 0 1 ${px - (56*scale)} ${py + (56*scale)}`}
        fill="none" 
        stroke={colors.underHighlight} 
        strokeWidth={14 * scale} 
        strokeLinecap="round"
      />
      
      {/* Little Blue Dot */}
      <circle cx={px + (76*scale)} cy={py + (34*scale)} r={8*scale} fill={colors.underHighlight} />

      {/* Gloss Highlights */}
      <circle cx={px - (42*scale)} cy={py - (54*scale)} r={26*scale} fill={colors.gloss} />
      <circle cx={px - (70*scale)} cy={py - (8*scale)} r={12*scale} fill={colors.gloss} />
    </g>
  );
};

const Eyebrow: React.FC<{ cx: number; cy: number; scale: number; }> = ({ cx, cy, scale }) => {
  const dx = 88 * scale;
  const dyStart = 150 * scale;
  const dyCtrl = 195 * scale;

  const start = { x: cx - dx, y: cy - dyStart };
  const ctrl = { x: cx, y: cy - dyCtrl };
  const end = { x: cx + dx, y: cy - dyStart };

  return (
    <path 
      d={getQuadraticBezier(start, ctrl, end)} 
      fill="none" 
      stroke="#33363c" 
      strokeWidth={14 * scale} 
      strokeLinecap="round" 
    />
  );
};

const Nose: React.FC<{ cx: number; cy: number; scale: number }> = ({ cx, cy, scale }) => {
    return (
        <path 
            d={`M ${cx - 30*scale} ${cy - 10*scale} 
                Q ${cx} ${cy - 20*scale} ${cx + 30*scale} ${cy - 10*scale}
                Q ${cx} ${cy + 40*scale} ${cx - 30*scale} ${cy - 10*scale}`}
            fill="#1f2937"
        />
    );
};

const DogFace: React.FC<DogFaceProps> = ({ isListening, isSpeaking, audioLevel, systemStatus, config, videoElement }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  
  // Layout State
  const [windowCenter, setWindowCenter] = useState({ x: 0, y: 0 });
  const [globalScale, setGlobalScale] = useState(1.0);
  
  // Tracking State
  const targetPosRef = useRef({ x: 0.5, y: 0.5 }); // Normalized 0..1
  const currentPosRef = useRef({ x: 0.5, y: 0.5 }); // Normalized 0..1
  const [renderPos, setRenderPos] = useState({ x: 0.5, y: 0.5 });
  
  // Detection State
  const lastDetectionTime = useRef<number>(0);

  // Critical Error Logic: Only error if we HAVE status and it's bad.
  // Don't error on null (connecting).
  const isConnected = !!systemStatus;
  const isLowBattery = systemStatus?.battery?.percentage != null && systemStatus.battery.percentage < 10;
  const isRobotInactive = systemStatus?.services?.robot === 'inactive';
  
  const hasCriticalError = isConnected && (isLowBattery || isRobotInactive);

  // Resize Handler
  useEffect(() => {
    const handleResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      setWindowCenter({ x: w / 2, y: h / 2 });
      
      const wScale = w / 600; 
      const hScale = h / 500;
      let newScale = Math.min(wScale, hScale);
      newScale = Math.max(0.4, Math.min(1.2, newScale));
      setGlobalScale(newScale);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // --- SOURCE 1: SERVER (ZMQ) ---
  useEffect(() => {
    if (config.eyeTrackingSource !== 'server') return;
    
    let ws: WebSocket;
    let reconnectTimer: any;
    let isUnmounted = false;

    const connect = () => {
        if (isUnmounted) return;
        try {
            const httpUrl = config.robotApiUrl.replace(/\/$/, '');
            const wsUrl = httpUrl.replace(/^http/, 'ws') + '/ws/detections';
            
            ws = new WebSocket(wsUrl);
            ws.onopen = () => console.log("[Face] WS Connected");
            ws.onmessage = (event) => {
                try {
                    const data: PeopleDetections = JSON.parse(event.data);
                    
                    if (data.people && Array.isArray(data.people) && data.people.length > 0) {
                         // Find the person with the largest bounding box area
                         let largest: PersonLocation | null = null;
                         let maxArea = -1;
            
                         for (const p of data.people) {
                             const area = p.width * p.height;
                             if (area > maxArea) {
                                 maxArea = area;
                                 largest = p;
                             }
                         }
            
                         if (largest) {
                             // Calculate offset based on heading and elevation
                             // Based on Rust reference: offset = degrees / 90 * (window_size / 2)
                             // Mapping this to normalized coordinates [0, 1] centered at 0.5:
                             // offset_norm = (degrees / 90) * 0.5
                             
                             const h = Math.max(-90, Math.min(90, largest.heading));
                             const e = Math.max(-90, Math.min(90, largest.elevation));
            
                             const tx = 0.5 - (h / 90.0) * 0.5 * 3;
                             const ty = 1.0 - (e / 90.0) * 0.5 * 10;
            
                             targetPosRef.current = { x: tx, y: ty };
                             lastDetectionTime.current = Date.now();
                         }
                    } else if ((data as any).center) {
                        // Fallback for older format
                        const fallback = data as any;
                        targetPosRef.current = { x: fallback.center.x, y: fallback.center.y };
                        lastDetectionTime.current = Date.now();
                    }
                } catch(e) {}
            };
            ws.onclose = () => {
                if (!isUnmounted) reconnectTimer = setTimeout(connect, 2000);
            };
            ws.onerror = () => ws.close();
        } catch(e) {
            if (!isUnmounted) reconnectTimer = setTimeout(connect, 5000);
        }
    };

    connect();
    return () => {
        isUnmounted = true;
        if (ws) ws.close();
        clearTimeout(reconnectTimer);
    };
  }, [config.eyeTrackingSource, config.robotApiUrl]);

  // --- SOURCE 2: MEDIAPIPE ---
  useEffect(() => {
    if (config.eyeTrackingSource !== 'mediapipe' || !videoElement) return;

    let faceLandmarker: FaceLandmarker | null = null;
    let animationId: number;
    let lastVideoTime = -1;

    const setupMediaPipe = async () => {
        try {
            const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
            faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
                    delegate: "GPU"
                },
                runningMode: "VIDEO",
                numFaces: 1
            });
            predictLoop();
        } catch (e) {
            console.error("Failed to load MediaPipe:", e);
        }
    };

    const predictLoop = () => {
        if (faceLandmarker && videoElement && videoElement.currentTime !== lastVideoTime) {
            lastVideoTime = videoElement.currentTime;
            try {
                const results = faceLandmarker.detectForVideo(videoElement, performance.now());
                if (results.faceLandmarks && results.faceLandmarks.length > 0) {
                    // Get bounding box roughly from landmarks
                    // Simple average of points
                    let xSum = 0, ySum = 0;
                    const points = results.faceLandmarks[0];
                    for (const p of points) {
                        xSum += p.x;
                        ySum += p.y;
                    }
                    const avgX = xSum / points.length;
                    const avgY = ySum / points.length;
                    
                    // Mirror X because it's a selfie camera usually
                    targetPosRef.current = { x: 1.0 - avgX, y: avgY };
                    lastDetectionTime.current = Date.now();
                }
            } catch(e) {}
        }
        animationId = requestAnimationFrame(predictLoop);
    };

    setupMediaPipe();

    return () => {
        cancelAnimationFrame(animationId);
        if (faceLandmarker) faceLandmarker.close();
    };
  }, [config.eyeTrackingSource, videoElement]);

  // --- SOURCE 3: MOUSE (Always active as fallback if others timeout) ---
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      // If Explicitly 'mouse', always use it.
      // If 'server' or 'mediapipe', only use fallback if timeout > 1s
      const useMouse = config.eyeTrackingSource === 'mouse' || (Date.now() - lastDetectionTime.current > 1000);
      
      if (useMouse) {
        const nx = e.clientX / window.innerWidth;
        const ny = e.clientY / window.innerHeight;
        targetPosRef.current = { x: nx, y: ny };
      }
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [config.eyeTrackingSource]);

  // Animation Loop for Smoothing
  useEffect(() => {
    let animFrame: number;
    
    const loop = () => {
      const target = targetPosRef.current;
      const current = currentPosRef.current;
      
      const dx = target.x - current.x;
      const dy = target.y - current.y;
      const smooth = EYE_TRACKING.smoothing;
      
      currentPosRef.current = {
          x: current.x + dx * smooth,
          y: current.y + dy * smooth
      };

      setRenderPos({ ...currentPosRef.current });
      animFrame = requestAnimationFrame(loop);
    };
    
    loop();
    return () => cancelAnimationFrame(animFrame);
  }, []);

  // Calculate Eye Components
  const calculateEyeOffset = () => {
    const rx = (renderPos.x - 0.5) * 2.0; 
    const ry = (renderPos.y - 0.5) * 2.0;

    const sx = rx * EYE_TRACKING.sensitivity;
    const sy = ry * EYE_TRACKING.sensitivity;

    const maxEye = EYE_TRACKING.maxEyeOffset * globalScale;
    const ex = sx * maxEye;
    const ey = sy * maxEye;

    const maxPupil = EYE_TRACKING.maxPupilOffset * globalScale;
    let px = sx * (maxPupil / 0.5); 
    let py = sy * (maxPupil / 0.5);

    const pLen = Math.sqrt(px*px + py*py);
    if (pLen > maxPupil) {
        px = (px / pLen) * maxPupil;
        py = (py / pLen) * maxPupil;
    }

    return {
      eye: { x: ex, y: ey },
      pupil: { x: px, y: py }
    };
  };

  const offsets = calculateEyeOffset();
  
  // Layout Constants
  const eyeSeparation = 180 * globalScale;
  
  // Vertical Alignment
  const yOffset = -80 * globalScale; // Eyes in upper half
  
  const leftEyeCenter = { x: windowCenter.x - eyeSeparation + offsets.eye.x, y: windowCenter.y + yOffset + offsets.eye.y };
  const rightEyeCenter = { x: windowCenter.x + eyeSeparation + offsets.eye.x, y: windowCenter.y + yOffset + offsets.eye.y };
  
  // Nose positioned below eyes
  const nosePos = { x: windowCenter.x + (offsets.eye.x * 0.5), y: windowCenter.y + yOffset + (180 * globalScale) + (offsets.eye.y * 0.5) };
  
  // Mouth positioned below nose
  const mouthBaseY = windowCenter.y + yOffset + (260 * globalScale);

  return (
    <div className="w-full h-full bg-black relative overflow-hidden flex items-center justify-center">
      {/* Background Ambience */}
      <div className={`absolute inset-0 bg-blue-900/5 transition-opacity duration-500 ${isListening ? 'opacity-100' : 'opacity-0'}`} />

      <svg 
        ref={svgRef}
        className="w-full h-full"
        viewBox={`0 0 ${window.innerWidth} ${window.innerHeight}`}
      >
        {/* Left Eye */}
        <g>
          <Eyebrow cx={leftEyeCenter.x} cy={leftEyeCenter.y} scale={globalScale} />
          <Eye cx={leftEyeCenter.x} cy={leftEyeCenter.y} scale={globalScale} pupilOffset={offsets.pupil} />
        </g>

        {/* Right Eye */}
        <g>
          <Eyebrow cx={rightEyeCenter.x} cy={rightEyeCenter.y} scale={globalScale} />
          <Eye cx={rightEyeCenter.x} cy={rightEyeCenter.y} scale={globalScale} pupilOffset={offsets.pupil} />
        </g>

        {/* Nose */}
        <Nose cx={nosePos.x} cy={nosePos.y} scale={globalScale} />

        {/* Mouth */}
        {!hasCriticalError && (
          <>
            {/* Static Closed Mouth (Visible when not speaking) */}
            <path 
                d={`M ${windowCenter.x - (30*globalScale)} ${mouthBaseY} 
                    Q ${windowCenter.x} ${mouthBaseY + (10 * globalScale)} 
                    ${windowCenter.x + (30*globalScale)} ${mouthBaseY}`}
                fill="none"
                stroke="#33363c"
                strokeWidth={4 * globalScale}
                strokeLinecap="round"
                style={{ opacity: isSpeaking ? 0 : 1, transition: 'opacity 0.1s' }}
            />

            {/* Dynamic Speaking Mouth */}
            <path 
                d={`M ${windowCenter.x - (35*globalScale)} ${mouthBaseY} 
                    Q ${windowCenter.x} ${mouthBaseY + (audioLevel * 120 * globalScale) + (10 * globalScale)} 
                    ${windowCenter.x + (35*globalScale)} ${mouthBaseY}`}
                fill="none"
                stroke="#22d3ee"
                strokeWidth={5 * globalScale}
                strokeLinecap="round"
                style={{ opacity: isSpeaking ? 0.9 : 0, transition: 'opacity 0.05s' }}
            />
          </>
        )}
      </svg>

      {hasCriticalError && (
        <div className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none">
             <div className="text-red-500 font-bold animate-pulse drop-shadow-[0_0_50px_rgba(239,68,68,0.8)]" style={{ fontSize: `${200 * globalScale}px` }}>
                !
             </div>
        </div>
      )}
    </div>
  );
};

export default DogFace;