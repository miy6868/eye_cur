import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import torch
from backend.tracker import Tracker


class AsyncTrackerTests(unittest.TestCase):
    def test_slow_gaze_model_does_not_block_eye_closure_frames(self):
        started, release = threading.Event(), threading.Event()
        class Camera:
            def __init__(self, index): self.stamp = round(time.monotonic() * 1000)
            def read(self):
                self.stamp += 50
                return True, np.zeros((480, 640, 3), dtype=np.uint8), self.stamp
            def close(self): pass
        class Mesh:
            def process(self, image):
                return SimpleNamespace(multi_face_landmarks=[SimpleNamespace(landmark=[SimpleNamespace(x=.5, y=.5)] * 468)])
            def close(self): pass
        class Model:
            def __call__(self, inputs):
                started.set(); release.wait(3)
                return torch.zeros(1, 2)
        tracker = None
        try:
            with patch('backend.tracker.load_model', return_value=Model()), patch('backend.tracker.LatestCamera', Camera), \
                 patch('backend.tracker.mp.solutions.face_mesh.FaceMesh', return_value=Mesh()), \
                 patch('backend.tracker.normalize_face', return_value=(np.zeros((224, 224, 3), dtype=np.uint8), {})), \
                 patch('backend.tracker.eye_ratio', return_value=.3) as ratio:
                tracker = Tracker()
                for _ in range(25): tracker.read()
                self.assertTrue(started.wait(1))
                self.assertFalse(tracker.gaze_future.done())
                ratio.return_value = .23
                self.assertTrue(tracker.read()['closing'])
                ratio.return_value = .12
                frame = tracker.read()
                self.assertTrue(frame['closed'])
                self.assertNotIn('gaze', frame)
                self.assertFalse(tracker.gaze_future.done())
        finally:
            release.set()
            if tracker: tracker.close()
