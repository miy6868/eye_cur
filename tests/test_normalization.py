import os
import unittest
from pathlib import Path

os.environ.setdefault('MPLCONFIGDIR', str(Path(__file__).resolve().parents[1] / '.cache/matplotlib'))
import cv2
import numpy as np
from backend.tracker import FACE_3D, FACE_IDS, face_warp


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
            warp = face_warp(points, camera, np.zeros(5))
            uv = camera @ center
            out = warp @ (uv / uv[2])
            np.testing.assert_allclose(out[:2] / out[2], [112, 112], atol=.01)

    def test_mouth_motion_does_not_change_crop(self):
        points, camera, _ = self.fixture([0.02, 0.05, 0])
        before = face_warp(points, camera, np.zeros(5))
        points[[61, 291]] = [[100, 300], [500, 400]]
        np.testing.assert_allclose(face_warp(points, camera, np.zeros(5)), before)

    def test_tiny_or_invalid_face_is_rejected(self):
        points, camera, _ = self.fixture([0, 0, 0])
        points[FACE_IDS] = points[FACE_IDS] * .01
        with self.assertRaises(ValueError): face_warp(points, camera, np.zeros(5))


if __name__ == '__main__': unittest.main()
