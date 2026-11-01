import unittest

import numpy as np
from backend.tracker import FaceLock

SETTINGS = {"min_size": .6, "switch": 1.3, "forget_ms": 5000}


def face(x, y, size):
    """눈 바깥 꼬리(33, 263)가 size만큼 떨어진 가짜 얼굴 점 478개. 중심은 (x, y)."""
    points = np.tile([float(x), float(y)], (478, 1))
    points[33] = [x - size / 2, y]
    points[263] = [x + size / 2, y]
    return points


class FaceLockTests(unittest.TestCase):
    def test_first_choice_is_largest_face(self):
        lock = FaceLock(SETTINGS)
        self.assertEqual(lock.choose([face(100, 100, 40), face(600, 300, 150)], 0), (1, False))

    def test_keeps_following_user_when_similar_face_appears(self):
        lock = FaceLock(SETTINGS)
        lock.choose([face(600, 300, 150)], 0)
        # 옆에 비슷한 크기(1.3배 이하) 얼굴이 나타나도 바로 전 자리 얼굴을 따라간다
        self.assertEqual(lock.choose([face(1000, 300, 180), face(610, 305, 148)], 33), (1, False))

    def test_switches_to_much_larger_face(self):
        lock = FaceLock(SETTINGS)
        lock.choose([face(600, 300, 100)], 0)
        index, changed = lock.choose([face(600, 300, 100), face(1000, 300, 200)], 33)
        self.assertEqual((index, changed), (1, True))

    def test_ignores_small_background_face_while_user_missing(self):
        lock = FaceLock(SETTINGS)
        lock.choose([face(600, 300, 150)], 0)
        # 사용자가 잠깐 안 보이는 동안 뒤 사람(작은 얼굴)은 잡지 않는다
        self.assertEqual(lock.choose([face(200, 200, 50)], 1000), (None, False))
        # 사용자가 돌아오면 다시 같은 사람으로 이어진다
        self.assertEqual(lock.choose([face(200, 200, 50), face(620, 300, 145)], 1500), (1, False))

    def test_forgets_after_timeout(self):
        lock = FaceLock(SETTINGS)
        lock.choose([face(600, 300, 150)], 0)
        self.assertEqual(lock.choose([face(200, 200, 50)], 6000), (0, True))

    def test_user_moving_back_gradually_is_followed(self):
        lock = FaceLock(SETTINGS)
        size, stamp = 150.0, 0
        lock.choose([face(600, 300, size)], stamp)
        # 한 프레임씩 조금씩 멀어지면 크기가 처음의 절반 아래로 내려가도 계속 같은 사람이다
        while size > 60:
            size *= .97
            stamp += 33
            self.assertEqual(lock.choose([face(600, 300, size), face(200, 200, 50)], stamp)[0], 0)


if __name__ == "__main__":
    unittest.main()
