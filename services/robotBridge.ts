import { MoveCommand, SystemStatus } from "../types";

// This service talks to the Python FastAPI backend running on the robot
class RobotBridge {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async request(endpoint: string, method: 'GET' | 'POST', body?: any, returnBlob: boolean = false) {
    try {
      const options: RequestInit = {
        method,
        headers: body && method === 'POST' ? { 'Content-Type': 'application/json' } : {},
      };

      if (body && method === 'POST') {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(`${this.baseUrl}${endpoint}`, options);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      if (returnBlob) {
        return await response.blob();
      }
      return await response.json();
    } catch (e) {
      // Suppress log spam for polling
      if(endpoint !== '/system/status' && endpoint !== '/camera/image') {
         console.error(`[RobotBridge] Error calling ${endpoint}`, e);
      }
      return { success: false, error: e };
    }
  }

  async getSystemStatus(): Promise<SystemStatus | null> {
    const res = await this.request('/system/status', 'GET');
    if (res && !res.error) {
      console.log("Returned value from /system/status is", JSON.stringify(res, null, 2));
      return res as SystemStatus;
    }
    return null;
  }
  
  async getCameraImage(): Promise<Blob | null> {
      try {
          const blob = await this.request('/camera/image', 'GET', undefined, true);
          if (blob instanceof Blob) {
              return blob;
          }
      } catch (e) {}
      return null;
  }

  async queueActivateWalking() {
    return this.request('/walking/activate', 'POST');
  }

  async queueDeactivate() {
    return this.request('/walking/deactivate', 'POST');
  }

  async queueMove(cmd: MoveCommand) {
    // Map internal MoveCommand to API MoveVelocityRequest
    const body = {
      forward_backward_velocity: cmd.vx,
      right_left_velocity: cmd.vy,
      turning_velocity: cmd.wz,
      duration: cmd.duration
    };
    return this.request('/move/velocity', 'POST', body);
  }

  async moveDirection(heading: number, speed: number, duration: number) {
    return this.request('/move/direction', 'POST', { heading, speed, duration });
  }

  async queueStop() {
    return this.request('/queue/stop', 'POST');
  }

  async queueWait(duration: number) {
    return this.request('/queue/wait', 'POST', { duration });
  }

  async queueReset() {
    return this.request('/queue/reset', 'POST');
  }

  async immediateStop() {
    return this.request('/stop/immediate', 'POST');
  }

  async queueAnimation(name: string) {
    return this.request('/animation', 'POST', { animation_name: name });
  }

  async getAnimations() {
    return this.request('/animations', 'GET');
  }

  async setVolume(volume: number) {
    return this.request('/system/volume', 'POST', { volume });
  }

  async checkMode() {
    return this.request('/system/mode', 'GET');
  }

  async setFollowMode(enabled: boolean) {
    const endpoint = enabled ? '/following/activate' : '/following/deactivate';
    return this.request(endpoint, 'POST');
  }

  async analyzeCamera(prompt: string) {
    return this.request('/camera/analyze', 'POST', { prompt });
  }
}

export default RobotBridge;