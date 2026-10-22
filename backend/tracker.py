"""CPU-only webcam inference. No image leaves this process."""
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor"))
from model import Model  # noqa: E402
from backend.camera import LatestCamera
from backend.gestures import EyeState


def load_model():
    path = ROOT / "models/GazeTR-H-ETH.pt"
    if not path.exists():
        raise RuntimeError("GazeTR 가중치가 없습니다. scripts/download_models.py를 실행하세요.")
    torch.set_num_threads(max(1, min(8, int(os.getenv("CPU_THREADS", "2")))))
    model = Model().cpu().eval()
    state = torch.load(path, map_location="cpu", weights_only=True)
    for key in ("state_dict", "model_state_dict", "model"):
        if isinstance(state, dict) and key in state:
            state = state[key]
            break
    state = {k.removeprefix("module."): v for k, v in state.items()}
    model.load_state_dict(state, strict=True)
    return model


# ETH-XGaze face_model.txt rows [20, 23, 26, 29, 15, 19] (mm).
# Four eye corners + two NOSE corners, matching the training normalization.
# Source: https://github.com/xucong-zhang/ETH-XGaze/blob/master/demo.py
FACE_3D = np.array([
    [-46.509499, -38.327095, 36.416004], [-17.760721, -32.585197, 29.076157],
    [18.043911, -30.956823, 29.062967], [44.737587, -34.107872, 36.732437],
    [-10.611665, 12.958349, 21.622765], [11.289630, 13.864244, 21.837900],
], dtype=np.float64)
FACE_IDS = [33, 133, 362, 263, 98, 327]


def face_warp(points, camera, distortion):
    image_points = points[FACE_IDS].astype(np.float64)
    ok, rvec, tvec = cv2.solvePnP(FACE_3D, image_points, camera, distortion,
                                flags=cv2.SOLVEPNP_EPNP)
    if not ok:
        raise ValueError("Face pose unavailable")
    ok, rvec, tvec = cv2.solvePnP(FACE_3D, image_points, camera, distortion,
                                rvec, tvec, True, flags=cv2.SOLVEPNP_ITERATIVE)
    if not ok:
        raise ValueError("Face pose unavailable")
    projected, _ = cv2.projectPoints(FACE_3D, rvec, tvec, camera, distortion)
    error = np.sqrt(np.mean(np.sum((projected.reshape(-1, 2) - image_points) ** 2, axis=1)))
    eye_span = np.linalg.norm(image_points[0] - image_points[3])
    if eye_span < 30 or error > eye_span * 0.08:
        raise ValueError("Face landmarks do not fit the normalization template")
    rotation, _ = cv2.Rodrigues(rvec)
    face_camera = (rotation @ FACE_3D.T + tvec).T
    center = (face_camera[:4].mean(axis=0) + face_camera[4:].mean(axis=0)) / 2
    distance = np.linalg.norm(center)
    if not ok or distance < 100 or center[2] <= 0:
        raise ValueError("Invalid face pose")
    forward = center / distance
    down = np.cross(forward, rotation[:, 0])
    down /= max(np.linalg.norm(down), 1e-8)
    right = np.cross(down, forward)
    right /= max(np.linalg.norm(right), 1e-8)
    transform = np.stack([right, down, forward])
    scale = np.diag([1.0, 1.0, 600.0 / distance])
    normalized_camera = np.array([[960, 0, 112], [0, 960, 112], [0, 0, 1.]])
    return normalized_camera @ scale @ transform @ np.linalg.inv(camera)


def normalize_face(frame, points, camera, distortion):
    warp = face_warp(points, camera, distortion)
    return cv2.warpPerspective(frame, warp, (224, 224))


def eye_ratio(points, ids):
    p = points[ids]
    width = np.linalg.norm(p[0] - p[3])
    return float((np.linalg.norm(p[1] - p[5]) + np.linalg.norm(p[2] - p[4]))
                 / max(2 * width, 1e-6))


class Tracker:
    def __init__(self):
        cv2.setNumThreads(1)
        self.model = load_model()
        self.mesh = mp.solutions.face_mesh.FaceMesh(
            max_num_faces=1, refine_landmarks=False,
            min_detection_confidence=0.6, min_tracking_confidence=0.6)
        self.eyes = EyeState()
        self.gaze_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gaze-inference")
        self.gaze_future = None
        self.gaze_blocked_until = 0
        self.camera_config = None
        intrinsics = os.getenv("CAMERA_INTRINSICS")
        if intrinsics:
            self.camera_config = json.loads(Path(intrinsics).read_text())
        try:
            self.cap = LatestCamera(int(os.getenv("CAMERA_INDEX", "0")))
        except Exception:
            self.close()
            raise

    def read(self):
        ok, frame, stamp = self.cap.read()
        if not ok:
            self.eyes.lost()
            self.gaze_blocked_until = stamp + 250
            return {"type": "frame", "valid": False, "time": stamp,
                    "error": "카메라 프레임을 읽지 못했습니다."}
        height, width = frame.shape[:2]
        if self.camera_config:
            camera = np.array(self.camera_config["camera_matrix"], dtype=np.float64)
            distortion = np.array(self.camera_config["dist_coefficients"], dtype=np.float64)
            frame = cv2.undistort(frame, camera, distortion)
        else:
            # Approximation for a fixed-head MVP; never claimed as camera calibration.
            focal = float(max(width, height))
            camera = np.array([[focal, 0, width / 2], [0, focal, height / 2], [0, 0, 1.]])
        result = self.mesh.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        if not result.multi_face_landmarks:
            self.eyes.lost()
            self.gaze_blocked_until = stamp + 250
            return {"type": "frame", "valid": False, "time": stamp}
        points = np.array([[p.x * width, p.y * height]
                           for p in result.multi_face_landmarks[0].landmark])
        ratios = [eye_ratio(points, [33, 160, 158, 133, 153, 144]),
                  eye_ratio(points, [362, 385, 387, 263, 373, 380])]
        eyes = self.eyes.update(ratios)
        payload = {"type": "frame", "valid": True, "time": stamp, **eyes,
                   "ear": round(float(np.mean(ratios)), 3)}
        if eyes["closing"] or not eyes["eyesReady"]:
            self.gaze_blocked_until = stamp + 250
            return payload
        # Eye landmarks keep flowing while the CPU model works on another thread.
        if self.gaze_future and self.gaze_future.done():
            try:
                gaze, gaze_stamp, duration = self.gaze_future.result()
                age = round(time.monotonic() * 1000) - gaze_stamp
                if gaze_stamp >= self.gaze_blocked_until and age <= 500:
                    payload.update(gaze=gaze, gazeTime=gaze_stamp, captureAgeMs=age, inferenceMs=duration)
            except Exception:
                payload["gazeError"] = "시선 추론 실패 · 눈 상태 추적은 계속합니다."
            self.gaze_future = None
        if self.gaze_future or stamp < self.gaze_blocked_until:
            return payload
        try:
            face = normalize_face(frame, points, camera, np.zeros(5))
            self.gaze_future = self.gaze_executor.submit(self.infer, face, stamp)
        except (ValueError, cv2.error):
            payload["gazeError"] = "얼굴 정규화가 불안정합니다. 얼굴 전체가 카메라에 보이도록 조정하세요."
        return payload

    def infer(self, face, stamp):
        started = time.perf_counter()
        # Upstream reader uses BGR / [0, 1], with no ImageNet normalization.
        tensor = torch.from_numpy(face.transpose(2, 0, 1).copy()).float().div_(255).unsqueeze(0)
        with torch.inference_mode():
            gaze = self.model({"face": tensor}).squeeze(0).tolist()
        if not np.isfinite(gaze).all():
            raise ValueError("Non-finite gaze")
        return gaze, stamp, round((time.perf_counter() - started) * 1000)

    def close(self):
        if hasattr(self, "cap"):
            self.cap.close()
        if hasattr(self, "mesh"):
            self.mesh.close()
        if hasattr(self, "gaze_executor"):
            self.gaze_executor.shutdown(wait=True, cancel_futures=True)
