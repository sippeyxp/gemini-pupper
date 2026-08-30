
import { AppConfig } from './types';

export const DEFAULT_CONFIG: AppConfig = {
  modelName: 'gemini-3.1-flash-live-preview',
  ttsModelName: 'gemini-3.1-flash-tts-preview',
  voiceName: 'Puck',
  systemInstruction: 'You have an energetic, doggish, cute, childish voice, and speaking not very clearly. Normally you have conversations as if you are a 5 year old. Simple and short sentence and a bit emotional. You are Pupster, a physical robot dog. You love to explore, follow people, and perform tricks. When make a motion, you must to use function calls to make it happen first, then narrate. You have visited hawaii recently after gemini 3 launch. You have done snorkeling there.',
  enableVideo: true,
  enableAudio: true,
  robotApiUrl: 'http://localhost:8000',
  eyeTrackingSource: 'server',
  cameraSource: 'browser',
  enableAffectiveDialog: true,
  enableProactiveAudio: true,
};

// Animation mapping from the user request
export const ANIMATION_NAMES = [
  { id: 'twerk', label: 'Twerk', description: 'Rhythmic hip motion, dancing' },
  { id: 'lie_sit_lie', label: 'Lie-Sit-Lie', description: 'Sit up and lie down, relax' },
  { id: 'stand_sit_shake_sit_stand', label: 'Shake Sequence', description: 'Sit, shake hands or paw, then stand' },
  { id: 'upward_dog', label: 'Upward Dog', description: 'Yoga pose, stretching up' },
  { id: 'superman', label: 'Superman', description: 'Flying pose, stretching out' },
  { id: 'pee', label: 'Pee', description: 'Lift leg, mark territory' },
  { id: 'lie_downward_dog', label: 'Downward Dog', description: 'Yoga pose, stretching down' },
  { id: 'sneeze', label: 'Sneeze', description: 'Sneeze motion, head shake' },
  { id: 'spider', label: 'Spider', description: 'Silly spider legs, wide stance' },
  { id: 'swim', label: 'Swim', description: 'Swimming motion, paddling' },
  { id: 'wave', label: 'Wave', description: 'Wave paw, say hello' },
  { id: 'jump', label: 'Jump', description: 'Excited jump, hop' },
];

export const MODEL_OPTIONS = [
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-preview-12-2025',
  'gemini-robotics-er-2-streaming-preview',
];

export const TTS_MODEL_OPTIONS = [
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-flash-preview-tts',
];

export const VOICE_OPTIONS = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'];
