import unittest

from backend.camera import pick_camera


class PickCameraTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
