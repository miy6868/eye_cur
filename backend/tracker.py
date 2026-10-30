"""CPU-only webcam inference. No image leaves this process."""
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[1]
from backend.camera import LatestCamera
from backend.gestures import EyeState, MouthState, mouth_ratio

# UniGaze는 ImageNet 사진의 채널별 평균·표준편차(RGB 순서)로 정규화한 얼굴로 학습했다
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def model_path():
    # 기본은 숫자를 8비트로 줄인 모델: 이 노트북에서 2배 빠르다(104→57ms).
    # 흔들림은 조금 커지지만 실제로 써 보니 크지 않았다. .env의 GAZE_INT8=0이면 원래 크기(fp32) 모델을 쓴다
    name = "unigaze_b16.onnx" if os.getenv("GAZE_INT8", "1") == "0" else "unigaze_b16_int8.onnx"
    return ROOT / "models" / name


def load_model():
    path = model_path()
    if not path.exists():
        raise RuntimeError("UniGaze 모델이 없습니다. scripts/download_models.py를 실행하세요.")
    options = ort.SessionOptions()
    # 모델 하나를 몇 개의 CPU 코어로 나눠 계산할지. 나머지 코어는 카메라·얼굴 점 찾기가 쓴다
    options.intra_op_num_threads = max(1, min(8, int(os.getenv("CPU_THREADS", "4"))))
    options.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])


def face_tensor(face):
    """정규화한 얼굴 이미지(BGR, 0~255, 224×224) → UniGaze 입력 (1, 3, 224, 224)."""
    rgb = face[:, :, ::-1].astype(np.float32) / 255  # OpenCV는 BGR로 읽지만 UniGaze는 RGB로 학습했다
    rgb = (rgb - IMAGENET_MEAN) / IMAGENET_STD
    # (높이, 너비, 채널) → (1장, 채널, 높이, 너비): 모델이 받는 순서
    return np.ascontiguousarray(rgb.transpose(2, 0, 1)[None])


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
    warp = normalized_camera @ scale @ transform @ np.linalg.inv(camera)
    # 정규화가 지우는 머리 정보: 고개 기울기(두 눈을 잇는 선의 각도)와 카메라까지 거리.
    # 시선 각도는 이 둘이 바뀌면 같은 화면 점을 봐도 달라지므로 따로 내보내 측정한다
    # 부호: 사용자 기준 오른쪽으로 고개를 기울이면 -
    head_x = rotation[:, 0]
    # 얼굴이 향하는 방향(얼굴 모델의 z축 반대). 끄덕임(pitch, + = 아래로 숙임)과 좌우 돌림(yaw)을 구한다
    face_dir = -rotation[:, 2]
    head = {"headRoll": round(float(np.degrees(np.arctan2(head_x[1], head_x[0]))), 1),
            "headDistance": round(float(distance)),
            "headPitch": round(float(np.degrees(np.arctan2(face_dir[1], -face_dir[2]))), 1),
            "headYaw": round(float(np.degrees(np.arctan2(face_dir[0], -face_dir[2]))), 1)}
    return warp, head


def normalize_face(frame, points, camera, distortion):
    warp, head = face_warp(points, camera, distortion)
    return cv2.warpPerspective(frame, warp, (224, 224)), head


def iris_offset(points):
    """홍채 중심이 두 눈 구석 사이 어디에 있는지 [가로, 세로] (눈 너비 단위, 두 눈 평균).
    시선 모델과 달리 눈 모양만 보는 기하 단서라, 두 값을 비교해 어느 쪽이 안정적인지 측정한다."""
    offsets = []
    for corners in ([33, 133], [362, 263]):
        a, b = points[corners]
        middle = (a + b) / 2
        width = max(np.linalg.norm(b - a), 1e-6)
        # 두 홍채 중심(468, 473) 중 이 눈에 가까운 것을 쓴다: 번호와 눈의 짝을 외우지 않아도 된다
        iris = min(points[[468, 473]], key=lambda p: np.linalg.norm(p - middle))
        axis = (b - a) / width
        d = (iris - middle) / width
        offsets.append([d @ axis, axis[0] * d[1] - axis[1] * d[0]])
    return [round(float(v), 4) for v in np.mean(offsets, axis=0)]


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
            max_num_faces=1, refine_landmarks=True,
            min_detection_confidence=0.6, min_tracking_confidence=0.6)
        self.eyes = EyeState()
        self.mouth = MouthState()
        self.gaze_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gaze-inference")
        self.gaze_future = None
        self.gaze_blocked_until = 0
        self.camera_config = None
        intrinsics = os.getenv("CAMERA_INTRINSICS")
        if intrinsics:
            self.camera_config = json.loads(Path(intrinsics).read_text(encoding="utf-8-sig"))
        try:
            self.cap = LatestCamera(int(os.getenv("CAMERA_INDEX", "0")))
        except Exception:
            self.close()
            raise

    def read(self):
        ok, frame, stamp = self.cap.read()
        if not ok:
            self.eyes.lost()
            self.mouth.lost()
            self.gaze_blocked_until = stamp + 250
            return {"type": "frame", "valid": False, "time": stamp, "mouthOpen": False, "mar": None,
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
            self.mouth.lost()
            self.gaze_blocked_until = stamp + 250
            return {"type": "frame", "valid": False, "time": stamp, "mouthOpen": False, "mar": None}
        points = np.array([[p.x * width, p.y * height]
                           for p in result.multi_face_landmarks[0].landmark])
        ratios = [eye_ratio(points, [33, 160, 158, 133, 153, 144]),
                  eye_ratio(points, [362, 385, 387, 263, 373, 380])]
        eyes = self.eyes.update(ratios)
        # 입 상태는 눈 상태 때문에 아래에서 일찍 return해도 항상 payload에 들어간다
        mouth = self.mouth.update(mouth_ratio(points))
        payload = {"type": "frame", "valid": True, "time": stamp, **eyes, **mouth,
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
                    payload.update(gaze=gaze, gazeTime=gaze_stamp, captureAgeMs=age, inferenceMs=duration,
                                   **self.gaze_head)
            except Exception:
                payload["gazeError"] = "시선 추론 실패 · 눈 상태 추적은 계속합니다."
            self.gaze_future = None
        if self.gaze_future or stamp < self.gaze_blocked_until:
            return payload
        try:
            face, self.gaze_head = normalize_face(frame, points, camera, np.zeros(5))
            # 홍채 점(468~477)은 refine_landmarks=True일 때만 있다
            if len(points) >= 478:
                self.gaze_head["iris"] = iris_offset(points)
            self.gaze_future = self.gaze_executor.submit(self.infer, face, stamp)
        except (ValueError, cv2.error):
            payload["gazeError"] = "얼굴 정규화가 불안정합니다. 얼굴 전체가 카메라에 보이도록 조정하세요."
        return payload

    def infer(self, face, stamp):
        started = time.perf_counter()
        pitch, yaw = self.model.run(None, {"face": face_tensor(face)})[0][0]
        if not np.isfinite([pitch, yaw]).all():
            raise ValueError("Non-finite gaze")
        # UniGaze는 [위아래(pitch), 좌우(yaw)] 라디안. 보정·기록은 예전 모델 때부터 [좌우, 위아래]로 써 왔으므로 바꿔 보낸다
        gaze = [float(yaw), float(pitch)]
        return gaze, stamp, round((time.perf_counter() - started) * 1000)

    def close(self):
        if hasattr(self, "cap"):
            self.cap.close()
        if hasattr(self, "mesh"):
            self.mesh.close()
        if hasattr(self, "gaze_executor"):
            self.gaze_executor.shutdown(wait=True, cancel_futures=True)
