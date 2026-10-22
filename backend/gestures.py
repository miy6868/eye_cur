"""Personal eye-open baseline and hysteresis, independent of gaze inference."""
from collections import deque
import math

# 입 벌림 비율(MAR) 문턱값. 두 값을 다르게 둬야 경계 근처에서 상태가 왔다 갔다 하지 않는다
MOUTH_OPEN_MAR = 0.30    # 이보다 커지면 '벌림'
MOUTH_CLOSED_MAR = 0.20  # 이보다 작아지면 '다뭄'
# MediaPipe FaceMesh 번호: 13 = 윗입술 안쪽 가운데, 14 = 아랫입술 안쪽 가운데, 61·291 = 양쪽 입꼬리
LIP_TOP, LIP_BOTTOM, MOUTH_LEFT, MOUTH_RIGHT = 13, 14, 61, 291


class EyeState:
    def __init__(self):
        self.samples = [deque(maxlen=150), deque(maxlen=150)]
        self.closed = False

    def update(self, ratios):
        if len(ratios) != 2 or not all(math.isfinite(r) and r > 0 for r in ratios):
            self.closed = False
            return {"eyesReady": False, "closing": False, "closed": False}
        ready = min(map(len, self.samples)) >= 12
        # Initial observation is collected while the user watches calibration targets.
        if not ready:
            for samples, ratio in zip(self.samples, ratios): samples.append(ratio)
        baseline = [max(.06, sorted(samples)[int((len(samples) - 1) * .8)]) for samples in self.samples]
        relative = [ratio / reference for ratio, reference in zip(ratios, baseline)]
        if ready:
            if self.closed:
                if all(r > .80 for r in relative): self.closed = False
            elif all(r < .70 for r in relative):
                self.closed = True
        closing = ready and (self.closed or all(r < .78 for r in relative))
        # Never learn a closed eye as the new open baseline.
        if ready and not closing and all(.84 <= r <= 1.6 for r in relative):
            for samples, ratio in zip(self.samples, ratios): samples.append(ratio)
        return {"eyesReady": ready, "closing": closing, "closed": self.closed,
                "openness": round(min(1.2, max(0, sum(relative) / 2)), 3)}

    def lost(self):
        self.closed = False


def mouth_ratio(points):
    """입 벌림 비율 = 입술 안쪽 위·아래 거리 ÷ 입 너비. 얼굴이 멀어져도 비율은 그대로다."""
    height = math.dist(points[LIP_TOP], points[LIP_BOTTOM])
    width = math.dist(points[MOUTH_LEFT], points[MOUTH_RIGHT])
    return height / max(width, 1e-6)


class MouthState:
    def __init__(self):
        self.open = False

    def update(self, mar):
        # 두 문턱값 사이(0.20~0.30)에서는 이전 상태를 그대로 유지한다
        if self.open and mar < MOUTH_CLOSED_MAR:
            self.open = False
        elif not self.open and mar > MOUTH_OPEN_MAR:
            self.open = True
        return {"mouthOpen": self.open, "mar": round(mar, 3)}

    def lost(self):
        self.open = False
