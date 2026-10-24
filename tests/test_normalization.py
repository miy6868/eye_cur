import os
import unittest
from pathlib import Path

os.environ.setdefault('MPLCONFIGDIR', str(Path(__file__).resolve().parents[1] / '.cache/matplotlib'))
import cv2
import numpy as np
from backend.tracker import FACE_3D, FACE_IDS, face_warp, iris_offset


class NormalizationTests(unittest.TestCase):
    def fixture(self, rvec):
        camera = np.array([[640., 0, 320], [0, 640., 240], [0, 0, 1.]])
        tvec = np.array([15., 5., 620.])
        rvec = np.array(rvec, dtype=np.float64)
        projected, _ = cv2.projectPoints(FACE_3D, rvec, tvec, camera, np.zeros(5))
        points = np.zeros((468, 2))
        points[FACE_IDS] = projected.reshape(-1, 2)
        rotation = cv2.Rodrigues(rvec)[0]
        face = (rotation @ FACE_3D.T).T + tvec
        center = (face[:4].mean(axis=0) + face[4:].mean(axis=0)) / 2
        return points, camera, center

    def test_official_eye_nose_center_maps_to_crop_center(self):
        for pose in ([0, 0, 0], [.08, -.15, .03], [-.1, .12, -.06]):
            points, camera, center = self.fixture(pose)
            warp, _ = face_warp(points, camera, np.zeros(5))
            uv = camera @ center
            out = warp @ (uv / uv[2])
            np.testing.assert_allclose(out[:2] / out[2], [112, 112], atol=.01)

    def test_head_roll_and_distance_are_reported(self):
        # z축으로 0.1rad(약 5.7도) 돌리면 고개를 그만큼 기울인 것
        points, camera, center = self.fixture([0, 0, .1])
        _, head = face_warp(points, camera, np.zeros(5))
        self.assertAlmostEqual(head["headRoll"], 5.7, delta=.1)
        self.assertAlmostEqual(head["headDistance"], np.linalg.norm(center), delta=1)

    def test_head_pitch_and_yaw_are_reported(self):
        # x축으로 돌리면 끄덕임(+ = 아래로 숙임), y축으로 돌리면 좌우 돌림
        points, camera, _ = self.fixture([.1, 0, 0])
        self.assertAlmostEqual(face_warp(points, camera, np.zeros(5))[1]["headPitch"], 5.7, delta=.1)
        points, camera, _ = self.fixture([0, .1, 0])
        self.assertAlmostEqual(face_warp(points, camera, np.zeros(5))[1]["headYaw"], -5.7, delta=.1)

    def test_iris_offset_is_measured_in_eye_widths(self):
        points = np.zeros((478, 2))
        points[[33, 133, 362, 263]] = [[100, 200], [140, 200], [180, 200], [220, 200]]
        # 두 홍채 모두 눈 가운데에서 오른쪽으로 4px(눈 너비 40px의 0.1), 아래로 2px(0.05)
        points[468] = [204, 202]
        points[473] = [124, 202]
        np.testing.assert_allclose(iris_offset(points), [.1, .05])

    def test_mouth_motion_does_not_change_crop(self):
        points, camera, _ = self.fixture([0.02, 0.05, 0])
        before, _ = face_warp(points, camera, np.zeros(5))
        points[[61, 291]] = [[100, 300], [500, 400]]
        np.testing.assert_allclose(face_warp(points, camera, np.zeros(5))[0], before)

    def test_tiny_or_invalid_face_is_rejected(self):
        points, camera, _ = self.fixture([0, 0, 0])
        points[FACE_IDS] = points[FACE_IDS] * .01
        with self.assertRaises(ValueError): face_warp(points, camera, np.zeros(5))


if __name__ == '__main__': unittest.main()
