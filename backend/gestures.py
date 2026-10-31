"""Personal eye-open baseline and hysteresis, independent of gaze inference."""
from collections import deque
import math

from backend.config import CONFIG

# 입 벌림 비율(MAR) 문턱값: config.toml [mouth]. 두 값을 다르게 둬야 경계 근처에서 상태가 왔다 갔다 하지 않는다
# 처음엔 0.30/0.20이었는데 입을 꽤 크게 벌려야 해서 0.20/0.12로 낮췄다. 말할 때 잠깐 벌어지는 입은
# 확장의 MouthClick이 짧은 벌림을 무시해서 걸러진다
MOUTH_OPEN_MAR = CONFIG["mouth"]["open_mar"]
MOUTH_CLOSED_MAR = CONFIG["mouth"]["closed_mar"]
# 눈 열림 문턱값: config.toml [eyes]. 평소 뜬 눈(기준) 대비 비율이고, 두 눈이 모두 넘어야 한다(한쪽 윙크는 무시)
# 처음엔 감는 중 0.78 / 감음 0.70 / 다시 뜸 0.80이었다. 보정 기록을 보니 아래쪽을 볼 때 눈꺼풀이 내려와
# 평소에도 0.66~0.8까지 내려가서, 눈을 뜨고 있는데 '감는 중'으로 시선이 자주 멈췄다. 그래서 0.60/0.50/0.62로 낮췄다
EYE_CLOSING = CONFIG["eyes"]["closing"]
EYE_CLOSED = CONFIG["eyes"]["closed"]
EYE_REOPEN = CONFIG["eyes"]["reopen"]
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
                if all(r > EYE_REOPEN for r in relative): self.closed = False
            elif all(r < EYE_CLOSED for r in relative):
                self.closed = True
        closing = ready and (self.closed or all(r < EYE_CLOSING for r in relative))
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
        # 두 문턱값 사이(0.12~0.20)에서는 이전 상태를 그대로 유지한다
        if self.open and mar < MOUTH_CLOSED_MAR:
            self.open = False
        elif not self.open and mar > MOUTH_OPEN_MAR:
            self.open = True
        return {"mouthOpen": self.open, "mar": round(mar, 3)}

    def lost(self):
        self.open = False
