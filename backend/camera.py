"""Continuously drain the camera so slow CPU inference cannot build a frame backlog."""
import functools
import sys
import threading
import time
from collections import deque
from pathlib import Path

import cv2

from backend.config import CONFIG

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


@functools.cache
def windows_camera_names():
    """DirectShow 영상 입력 장치 이름을 OpenCV DSHOW 번호 순서대로 돌려준다(실패하면 빈 목록).

    OpenCV는 이름을 주지 않는다. OpenCV DSHOW도 같은 장치 목록을 같은 순서로 세므로 목록 순서가 곧 카메라 번호다.
    새 패키지를 늘리지 않으려고 COM 인터페이스를 ctypes로 직접 부른다(가상 함수 표의 번호로 호출).
    """
    import ctypes
    from ctypes import POINTER, byref, c_long, c_ulong, c_ushort, c_void_p, c_wchar_p

    class GUID(ctypes.Structure):
        _fields_ = [("data1", c_ulong), ("data2", c_ushort), ("data3", c_ushort), ("data4", ctypes.c_ubyte * 8)]

    class VARIANT(ctypes.Structure):
        # vt + 예약 3칸 뒤에 값. 64비트 24바이트, 32비트 16바이트가 되도록 포인터 두 칸을 둔다
        _fields_ = [("vt", c_ushort), ("r1", c_ushort), ("r2", c_ushort), ("r3", c_ushort),
                    ("value", c_void_p), ("extra", c_void_p)]

    ole32, oleaut32 = ctypes.oledll.ole32, ctypes.windll.oleaut32

    def guid(text):
        value = GUID()
        ole32.CLSIDFromString(c_wchar_p(text), byref(value))
        return value

    def call(obj, slot, *args):
        # obj의 가상 함수 표 slot번 함수를 부른다. 결과는 HRESULT(0 = 성공, 1 = S_FALSE, 음수 = 실패)
        table = ctypes.cast(obj, POINTER(POINTER(c_void_p))).contents
        function = ctypes.WINFUNCTYPE(c_long, c_void_p, *[type(a) for a in args])(table[slot])
        return function(obj, *args)

    def release(obj):
        if obj:
            call(obj, 2)  # IUnknown::Release

    names = []
    initialized = ctypes.windll.ole32.CoInitializeEx(None, 2) >= 0  # 2 = 아파트 스레드. 이미 다른 방식이면 그대로 쓴다
    devices = c_void_p()
    monikers = c_void_p()
    try:
        ole32.CoCreateInstance(byref(guid("{62BE5D10-60EB-11D0-BD3B-00A0C911CE86}")),  # SystemDeviceEnum
                               None, 1, byref(guid("{29840822-5B84-11D0-BD3B-00A0C911CE86}")),  # ICreateDevEnum
                               byref(devices))
        # ICreateDevEnum::CreateClassEnumerator(VideoInputDeviceCategory). 장치가 없으면 S_FALSE와 빈 포인터
        call(devices, 3, ctypes.pointer(guid("{860BB310-5D01-11D0-BD3B-00A0C911CE86}")), ctypes.pointer(monikers),
             c_ulong(0))
        property_bag = guid("{55272A00-42CB-11CE-8135-00AA004BB851}")  # IPropertyBag
        while monikers:
            moniker = c_void_p()
            fetched = c_ulong()
            if call(monikers, 3, c_ulong(1), ctypes.pointer(moniker), ctypes.pointer(fetched)) != 0 or not fetched.value:
                break  # IEnumMoniker::Next 끝
            bag = c_void_p()
            name = None
            try:
                # IMoniker::BindToStorage(9번) → IPropertyBag::Read(3번) "FriendlyName"
                if call(moniker, 9, c_void_p(), c_void_p(), ctypes.pointer(property_bag), ctypes.pointer(bag)) == 0:
                    variant = VARIANT()
                    if call(bag, 3, c_wchar_p("FriendlyName"), ctypes.pointer(variant), c_void_p()) == 0:
                        if variant.vt == 8 and variant.value:  # 8 = VT_BSTR
                            name = ctypes.wstring_at(variant.value)
                        oleaut32.VariantClear(byref(variant))
            finally:
                release(bag)
                release(moniker)
            names.append(name)  # 이름을 못 읽어도 자리는 채워야 뒤 카메라 번호가 맞는다
    except OSError:
        pass  # 이름은 보기용이라 실패해도 번호만 보여 주면 된다
    finally:
        release(monikers)
        release(devices)
        if initialized:
            ctypes.windll.ole32.CoUninitialize()
    return names


def camera_name(index):
    # Linux는 장치 이름을 파일로 읽고, Windows는 DirectShow 장치 목록에서 읽는다. 못 읽으면 번호만 보여 준다
    path = Path(f"/sys/class/video4linux/video{index}/name")
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    if sys.platform == "win32":
        names = windows_camera_names()
        if index < len(names) and names[index]:
            return names[index]
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
        return found[0]  # 한 대뿐이면 config.toml 번호가 틀려도 그 카메라를 쓴다
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
    # 서버 시작 때 한 번 고르고, Tracker가 읽는 CONFIG["camera_index"]에 넣어 둔다(파일은 바꾸지 않는다)
    default = CONFIG["camera_index"]
    index = pick_camera(find_cameras(), default)
    CONFIG["camera_index"] = index
    print(f"카메라 {index}번 사용: {camera_name(index)}")


class StallWatch:
    """카메라가 멈췄는지(프레임이 너무 드물게 오는지) 판정한다. 시각(ms)은 밖에서 넣어 준다(테스트용).

    Windows DSHOW는 오래 켜 두면 웹캠은 멀쩡한데 이 프로세스의 연결만 초당 1장꼴로 느려지는 일이 있었다
    (서버 12분 실행 뒤, 다른 프로세스로 같은 카메라를 열면 28fps). 다시 열면 풀리므로 그때 다시 연다.
    """
    WINDOW_MS = 3000   # 이 시간 동안의 프레임 수로 판정한다. 막 열었을 때도 이만큼은 기다린다
    MIN_FRAMES = 6     # 그 안에 정상 프레임이 이보다 적으면(2fps 미만) 멈춘 것. 어두운 곳·YUY2 1080p(5fps)보다 낮다
    BACKOFF_MS = (0, 2000, 5000, 10000, 30000)  # 다시 열어도 그대로면 점점 늦게 다시 연다(카메라를 뽑은 경우 등)

    def __init__(self, now):
        self.frames = deque()
        self.failures = 0  # 연속으로 다시 열었는데도 나아지지 않은 횟수
        self.opened = now

    def frame(self, ok, now):
        if ok:
            self.frames.append(now)
        while self.frames and now - self.frames[0] > self.WINDOW_MS:
            self.frames.popleft()
        if now - self.opened < self.WINDOW_MS:
            return False
        if len(self.frames) >= self.MIN_FRAMES:
            self.failures = 0  # 다시 연 뒤 한동안 정상이면 처음부터 다시 센다
            return False
        wait = self.BACKOFF_MS[min(self.failures, len(self.BACKOFF_MS) - 1)]
        return now - self.opened >= self.WINDOW_MS + wait

    def reopened(self, now):
        self.failures += 1
        self.frames.clear()
        self.opened = now


class LatestCamera:
    def __init__(self, index, opener=open_capture, clock=None):
        self.index = index
        self.opener = opener
        self.clock = clock or (lambda: round(time.monotonic() * 1000))
        self.reopens = 0  # 멈춰서 다시 연 횟수(테스트·기록용)
        self.cap = self._open()
        if not self.cap.isOpened():
            self.cap.release()
            raise RuntimeError("웹캠을 열 수 없습니다. 카메라 권한과 config.toml의 camera_index를 확인하세요.")
        self.condition = threading.Condition()
        self.stopping = threading.Event()
        self.latest = None
        self.sequence = 0
        self.consumed = 0
        self.thread = threading.Thread(target=self._capture, daemon=True, name="latest-camera")
        self.thread.start()

    def _open(self):
        cap = self.opener(self.index)
        # 큰 크기는 압축 안 된 방식(YUYV)이면 USB 대역폭 때문에 10fps로 떨어지는 웹캠이 많아 MJPG를 먼저 요청한다.
        # 카메라가 지원하지 않으면 무시되고, 실제로 나오는 크기는 Tracker가 프레임에서 읽는다.
        # Windows DSHOW는 크기를 바꿀 때 형식을 기본(YUY2)으로 되돌려 크기 뒤에 한 번 더 요청해야 한다
        # (학교 노트북 웹캠: 1280×720이 MJPG 먼저면 YUY2 10fps, 크기 뒤에 요청하면 MJPG 30fps)
        width, height = CONFIG["camera_size"]
        mjpg = cv2.VideoWriter_fourcc(*"MJPG")
        cap.set(cv2.CAP_PROP_FOURCC, mjpg)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        cap.set(cv2.CAP_PROP_FOURCC, mjpg)
        return cap

    def _reopen(self):
        # 반드시 옛 연결을 먼저 닫는다: 한 프로세스에서 같은 카메라를 두 번 열어 두고 하나를 닫으면
        # 남은 쪽도 다시는 프레임을 못 받았다(DSHOW에서 직접 재현)
        self.cap.release()
        if self.stopping.is_set():
            return
        try:
            self.cap = self._open()
        except Exception:
            # 여기서 예외가 나면 읽기 스레드가 끝나 서버를 재시작해야 했다. 빈 연결(읽으면 실패)로 두고 다음에 또 연다
            self.cap = cv2.VideoCapture()
        self.reopens += 1
        print(f"카메라 프레임이 너무 느려져(2fps 미만) 카메라를 다시 열었습니다. ({self.reopens}번째)", flush=True)

    def _capture(self):
        watch = StallWatch(self.clock())
        try:
            while not self.stopping.is_set():
                ok, frame = self.cap.read()
                with self.condition:
                    self.latest = (ok, frame, self.clock())
                    self.sequence += 1
                    self.condition.notify_all()
                if not ok:
                    self.stopping.wait(0.1)
                if watch.frame(ok, self.clock()) and not self.stopping.is_set():
                    self._reopen()
                    watch.reopened(self.clock())
        finally:
            self.cap.release()
            with self.condition:
                self.condition.notify_all()

    def read(self):
        with self.condition:
            ready = self.condition.wait_for(
                lambda: self.sequence > self.consumed or self.stopping.is_set(), timeout=2)
            if not ready or self.stopping.is_set():
                return False, None, self.clock()
            self.consumed = self.sequence
            return self.latest

    def close(self):
        self.stopping.set()
        with self.condition:
            self.condition.notify_all()
        self.thread.join(timeout=3)
