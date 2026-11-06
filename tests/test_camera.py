import threading
import time
import unittest
from unittest import mock

import cv2

from backend.camera import LatestCamera, StallWatch, camera_name, pick_camera


class PickCameraTests(unittest.TestCase):
    def test_unknown_camera_name_falls_back_to_number(self):
        # 이름을 읽지 못한 번호는 OS와 상관없이 번호로 보여 준다
        self.assertEqual(camera_name(99), "카메라 99")

    def test_single_or_missing_camera_does_not_ask(self):
        def never(_):
            raise AssertionError("카메라가 한 대 이하면 묻지 않아야 한다")
        self.assertEqual(pick_camera([2], 0, ask=never), 2)
        self.assertEqual(pick_camera([], 0, ask=never), 0)

    def test_multiple_cameras_ask_and_retry_on_wrong_number(self):
        answers = iter(["7", "abc", "2"])
        self.assertEqual(pick_camera([0, 2], 0, ask=lambda _: next(answers)), 2)

    def test_enter_or_no_input_uses_default(self):
        self.assertEqual(pick_camera([0, 2], 2, ask=lambda _: ""), 2)

        def closed(_):
            raise EOFError
        self.assertEqual(pick_camera([0, 2], 5, ask=closed), 0)


def run_watch(watch, frames):
    """frames: (시각 ms, ok) 순서. 다시 열라고 한 시각 목록을 돌려주고, 그때마다 reopened를 부른다."""
    reopens = []
    for now, ok in frames:
        if watch.frame(ok, now):
            reopens.append(now)
            watch.reopened(now)
    return reopens


def steady(start, end, fps, ok=True):
    step = 1000 / fps
    return [(round(start + i * step), ok) for i in range(int((end - start) / step))]


class StallWatchTests(unittest.TestCase):
    def test_normal_and_slow_but_usable_cameras_never_reopen(self):
        # 30fps, 어두운 곳(7.5fps), YUY2 1080p(5fps), 3fps를 10분씩: 한 번도 다시 열지 않는다
        for fps in (30, 7.5, 5, 3):
            with self.subTest(fps=fps):
                self.assertEqual(run_watch(StallWatch(0), steady(0, 600_000, fps)), [])

    def test_exactly_two_fps_is_still_usable(self):
        self.assertEqual(run_watch(StallWatch(0), steady(0, 60_000, 2)), [])

    def test_waits_a_full_window_after_opening(self):
        # 막 연 카메라는 첫 프레임이 늦게 나와도 WINDOW_MS 전에는 판정하지 않는다
        watch = StallWatch(0)
        self.assertFalse(watch.frame(False, 2999))
        self.assertTrue(watch.frame(False, 3000))

    def test_slow_one_fps_after_healthy_reopens_within_window(self):
        # 실제로 본 증상: 정상(30fps)이다가 초당 1장. 3초 남짓 안에 다시 연다
        frames = steady(0, 60_000, 30) + steady(60_000, 70_000, 1)
        reopens = run_watch(StallWatch(0), frames)
        self.assertLessEqual(reopens[0] - 60_000, StallWatch.WINDOW_MS + 1000)
        # 다시 연 뒤에도 그대로 1fps면 대기 시간을 두고 한 번 더 연다
        self.assertEqual(reopens[1] - reopens[0], StallWatch.WINDOW_MS + StallWatch.BACKOFF_MS[1])

    def test_failed_reads_do_not_count_as_frames(self):
        frames = steady(0, 10_000, 30) + steady(10_000, 14_000, 10, ok=False)
        self.assertEqual(len(run_watch(StallWatch(0), frames)), 1)

    def test_backoff_when_reopening_does_not_help(self):
        # 카메라를 뽑은 경우: 읽기가 계속 실패해도 계속 열었다 닫지 않고 점점 늦게 다시 연다
        reopens = run_watch(StallWatch(0), steady(0, 300_000, 10, ok=False))
        gaps = [b - a for a, b in zip([0] + reopens, reopens)]
        expected = [StallWatch.WINDOW_MS + wait for wait in StallWatch.BACKOFF_MS]
        self.assertEqual(gaps[:5], expected)
        self.assertTrue(all(gap == expected[-1] for gap in gaps[5:]))
        self.assertLess(len(reopens), 15)  # 5분에 15번 미만

    def test_recovery_resets_backoff(self):
        # 몇 번 실패한 뒤 정상으로 돌아오면, 다음에 멈출 때는 다시 곧바로(대기 없이) 연다
        frames = steady(0, 20_000, 10, ok=False)
        frames += steady(20_000, 80_000, 30)
        frames += steady(80_000, 90_000, 1)
        reopens = run_watch(StallWatch(0), frames)
        self.assertGreaterEqual(len([t for t in reopens if t < 20_000]), 2)
        late = [t for t in reopens if t >= 80_000]
        self.assertLessEqual(late[0] - 80_000, StallWatch.WINDOW_MS + 1000)
        self.assertEqual(late[1] - late[0], StallWatch.WINDOW_MS + StallWatch.BACKOFF_MS[1])


class FakeCapture:
    """가짜 카메라. 열린 수를 세어 한 번에 둘 이상 열리지 않는지 본다."""

    def __init__(self, world, number, fps, opened=True):
        self.world, self.number, self.fps, self.opened = world, number, fps, opened
        self.props = []
        if opened:
            world.open_now += 1
            world.max_open = max(world.max_open, world.open_now)
        world.events.append(("open", number))

    def isOpened(self):
        return self.opened

    def set(self, prop, value):
        self.props.append((prop, value))
        return True

    def read(self):
        if not self.opened:
            return False, None
        fps = self.fps() if callable(self.fps) else self.fps
        time.sleep(1 / fps)
        return True, f"frame-{self.number}"

    def release(self):
        if self.opened:
            self.opened = False
            self.world.open_now -= 1
            self.world.events.append(("release", self.number))


class FakeWorld:
    def __init__(self, plan):
        # plan: 여는 차례마다 fps(숫자·함수), "closed"(안 열림), "raise"(예외). 끝나면 마지막 것을 반복
        self.plan, self.caps, self.events = list(plan), [], []
        self.open_now = self.max_open = 0
        self.lock = threading.Lock()

    def opener(self, index):
        with self.lock:
            step = self.plan[min(len(self.caps), len(self.plan) - 1)]
            number = len(self.caps)
            if step == "raise":
                self.caps.append(None)
                raise OSError("장치 오류")
            if step == "closed":
                cap = FakeCapture(self, number, 30, opened=False)
            else:
                cap = FakeCapture(self, number, step)
            self.caps.append(cap)
            return cap


def wait_until(condition, timeout=5):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if condition():
            return True
        time.sleep(0.01)
    return False


# 스레드 테스트는 실제 시간으로 돌리므로 판정 창을 줄인다(0.3초 안에 3장 미만이면 멈춤)
SHORT = dict(WINDOW_MS=300, MIN_FRAMES=3, BACKOFF_MS=(0, 200, 400))


@mock.patch.multiple(StallWatch, **SHORT)
class LatestCameraReopenTests(unittest.TestCase):
    def make(self, plan):
        world = FakeWorld(plan)
        camera = LatestCamera(0, opener=world.opener)
        self.addCleanup(camera.close)
        return world, camera

    def fps_now(self, camera, seconds=0.4):
        count, end = 0, time.monotonic() + seconds
        while time.monotonic() < end:
            count += camera.read()[0]
        return count / seconds

    def test_healthy_camera_is_never_reopened(self):
        world, camera = self.make([60])
        time.sleep(1.5)
        self.assertEqual(camera.reopens, 0)
        self.assertGreater(self.fps_now(camera), 30)

    def test_slow_camera_is_reopened_and_frames_come_back(self):
        started = time.monotonic()

        def slow_after():
            return 60 if time.monotonic() - started < 0.6 else 1
        world, camera = self.make([slow_after, 60])
        self.assertTrue(wait_until(lambda: camera.reopens == 1))
        self.assertGreater(self.fps_now(camera), 30)
        self.assertEqual(camera.read()[1], "frame-1")  # 새 연결의 프레임
        # 옛 연결을 닫은 뒤에 새로 열고, 카메라가 동시에 둘 열린 적이 없다
        self.assertEqual(world.events[:3], [("open", 0), ("release", 0), ("open", 1)])
        self.assertEqual(world.max_open, 1)
        self.assertEqual(camera.reopens, 1)  # 새 연결이 정상이면 더 열지 않는다

    def test_reopen_requests_mjpg_and_size_again(self):
        world, camera = self.make([1, 60])
        self.assertTrue(wait_until(lambda: camera.reopens >= 1))
        mjpg = cv2.VideoWriter_fourcc(*"MJPG")
        for cap in world.caps[:2]:
            self.assertEqual([prop for prop, _ in cap.props],
                             [cv2.CAP_PROP_FOURCC, cv2.CAP_PROP_FRAME_WIDTH,
                              cv2.CAP_PROP_FRAME_HEIGHT, cv2.CAP_PROP_FOURCC])
            self.assertEqual(cap.props[-1][1], mjpg)

    def test_failed_and_raising_reopens_keep_trying_until_camera_returns(self):
        # 다시 열 때 안 열림 → 예외 → 정상: 스레드가 죽지 않고 결국 프레임이 다시 나온다
        world, camera = self.make([1, "closed", "raise", 60])
        self.assertTrue(wait_until(lambda: camera.reopens >= 3, timeout=8))
        self.assertTrue(camera.thread.is_alive())
        self.assertTrue(wait_until(lambda: self.fps_now(camera, 0.2) > 30))
        self.assertLessEqual(world.max_open, 1)

    def test_close_while_stalled_stops_thread_and_releases_everything(self):
        world, camera = self.make([2.5])  # read 한 번에 0.4초
        time.sleep(0.5)
        camera.close()
        self.assertFalse(camera.thread.is_alive())
        self.assertEqual(world.open_now, 0)
        count = len(world.caps)
        time.sleep(0.5)
        self.assertEqual(len(world.caps), count)  # 닫은 뒤에는 다시 열지 않는다
        self.assertFalse(camera.read()[0])

    def test_read_never_hangs_while_reopening(self):
        # 다시 여는 데 1초 걸려도 read()는 2초 대기 한도 안에 돌아온다(Tracker 루프가 멈추지 않음)
        world = FakeWorld([1, 60])

        def slow_open(index):
            if world.caps:
                time.sleep(1)
            return world.opener(index)
        camera = LatestCamera(0, opener=slow_open)
        self.addCleanup(camera.close)
        end = time.monotonic() + 2.5
        while time.monotonic() < end:
            started = time.monotonic()
            camera.read()
            self.assertLess(time.monotonic() - started, 2.5)
        self.assertGreaterEqual(camera.reopens, 1)

    def test_initial_open_failure_raises_and_releases(self):
        world = FakeWorld(["closed"])
        with self.assertRaises(RuntimeError):
            LatestCamera(0, opener=world.opener)
        self.assertEqual(world.open_now, 0)


if __name__ == "__main__":
    unittest.main()
