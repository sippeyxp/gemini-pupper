import sys
import os
import sys
import time
import subprocess
import glob
import signal
import shutil
import datetime
import logging
import psutil
import asyncio
import re
import socket
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager


import uvicorn
from typing import List

from fastapi import FastAPI, File, UploadFile, HTTPException, WebSocket, WebSocketDisconnect, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv


# Load environment variables before importing RosToolServer
load_dotenv(".env.local")

# Assumed to be available in the environment
from ros_tool_server import RosToolServer

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pupster_api")

# Animation name mapping with descriptions
ANIMATION_NAMES = {
    "twerk": {
        "csv_name": "twerk_recording_2025-09-04_16-14-51_0",
        "description": "Makes the robot twerk by moving its hips in a rhythmic motion",
    },
    "lie_sit_lie": {
        "csv_name": "lie_sit_lie_recording_2025-09-03_12-44-08_0",
        "description": "From lying position, sits up and then lies back down",
    },
    "stand_sit_shake_sit_stand": {
        "csv_name": "stand_sit_shake_sit_stand_recording_2025-09-03_12-47-18_0",
        "description": "From standing, sits down, shakes body, sits, then stands back up",
    },
    "upward_dog": {
        "csv_name": "upward_dog_recording_2025-10-22_17-17-07",
        "description": "From lying position, moves into an upward dog yoga pose and back down to lying",
    },
    "stand_sit_stand": {
        "csv_name": "stand_sit_stand_recording_2025-09-03_12-46-36_0",
        "description": "From standing position, sits down and then stands back up",
    },
    "superman": {
        "csv_name": "superman_recording_2025-10-22_17-47-41",
        "description": "From lying position, lifts arms and legs off the ground to mimic flying like Superman",
    },
    "pee": {
        "csv_name": "pee2_recording_2025-10-22_17-41-45",
        "description": "From standing position, lifts leg and mimics urination motion",
    },
    "lie_downward_dog": {
        "csv_name": "lie_downward_dog_recording_2025-09-04_16-08-00_0",
        "description": "From lying position, moves into a downward dog yoga pose",
    },
    "stand_downward_dog": {
        "csv_name": "stand_downward_dog_recording_2025-09-04_16-09-51_0",
        "description": "From standing position, moves into a downward dog yoga pose",
    },
    "push_up": {
        "csv_name": "push_up_recording_2025-09-04_16-11-34_0",
        "description": "From standing position, performs a push-up motion by lowering and raising the body",
    },
    "sneeze": {
        "csv_name": "sneeze_recording_2025-09-04_16-13-54_0",
        "description": "From standing position, mimics a sneezing motion with head and body movement",
    },
    "spider": {
        "csv_name": "spider_recording_2025-09-04_16-12-38_0",
        "description": "From lying position, moves legs in a silly spider-like motion",
    },
    "swim": {
        "csv_name": "swim_recording_2025-09-04_16-10-45_0",
        "description": "From lying position, performs silly swimming motions with the legs",
    },
}

# Animation playback frame rate constant (Hz)
ANIMATION_FRAME_RATE = 40.0
FADE_IN_DURATION = 1.0


def get_animation_duration(csv_filename: str) -> float:
    """Calculate animation duration from CSV file based on frame count."""
    base_path = (
        Path(__file__).parent.parent.parent.parent.parent
        / "ros2_ws"
        / "src"
        / "animation_controller_py"
        / "launch"
        / "animations"
    )
    csv_path = base_path / f"{csv_filename}.csv"

    try:
        with open(csv_path, "r") as f:
            # Count rows excluding header
            row_count = sum(1 for _ in f) - 1
            if row_count <= 0:
                raise ValueError(f"Animation CSV {csv_filename} is empty or has no data rows.")

            duration = row_count / ANIMATION_FRAME_RATE + FADE_IN_DURATION
            logger.info(
                f"Animation {csv_filename} duration: {duration:.2f} seconds ({row_count} frames at {ANIMATION_FRAME_RATE} Hz)"
            )
            return duration

    except Exception as e:
        logger.warning(f"Could not calculate duration for animation {csv_filename}: {e}")
        return 0.1


def load_system_prompt():
    """Load system prompt from file with robust error handling."""
    path = Path(__file__).parent / "system_prompt.md"
    try:
        with open(path, "r", encoding="utf-8") as f:
            prompt = f.read().strip()
            logger.info(f"Successfully loaded system prompt from {path}")
            return prompt
    except Exception as e:
        logger.error(f"Failed to load prompt from {path}: {e}")
        return "You are Pupster."


# --- Pydantic Models for API Requests ---

class MoveDirectionRequest(BaseModel):
    heading: float = Field(..., description="Direction in degrees. 0 is forward, 90 right.")
    speed: float = Field(..., description="Speed in m/s (0.3 - 0.75).")
    duration: float = Field(..., description="Duration in seconds.")

class MoveVelocityRequest(BaseModel):
    forward_backward_velocity: float = Field(..., description="Velocity forward/backward (m/s).")
    right_left_velocity: float = Field(..., description="Velocity right/left (m/s).")
    turning_velocity: float = Field(..., description="Angular velocity (deg/s).")
    duration: float = Field(..., description="Duration in seconds.")

class AnimationRequest(BaseModel):
    animation_name: str = Field(..., description=f"Available: {', '.join(ANIMATION_NAMES.keys())}")

class WaitRequest(BaseModel):
    duration: float

class VolumeRequest(BaseModel):
    volume: int = Field(..., ge=0, le=150, description="Volume level 0-150")

class AnalyzeImageRequest(BaseModel):
    prompt: str = Field(..., description="Prompt for image analysis")


# --- Pupster Agent Logic ---

class PupsterAgent:
    def __init__(self, tool_impl) -> None:
        self.tool_impl = tool_impl
        self.system_prompt = load_system_prompt()
        self._init_touch_file()

    def _init_touch_file(self):
        # Write an empty file to /tmp to signal start
        tmp_file_path = Path("/tmp/pupster_agent_started")
        try:
            tmp_file_path.touch()
            logger.info(f"Created empty file at {tmp_file_path}")
        except Exception as e:
            logger.error(f"Failed to create empty file at {tmp_file_path}: {e}")

    async def queue_activate_walking(self):
        logger.info("CALL: queue_activate_walking()")
        return await self.tool_impl.queue_activate_walking()

    async def queue_deactivate(self):
        logger.info("CALL: queue_deactivate()")
        return await self.tool_impl.queue_deactivate()

    async def queue_move_in_direction(self, heading: float, speed: float, duration: float):
        logger.info(f"CALL: queue_move_in_direction(heading={heading}, speed={speed}, duration={duration})")
        turn_velocity = 90.0
        wz = -turn_velocity * (1 if heading > 0 else -1)
        turn_duration = abs(heading / turn_velocity)
        await self.tool_impl.queue_move_for_time(vx=0.0, vy=0.0, wz=wz, duration=turn_duration)
        await self.tool_impl.queue_move_for_time(vx=speed, vy=0.0, wz=0.0, duration=duration)
        return {"status": "queued", "action": "move_in_direction"}

    async def queue_move(
        self,
        forward_backward_velocity: float,
        right_left_velocity: float,
        turning_velocity: float,
        duration: float,
    ):
        logger.info(
            f"CALL: queue_move(vx={forward_backward_velocity}, vy={right_left_velocity}, wz={turning_velocity}, duration={duration})"
        )
        return await self.tool_impl.queue_move_for_time(
            vx=forward_backward_velocity, vy=-right_left_velocity, wz=-turning_velocity, duration=duration
        )

    async def queue_stop(self):
        logger.info("CALL: queue_stop()")
        return await self.tool_impl.queue_stop()

    async def queue_wait(self, duration: float):
        logger.info(f"CALL: Waiting for {duration} seconds")
        return await self.tool_impl.queue_wait(duration)

    async def queue_animation(self, animation_name: str):
        logger.info(f"CALL: queue_animation(animation_name={animation_name})")

        if animation_name not in ANIMATION_NAMES:
            raise ValueError(f"Unknown animation '{animation_name}'. Available: {list(ANIMATION_NAMES.keys())}")

        actual_animation_name = ANIMATION_NAMES[animation_name]["csv_name"]

        # Queue the animation
        result = await self.tool_impl.queue_animation(actual_animation_name)

        # Calculate duration and queue wait
        duration = get_animation_duration(actual_animation_name)
        logger.info(f"Queueing wait for {duration:.2f} seconds for animation {animation_name}")
        await self.tool_impl.queue_wait(duration)

        return result

    async def reset_command_queue(self):
        logger.info(f"CALL: reset_command_queue()")
        return await self.tool_impl.clear_queue()

    async def immediate_stop(self):
        logger.info(f"CALL: immediate_stop()")
        return await self.tool_impl.immediate_stop()

    async def analyze_camera_image(self, prompt: str):
        logger.info(f"CALL: analyze_camera_image(prompt={prompt})")
        # Passing context=None as we are not using LiveKit run context anymore
        return await self.tool_impl.analyze_camera_image(prompt, None)

    async def activate_person_following(self):
        return await self.tool_impl.activate_person_following()

    async def deactivate_person_following(self):
        return await self.tool_impl.deactivate_person_following()

    async def set_speaker_volume(self, volume: int):
        logger.info(f"CALL: set_speaker_volume({volume})")
        try:
            # Convert volume (0-150) to level (0.0-1.5)
            level = max(0.0, min(volume / 150 * 1.5, 1.5))
            logger.info(f"Setting speaker volume to {level} (input volume {volume})")
            subprocess.run(["wpctl", "set-volume", "@DEFAULT_SINK@", str(level)], check=True)
            return {"status": "success", "message": f"Speaker volume set to {volume}%."}
        except Exception as e:
            logger.error(f"Failed to set speaker volume: {e}")
            return {"status": "error", "message": str(e)}

    async def check_mode(self):
        return await self.tool_impl.check_mode()


# --- ZMQ / WebSocket Broadcast ---

# Try importing zmq
try:
    import zmq
    import zmq.asyncio
    HAS_ZMQ = True
    zmq_context = zmq.asyncio.Context()
except ImportError:
    HAS_ZMQ = False
    logger.warning("pyzmq not installed. ZMQ tracking disabled.")

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def broadcast(self, message: str):
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except:
                pass # Disconnected handling

manager = ConnectionManager()

# Background task to read ZMQ
async def zmq_reader_task():
    if not HAS_ZMQ:
        return
    
    logger.info("ZMQ Reader: Connecting to tcp://127.0.0.1:5556")
    sock = zmq_context.socket(zmq.SUB)
    try:
        sock.connect("tcp://127.0.0.1:5556")
        sock.subscribe(b"") # Subscribe all
        
        while True:
            # Poll with timeout to allow graceful shutdown check if needed
            if await sock.poll(100):
                msg = await sock.recv_multipart()
                # msg format typically [topic, payload] or just [payload]
                if len(msg) > 0:
                    payload = msg[-1].decode('utf-8', errors='ignore')
                    # Validation: check if it looks like JSON
                    if payload.startswith('{'):
                         await manager.broadcast(payload)
            else:
                await asyncio.sleep(0.01)
    except Exception as e:
        logger.error(f"ZMQ Error: {e}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Lifespan context manager to handle startup and shutdown events.
    Initializes RosToolServer inside the running event loop to avoid asyncio errors.
    """
    global agent
    logger.info("Initializing RosToolServer...")
    try:
        # Initialize RosToolServer here, where the event loop is guaranteed to be running
        tool_impl = RosToolServer()
        agent = PupsterAgent(tool_impl)
        logger.info("PupsterAgent initialized successfully.")
    except Exception as e:
        logger.error(f"Failed to initialize RosToolServer or Agent: {e}", exc_info=True)
        # We don't raise here to allow the server to start, though endpoints will return 503
    
    if HAS_ZMQ:
        asyncio.create_task(zmq_reader_task())
    
    yield
    
    # Clean up resources on shutdown if necessary
    logger.info("Shutting down Pupster API")

app = FastAPI(
    title="Pupster Control API", 
    description="Web interface for Pupster robot control",
    lifespan=lifespan
)

# --- Add CORS Middleware ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.websocket("/ws/detections")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # Keep alive
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)


def get_agent():
    if not agent:
        raise HTTPException(status_code=503, detail="PupsterAgent not initialized (RosToolServer failed)")
    return agent


# --- Inspect / Update / Shutdown ---

@app.get("/")
def health_check():
    return {"status": "running", "worker": True, "version": os.path.getmtime(__file__)}
    
@app.get("/local_server.py.txt")
def get_source():
    with open(__file__, 'r') as f:
        return f.read()

@app.post("/upgrade")
async def upgrade_server(file: UploadFile = File(...)):
    try:
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"/tmp/new_server_{timestamp}.py"
        content = await file.read()
        with open(filename, "wb") as f:
            f.write(content)
        logger.info(f"Upgrade: Saved new version to {filename}")
        return {"status": "success", "file": filename, "message": "Restart supervisor to apply."}
    except Exception as e:
        logger.error(f"Upgrade failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/restart")
async def restart():
    # unicorn will restart
    sys.exit(100)


# --- system status ---

@app.get("/system/status")
def get_system_status():
    battery_percent = None
    voltage = None
    
    # Try to execute the physical battery script
    script_path = os.path.expanduser("/home/pi/pupperv3-monorepo/robot/utils/check_batt_voltage.py")
    if os.path.exists(script_path):
        try:
            # Percentage
            p = subprocess.run(["python3", script_path, "--percentage_only"], capture_output=True, text=True, timeout=1)
            if p.returncode == 0:
                try:
                    battery_percent = float(p.stdout.strip())
                except ValueError:
                    pass
            
            # Voltage
            # Attempt to get voltage by running without args and parsing float
            v = subprocess.run(["python3", script_path], capture_output=True, text=True, timeout=1)
            if v.returncode == 0:
                # Find voltage ending in V (e.g. 17.16V)
                match = re.search(r"(\d+(?:\.\d+)?)V", v.stdout)
                if match:
                    voltage = float(match.group(1))
        except Exception as e:
            logger.error(f"Battery script error: {e}")

    try:
        is_charging = False # Charging detection requires hardware flag not present in simple script
        cpu_usage = psutil.cpu_percent()
        try:
            temps = psutil.sensors_temperatures()
            cpu_temp = temps['cpu_thermal'][0].current if 'cpu_thermal' in temps else 45.0
        except:
            cpu_temp = 45.0
            
        # Check robot service status using systemctl
        robot_status = "unknown"
        try:
            res = subprocess.run(["systemctl", "is-active", "robot"], capture_output=True, text=True, timeout=1)
            robot_status = "active" if res.stdout.strip() == "active" else "inactive"
        except Exception:
            pass

        # Check internet connectivity (1.1.1.1:53)
        internet_status = "unknown"
        try:
            socket.setdefaulttimeout(1)
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.connect(("1.1.1.1", 53))
            s.close()
            internet_status = "online"
        except Exception:
            internet_status = "offline"

        return {
            "battery": {
                "percentage": battery_percent,
                "is_charging": is_charging,
                "voltage": voltage
            },
            "cpu": {
                "usage": cpu_usage,
                "temperature": cpu_temp
            },
            "services": {
                "robot": robot_status,
                "internet": internet_status
            }
        }
    except Exception as e:
        logger.error(f"Status error: {e}")
        return {"error": str(e)}


@app.get("/camera/image")
def get_camera_image():
    try:
        # Access the ROS image queue safely
        img_msg = get_agent().tool_impl.latest_image_queue.get_nowait()
        # Assume .data is the raw bytes of the JPEG
        return Response(content=img_msg.data.tobytes(), media_type="image/jpeg")
    except Exception as e:
        # If queue empty or other error, return 404 or empty
        return Response(status_code=500, message=str(e))


# --- Walking & Movement Endpoints ---

@app.post("/walking/activate")
async def activate_walking():
    return await get_agent().queue_activate_walking()

@app.post("/walking/deactivate")
async def deactivate_walking():
    return await get_agent().queue_deactivate()

@app.post("/move/direction")
async def move_direction(req: MoveDirectionRequest):
    await get_agent().queue_move_in_direction(req.heading, req.speed, req.duration)
    return {"status": "queued"}

@app.post("/move/velocity")
async def move_velocity(req: MoveVelocityRequest):
    return await get_agent().queue_move(
        req.forward_backward_velocity,
        req.right_left_velocity,
        req.turning_velocity,
        req.duration
    )

@app.post("/queue/stop")
async def queue_stop():
    return await get_agent().queue_stop()

@app.post("/queue/wait")
async def queue_wait(req: WaitRequest):
    return await get_agent().queue_wait(req.duration)

@app.post("/queue/reset")
async def reset_queue():
    return await get_agent().reset_command_queue()

@app.post("/stop/immediate")
async def immediate_stop():
    return await get_agent().immediate_stop()

# --- Animation Endpoints ---

@app.post("/animation")
async def play_animation(req: AnimationRequest):
    try:
        return await get_agent().queue_animation(req.animation_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/animations")
async def list_animations():
    return ANIMATION_NAMES

# --- Behavior & System Endpoints ---

@app.post("/following/activate")
async def activate_following():
    return await get_agent().activate_person_following()

@app.post("/following/deactivate")
async def deactivate_following():
    return await get_agent().deactivate_person_following()

@app.post("/camera/analyze")
async def analyze_camera(req: AnalyzeImageRequest):
    return await get_agent().analyze_camera_image(req.prompt)

@app.post("/system/volume")
async def set_volume(req: VolumeRequest):
    return await get_agent().set_speaker_volume(req.volume)

@app.get("/system/mode")
async def check_mode():
    return await get_agent().check_mode()

if __name__ == "__main__":
    import uvicorn

    # When running directly, uvicorn manages the event loop
    uvicorn.run(app, host="0.0.0.0", port=8000)
#                ssl_keyfile="localhost+2-key.pem",
#                ssl_certfile="localhost+2.pem")