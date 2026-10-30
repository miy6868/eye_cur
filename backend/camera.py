"""Continuously drain the camera so slow CPU inference cannot build a frame backlog."""
import os
import sys
import threading
import time
from pathlib import Path

import cv2

MAX_CAMERAS = 6  # 0~5번까지만 찾아본다. 학교 PC·노트북에 이보다 많은 카메라는 거의 없다


def open_capture(index):
    # Windows는 DirectShow, Linux는 V4L2로 열어야 카메라가 빠르게 잡힌다
    api = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_V4L2
    cap = cv2.VideoCapture(index, api)
    if not cap.isOpened():
        # 드라이버에 따라 이 방식으로 안 열리는 카메라가 있어 OpenCV 기본 방식으로 한 번 더 연다
        cap.release()
        cap = cv2.VideoCapture(index)
    return cap


def camera_name(index):
    # Linux는 장치 이름을 파일로 읽을 수 있다. Windows는 OpenCV가 이름을 주지 않아 번호만 보여 준다
    path = Path(f"/sys/class/video4linux/video{index}/name")
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    return f"카메라 {index}"


def find_cameras():
    # 없는 번호를 열 때 OpenCV가 경고를 쏟아내므로 찾는 동안만 조용히 시킨다
    level = cv2.getLogLevel()
    cv2.setLogLevel(0)  # 0 = 아무것도 출력하지 않음
    found = []
    try:
        for index in range(MAX_CAMERAS):
            cap = open_capture(index)
            # 열리기만 하고 영상이 안 나오는 장치(Linux 메타데이터 장치 등)는 빼려고 한 장 읽어 본다
            if cap.isOpened() and cap.read()[0]:
                found.append(index)
            cap.release()
    finally:
        cv2.setLogLevel(level)
    return found


def pick_camera(found, default, ask=input):
    """찾은 카메라 번호 목록에서 쓸 번호를 고른다. 여러 대일 때만 사용자에게 묻는다."""
    if not found:
        return default  # 하나도 못 찾으면 원래 번호로 열어 보고, 실패하면 Tracker가 안내한다
    if len(found) == 1:
        return found[0]  # 한 대뿐이면 .env 번호가 틀려도 그 카메라를 쓴다
    if default not in found:
        default = found[0]
    print("\n카메라가 여러 대 있습니다:")
    for index in found:
        print(f"  {index}: {camera_name(index)}")
    while True:
        try:
            answer = ask(f"사용할 카메라 번호 (Enter = {default}): ").strip()
        except EOFError:
            return default  # 입력을 받을 수 없는 창(자동 실행)에서는 기본값으로 진행한다
        if answer == "":
            return default
        if answer.isdigit() and int(answer) in found:
            return int(answer)
        print("목록에 있는 번호를 입력하세요.")


def choose_camera():
    # 서버 시작 때 한 번 고르고, Tracker가 읽는 CAMERA_INDEX에 넣어 둔다
    default = int(os.getenv("CAMERA_INDEX", "0"))
    index = pick_camera(find_cameras(), default)
    os.environ["CAMERA_INDEX"] = str(index)
    print(f"카메라 {index}번 사용: {camera_name(index)}")


class LatestCamera:
    def __init__(self, index):
        self.cap = open_capture(index)
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
