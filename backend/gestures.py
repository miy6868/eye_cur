"""Personal eye-open baseline and hysteresis, independent of gaze inference."""
from collections import deque
import math


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
