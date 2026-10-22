"""Continuously drain the camera so slow CPU inference cannot build a frame backlog."""
import threading
import time

import cv2


class LatestCamera:
    def __init__(self, index):
        self.cap = cv2.VideoCapture(index, cv2.CAP_DSHOW)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        if not self.cap.isOpened():
            self.cap.release()
            raise RuntimeError("웹캠을 열 수 없습니다. 카메라 권한과 CAMERA_INDEX를 확인하세요.")
        self.condition = threading.Condition()
        self.stopping = threading.Event()
        self.latest = None
        self.sequence = 0
        self.consumed = 0
        self.thread = threading.Thread(target=self._capture, daemon=True, name="latest-camera")
        self.thread.start()

    def _capture(self):
        try:
            while not self.stopping.is_set():
                ok, frame = self.cap.read()
                with self.condition:
                    self.latest = (ok, frame, round(time.monotonic() * 1000))
                    self.sequence += 1
                    self.condition.notify_all()
                if not ok:
                    self.stopping.wait(0.1)
        finally:
            self.cap.release()
            with self.condition:
                self.condition.notify_all()

    def read(self):
        with self.condition:
            ready = self.condition.wait_for(
                lambda: self.sequence > self.consumed or self.stopping.is_set(), timeout=2)
            if not ready or self.stopping.is_set():
                return False, None, round(time.monotonic() * 1000)
            self.consumed = self.sequence
            return self.latest

    def close(self):
        self.stopping.set()
        with self.condition:
            self.condition.notify_all()
        self.thread.join(timeout=3)
