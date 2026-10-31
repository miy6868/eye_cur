"""Load the real UniGaze model and benchmark CPU inference without opening the webcam."""
import os
import sys
import time
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
os.environ.setdefault("MPLCONFIGDIR", str(root / ".cache/matplotlib"))
import mediapipe as mp
import numpy as np
# 서버와 같은 설정(config.toml의 gaze_int8, cpu_threads)으로 잰다
from backend import tracker
from backend.config import CONFIG

# 얼굴 점 모델 파일을 실제로 열어 본다: Windows에서 경로에 한글이 있으면 여기서 실패한다
mp.solutions.face_mesh.FaceMesh(max_num_faces=1).close()
print("MediaPipe FaceMesh: OK")
face = tracker.face_tensor(np.zeros((224, 224, 3), dtype=np.uint8))
print("Model:", tracker.model_path().name)
setting = CONFIG["cpu_threads"]
# 비교용 4개와, 서버가 실제로 쓸 스레드 수(config.toml의 cpu_threads, 0이면 자동)를 잰다
for threads in sorted({4, tracker.thread_count()}):
    CONFIG["cpu_threads"] = threads
    model = tracker.load_model()
    model.run(None, {"face": face})
    started = time.perf_counter()
    for _ in range(10):
        output = model.run(None, {"face": face})[0]
    print(f"threads={threads}, mean_ms={(time.perf_counter() - started) * 100:.1f}")
CONFIG["cpu_threads"] = setting
print("Server threads:", tracker.thread_count())
assert output.shape == (1, 2) and np.isfinite(output).all()
print("PASS: real model loaded, finite CPU output; not an accuracy test.")
