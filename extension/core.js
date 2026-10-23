(() => {
  if (globalThis.GazeCore) return;
  // NearestSelector 설정: 시연하면서 바꿔 볼 숫자는 여기 모아 둔다
  const DWELL_MS = 300;        // 같은 요소가 이 시간 이상 계속 1등이어야 선택 (머무름)
  const SWITCH_MARGIN_PX = 30; // 새 1등이 이만큼 더 가까워야 선택을 바꿈 (끈적임)
  // MouthClick 설정
  const MOUTH_MIN_MS = 500;       // 이보다 짧게 벌리면 말하는 중으로 보고 무시
  const MOUTH_MAX_MS = 2000;      // 이보다 오래 벌리면 클릭 취소
  const MOUTH_COOLDOWN_MS = 800;  // 클릭 직후 연속 클릭 방지
  // CalibrationCollector 설정
  const SETTLE_MS = 600;   // 점이 나타난 뒤 눈이 옮겨 갈 때까지 기다리는 시간
  const COLLECT_MS = 1000; // 점 하나에서 표본을 모으는 시간
  const MIN_SAMPLES = 6;   // CPU가 느려도 최소 이만큼은 모은다
  function solve(matrix, vector) {
    const a = matrix.map((row, i) => [...row, vector[i]]);
    for (let i = 0; i < a.length; i++) {
      let pivot = i;
      for (let j = i + 1; j < a.length; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
      [a[i], a[pivot]] = [a[pivot], a[i]];
      if (Math.abs(a[i][i]) < 1e-10) throw new Error('시선 변화가 너무 작습니다. 머리를 고정하고 다시 보정하세요.');
      const divisor = a[i][i];
      for (let k = i; k <= a.length; k++) a[i][k] /= divisor;
      for (let j = 0; j < a.length; j++) {
        if (j === i) continue;
        const factor = a[j][i];
        for (let k = i; k <= a.length; k++) a[j][k] -= factor * a[i][k];
      }
    }
    return a.map(row => row[a.length]);
  }
  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }
  // 한 점에서 모은 시선 값들의 대표값을 구한다
  function summarize(readings) {
    const valid = readings.filter(g => Array.isArray(g) && g.length === 2 && g.every(Number.isFinite));
    if (valid.length < MIN_SAMPLES) return {ready: false, count: valid.length};
    // 중앙값에서 너무 먼 값(점으로 눈을 옮기는 중이던 값 등)은 버린다
    const center = [0, 1].map(k => median(valid.map(g => g[k])));
    const mad = [0, 1].map(k => Math.max(.001, 1.4826 * median(valid.map(g => Math.abs(g[k] - center[k])))));
    const kept = valid.filter(g => g.every((v, k) => Math.abs(v - center[k]) <= 3.5 * mad[k]));
    if (kept.length < MIN_SAMPLES) return {ready: false, count: kept.length};
    // 평균 대신 중앙값: 튀는 값 하나에 덜 흔들린다
    const gaze = [0, 1].map(k => median(kept.map(g => g[k])));
    return {ready: true, count: kept.length, gaze};
  }
  class CalibrationCollector {
    constructor(shownAt) { this.shownAt = shownAt; this.readings = []; this.resumeAt = shownAt + SETTLE_MS; }
    add(frame, now) {
      const age = frame.captureAgeMs ?? frame.inferenceMs ?? 0;
      if (!frame.valid || frame.closed || frame.closing || frame.eyesReady === false) {
        this.resumeAt = now + 350;
        return {ready: false, count: this.readings.length, reason: 'eyes'};
      }
      // 촬영 시각(now - age) 기준으로 판단해야 CPU가 늦게 낸 이전 점의 결과가 섞이지 않는다
      if (!Number.isFinite(age) || age < 0 || age > 500 || now - age < Math.max(this.shownAt + SETTLE_MS, this.resumeAt)) {
        return {ready: false, count: this.readings.length, reason: 'settling'};
      }
      if (!Array.isArray(frame.gaze) || frame.gaze.length !== 2 || !frame.gaze.every(Number.isFinite)) {
        return {ready: false, count: this.readings.length, reason: 'invalid'};
      }
      this.readings.push({gaze: frame.gaze, time: now - age});
      const result = summarize(this.readings.map(r => r.gaze));
      // 안정될 때까지 기다리지 않고 정해진 시간만 모은다: 오래 걸리면 그사이 머리가 움직여 더 부정확해진다
      if (this.readings.at(-1).time - this.readings[0].time < COLLECT_MS) result.ready = false;
      return result;
    }
  }
  function features(gaze, mean, scale, degree) {
    const [x, y] = gaze.map((v, k) => (v - mean[k]) / scale[k]);
    return degree === 2 ? [1, x, y, x * x, x * y, y * y] : [1, x, y];
  }
  function regression(samples, degree, penalty = 0) {
    const mean = [0, 1].map(k => samples.reduce((sum, s) => sum + s.gaze[k], 0) / samples.length);
    const scale = [0, 1].map(k => Math.sqrt(samples.reduce((sum, s) => sum + (s.gaze[k] - mean[k]) ** 2, 0) / samples.length));
    if (scale.some(x => x < 0.003)) throw new Error('시선 변화가 부족합니다. 조명과 카메라 위치를 확인하세요.');
    const rows = samples.map(s => features(s.gaze, mean, scale, degree));
    const columns = Array.from({length: rows[0].length}, (_, i) => i);
    const gram = columns.map(i => columns.map(j => rows.reduce((sum, r) => sum + r[i] * r[j], 0) + (i === j && i > 0 ? penalty : 0)));
    const coefficients = [0, 1].map(k => solve(gram, columns.map(j => rows.reduce((sum, r, i) => sum + r[j] * samples[i].target[k], 0))));
    const model = {mean, scale, coefficients, degree, penalty};
    model.error = Math.sqrt(samples.reduce((sum, s) => sum + predict(model, s.gaze).reduce((e, v, k) => e + (v - s.target[k]) ** 2, 0), 0) / samples.length);
    return model;
  }
  function crossError(samples, degree, penalty) {
    try {
      return Math.sqrt(samples.reduce((sum, s, i) => {
        const model = regression(samples.filter((_, j) => j !== i), degree, penalty);
        return sum + predict(model, s.gaze).reduce((e, value, k) => e + (value - s.target[k]) ** 2, 0);
      }, 0) / samples.length);
    } catch { return Infinity; }
  }
  function fit(samples) {
    if (samples.length < 9) throw new Error('보정 자료가 부족합니다.');
    const linear = regression(samples, 1);
    linear.crossError = crossError(samples, 1, 0);
    if (samples.length < 16) return linear;
    const options = [.01, .1, 1].map(penalty => ({penalty, error: crossError(samples, 2, penalty)})).sort((a, b) => a.error - b.error);
    // Select nonlinearity only when held-out calibration points improve materially.
    if (options[0].error < linear.crossError * .85) {
      const quadratic = regression(samples, 2, options[0].penalty);
      quadratic.crossError = options[0].error;
      return quadratic;
    }
    return linear;
  }
  function predict(model, gaze) {
    const row = features(gaze, model.mean, model.scale, model.degree || 1);
    return model.coefficients.map((c, axis) => c.reduce((sum, v, k) => sum + v * row[k], 0) + (model.offset?.[axis] || 0));
  }
  class Blink {
    constructor() { this.reset(); this.cooldown = 0; }
    reset() { this.started = null; this.armedAt = null; this.target = null; this.previousTime = null; this.result = null; }
    get active() { return this.armedAt !== null; }
    update({valid, closed, closing, eyesReady, time}, target) {
      this.result = null;
      if (!valid || eyesReady === false || !Number.isFinite(time) || (this.previousTime !== null && (time - this.previousTime > 400 || time <= this.previousTime))) {
        this.reset(); return null;
      }
      this.previousTime = time;
      if (closed || closing) {
        if (this.armedAt === null) { this.armedAt = time; this.target = target; }
        if (this.started === null && time - this.armedAt > 500) this.target = null;
        if (closed && this.started === null) this.started = time;
        return null;
      }
      const elapsed = this.started === null ? 0 : time - this.started;
      const click = elapsed >= 600 && elapsed <= 2000 && time >= this.cooldown ? this.target : null;
      if (this.started !== null) this.result = click ? 'clicked' : !this.target ? 'no-target' : elapsed < 600 ? 'short' : elapsed > 2000 ? 'long' : 'cooldown';
      this.started = null; this.armedAt = null; this.target = null;
      if (click) this.cooldown = time + 800;
      return click;
    }
  }
  // 입 벌리기 클릭: Blink와 같은 구조. 벌렸다가 다무는 순간 클릭한다
  class MouthClick {
    constructor() { this.reset(); this.cooldown = 0; }
    reset() { this.started = null; this.target = null; this.previousTime = null; this.result = null; }
    get active() { return this.started !== null; }
    update({valid, mouthOpen, time}, target) {
      this.result = null;
      // 얼굴을 놓치거나 프레임이 0.4초 넘게 끊기면 진행 중이던 클릭을 취소한다
      if (!valid || !Number.isFinite(time) || (this.previousTime !== null && (time - this.previousTime > 400 || time <= this.previousTime))) {
        this.reset(); return null;
      }
      this.previousTime = time;
      if (mouthOpen) {
        // 벌리는 순간의 대상을 고정: 입을 벌리는 동안 시선이 흔들려도 대상이 바뀌지 않는다
        if (this.started === null) { this.started = time; this.target = target; }
        return null;
      }
      if (this.started === null) return null;
      const elapsed = time - this.started;
      const click = elapsed >= MOUTH_MIN_MS && elapsed <= MOUTH_MAX_MS && time >= this.cooldown ? this.target : null;
      this.result = click ? 'clicked' : !this.target ? 'no-target' : elapsed < MOUTH_MIN_MS ? 'short' : elapsed > MOUTH_MAX_MS ? 'long' : 'cooldown';
      this.started = null; this.target = null;
      if (click) this.cooldown = time + MOUTH_COOLDOWN_MS;
      return click;
    }
  }
  // 떨림 제거 필터 1: 최근 size개 점의 평균
  class MovingAverage {
    constructor(size) { this.size = size; this.reset(); }
    reset() { this.points = []; }
    update(point) {
      this.points.push(point);
      // 창 크기를 넘으면 가장 오래된 점을 버린다
      if (this.points.length > this.size) this.points.shift();
      return [0, 1].map(k => this.points.reduce((sum, p) => sum + p[k], 0) / this.points.length);
    }
  }
  // 떨림 제거 필터 2: 새값×alpha + 이전값×(1-alpha). 최근 값일수록 더 크게 반영된다
  class ExponentialSmoothing {
    constructor(alpha) { this.alpha = alpha; this.reset(); }
    reset() { this.value = null; }
    update(point) {
      // 첫 점은 비교할 이전값이 없으므로 그대로 쓴다
      if (!this.value) this.value = point;
      else this.value = this.value.map((old, k) => point[k] * this.alpha + old * (1 - this.alpha));
      return this.value;
    }
  }
  function average(points) {
    return [0, 1].map(k => points.reduce((sum, p) => sum + p[k], 0) / points.length);
  }
  // 떨림 제거 필터 3: 응시 고정. 눈은 한 곳을 응시하다가 순간적으로 다른 곳으로 뛴다(사카드).
  // 그래서 응시 중에는 많이 평균해 멈춰 있고, 시선이 뛰면 평균을 버리고 바로 따라간다
  class FixationFilter {
    constructor(radius, jumpCount, maxPoints) {
      this.radius = radius;       // 응시 중심에서 이 거리(px) 안의 점은 같은 응시로 본다
      this.jumpCount = jumpCount; // 멀리 있는 점이 이만큼 연속으로 와야 시선이 옮겨 갔다고 본다
      this.maxPoints = maxPoints; // 응시 하나에서 평균할 최대 점 수
      this.reset();
    }
    reset() { this.points = []; this.away = []; }
    update(point) {
      const near = this.points.length === 0 || Math.hypot(...point.map((v, k) => v - average(this.points)[k])) <= this.radius;
      if (near) {
        this.points.push(point);
        this.away = [];
      } else {
        // 멀리 있는 점들끼리도 서로 가까워야 한다: 사방으로 튄 잡음이면 처음부터 다시 센다
        const together = this.away.length === 0 || Math.hypot(...point.map((v, k) => v - average(this.away)[k])) <= this.radius;
        this.away = together ? [...this.away, point] : [point];
        // 한두 번 튄 값은 무시하고, 연속으로 멀리 있어야 새 응시로 옮긴다
        if (this.away.length >= this.jumpCount) {
          this.points = this.away;
          this.away = [];
        }
      }
      // 오래된 점은 버린다: 천천히 움직이는 시선도 결국 따라가게 한다
      if (this.points.length > this.maxPoints) this.points.shift();
      return average(this.points);
    }
  }
  // 점들이 평균 위치에서 얼마나 흩어져 있는지(표준편차, px). 필터 전/후 떨림 비교에 쓴다
  function jitter(points) {
    if (points.length < 2) return 0;
    const mean = [0, 1].map(k => points.reduce((sum, p) => sum + p[k], 0) / points.length);
    const variance = points.reduce((sum, p) => sum + (p[0] - mean[0]) ** 2 + (p[1] - mean[1]) ** 2, 0) / points.length;
    return Math.sqrt(variance);
  }
  // Jev 대신 직접 만든 대상 선택: 시선에서 가장 가까운 요소를 고른다.
  class NearestSelector {
    constructor() { this.reset(); }
    reset() {
      this.leader = null;   // 지금 1등인 요소
      this.since = 0;       // 그 요소가 1등이 된 시각
      this.selected = null; // 최종 선택된 요소
    }
    // items: GazeDOM.collect 결과 (거리순 정렬), now: 밀리초 시각
    update(items, now) {
      const best = items[0];
      if (!best) return this.selected;
      // 1등이 바뀌면 머무름 시간을 처음부터 다시 잰다
      if (best.id !== this.leader?.id) this.since = now;
      this.leader = best;
      // 0.3초 동안 계속 1등이 아니면 아직 선택하지 않는다 (시선 떨림으로 깜빡이는 것 방지)
      if (now - this.since < DWELL_MS) return this.selected;
      const current = this.selected && items.find(item => item.id === this.selected.id);
      // 끈적임: 기존 선택이 아직 후보에 있으면 새 1등이 30px 이상 더 가까울 때만 바꾼다
      if (current && best.distance + SWITCH_MARGIN_PX > current.distance) {
        this.selected = current; // 같은 요소라도 최신 위치 정보로 갱신
        return this.selected;
      }
      this.selected = best;
      return this.selected;
    }
  }
  function distanceToRect(x, y, rect) {
    return Math.hypot(Math.max(rect[0] - x, 0, x - rect[0] - rect[2]), Math.max(rect[1] - y, 0, y - rect[1] - rect[3]));
  }
  globalThis.GazeCore = {fit, predict, Blink, MouthClick, NearestSelector, MovingAverage, ExponentialSmoothing, FixationFilter, jitter, distanceToRect, summarize, CalibrationCollector};
  if (typeof module !== 'undefined') module.exports = globalThis.GazeCore;
})();
