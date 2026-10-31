"""Bounded camera smoke test. Frames are processed in memory, never saved."""
import os
import sys
import time
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
os.environ.setdefault('MPLCONFIGDIR', str(root / '.cache/matplotlib'))
from backend.tracker import Tracker

tracker = None
try:
    tracker = Tracker()
    frames = []
    start = time.perf_counter()
    for _ in range(60):
        frames.append(tracker.read())
    elapsed = time.perf_counter() - start
    print({'frames': len(frames), 'face_frames': sum(f['valid'] for f in frames),
           'eye_ready_frames': sum(f.get('eyesReady', False) for f in frames),
           'gaze_frames': sum('gaze' in f for f in frames), 'elapsed_seconds': round(elapsed, 2),
           'camera_error': next((f.get('error') for f in frames if f.get('error')), None)})
finally:
    if tracker:
        tracker.close()
