import unittest
from backend.gestures import EyeState, MouthState, mouth_ratio


class EyeStateTests(unittest.TestCase):
    def ready(self, value=.3):
        eyes = EyeState()
        for _ in range(16): eyes.update([value, value])
        return eyes

    def test_closing_precedes_closed_and_reopening_has_hysteresis(self):
        eyes = self.ready()
        self.assertTrue(eyes.update([.17, .17])['closing'])
        self.assertFalse(eyes.update([.17, .17])['closed'])
        self.assertTrue(eyes.update([.14, .14])['closed'])
        self.assertTrue(eyes.update([.18, .18])['closed'])
        self.assertFalse(eyes.update([.3, .3])['closed'])

    def test_looking_down_with_lowered_lids_is_not_closing(self):
        eyes = self.ready()
        # 아래쪽을 보면 눈꺼풀이 내려와 평소의 약 0.7이 된다: 시선을 멈추면 안 된다
        self.assertFalse(eyes.update([.21, .21])['closing'])
        # 깜빡인 뒤 아래쪽을 계속 봐도(0.67) 다시 뜬 것으로 본다
        self.assertTrue(eyes.update([.1, .1])['closed'])
        self.assertFalse(eyes.update([.20, .20])['closing'])

    def test_long_closure_does_not_relearn_closed_eyes_as_open(self):
        eyes = self.ready()
        for _ in range(300): self.assertTrue(eyes.update([.1, .1])['closed'])
        self.assertFalse(eyes.update([.3, .3])['closed'])

    def test_partial_landmark_closure_is_detected_without_accepting_a_wink(self):
        eyes = self.ready()
        self.assertFalse(eyes.update([.14, .30])['closed'])
        self.assertTrue(eyes.update([.14, .14])['closed'])
        self.assertFalse(eyes.update([.30, .30])['closed'])

    def test_small_eyes_use_their_own_baseline_and_wink_is_not_two_eye_gesture(self):
        eyes = self.ready(.14)
        self.assertFalse(eyes.update([.13, .13])['closed'])
        self.assertFalse(eyes.update([.06, .14])['closed'])
        self.assertTrue(eyes.update([.06, .06])['closed'])

    def test_initial_observation_and_face_loss_do_not_claim_a_gesture(self):
        eyes = EyeState()
        self.assertFalse(eyes.update([.3, .3])['eyesReady'])
        eyes = self.ready()
        eyes.update([.1, .1]); eyes.lost()
        self.assertFalse(eyes.closed)


class MouthStateTests(unittest.TestCase):
    def test_values_between_thresholds_keep_the_previous_state(self):
        mouth = MouthState()
        self.assertFalse(mouth.update(.16)['mouthOpen'])  # 다문 상태에서 0.16 → 그대로 다뭄
        self.assertTrue(mouth.update(.22)['mouthOpen'])   # 0.20 초과 → 벌림
        self.assertTrue(mouth.update(.16)['mouthOpen'])   # 벌린 상태에서 0.16 → 그대로 벌림
        self.assertFalse(mouth.update(.10)['mouthOpen'])  # 0.12 미만 → 다뭄

    def test_ratio_uses_inner_lips_over_mouth_corners(self):
        points = [(0, 0)] * 468
        points[13], points[14], points[61], points[291] = (50, 100), (50, 120), (0, 110), (100, 110)
        self.assertAlmostEqual(mouth_ratio(points), .2)
