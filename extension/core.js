(() => {
  if (globalThis.GazeCore) return;
  // NearestSelector 설정: 시연하면서 바꿔 볼 숫자는 여기 모아 둔다
  const DWELL_MS = 300;        // 같은 요소가 이 시간 이상 계속 1등이어야 선택 (머무름)
  const SWITCH_MARGIN_PX = 30; // 새 1등이 이만큼 더 가까워야 선택을 바꿈 (끈적임)
  // MouthClick 설정
  const MOUTH_MIN_MS = 500;       // 이보다 짧게 벌리면 말하는 중으로 보고 무시
  const MOUTH_MAX_MS = 2000;      // 이보다 오래 벌리면 클릭 취소
  const MOUTH_COOLDOWN_MS = 800;  // 클릭 직후 연속 클릭 방지
  // 움직이는 점 보정 설정
  const PURSUIT_SPEED = .3;       // 점이 1초에 화면의 30%만큼 움직인다: 눈이 놓치지 않고 따라갈 수 있는 속도
  const PURSUIT_STOP_MS = 800;    // 꺾이는 곳(가장자리)마다 멈춘다: 가장자리·모서리 표본을 확실히 얻는다
  const PURSUIT_SETTLE_MS = 400;  // 멈추거나 출발한 직후에는 눈이 아직 점을 못 따라가므로 표본을 버린다
  const MAX_LAG_MS = 300;         // 시선이 점보다 늦는 시간을 0~300ms 사이에서 찾는다
  // ㄹ자로 4줄을 훑는다: 고정 점 사이의 중간 위치에서도 표본을 얻는다
  const PURSUIT_PATH = [.05, .35, .65, .95].flatMap((y, row) =>
    row % 2 ? [[.95, y], [.05, y]] : [[.05, y], [.95, y]]);
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
  // 보정을 시작한 지 elapsed(ms) 뒤의 점 위치. 경로가 끝났으면 null
  function pursuitPoint(elapsed) {
    let time = elapsed;
    for (let i = 0; i < PURSUIT_PATH.length; i++) {
      const a = PURSUIT_PATH[i], b = PURSUIT_PATH[i + 1];
      // 꼭짓점에서 멈춰 있는 구간
      if (time < PURSUIT_STOP_MS) return {point: a, steady: time >= PURSUIT_SETTLE_MS};
      time -= PURSUIT_STOP_MS;
      if (!b) return null;
      // 다음 꼭짓점으로 일정한 속도로 움직이는 구간
      const duration = Math.hypot(b[0] - a[0], b[1] - a[1]) / PURSUIT_SPEED * 1000;
      if (time < duration) {
        const point = [0, 1].map(k => a[k] + (b[k] - a[k]) * time / duration);
        return {point, steady: time >= PURSUIT_SETTLE_MS};
      }
      time -= duration;
    }
    return null;
  }
  // 프레임 하나를 기록 {gaze, time}으로 바꾼다. time은 보정 시작부터 촬영까지(ms). 쓸 수 없으면 null
  function pursuitRecord(frame, now, startedAt) {
    if (!frame.valid || frame.closed || frame.closing || frame.eyesReady === false) return null;
    if (!Array.isArray(frame.gaze) || frame.gaze.length !== 2 || !frame.gaze.every(Number.isFinite)) return null;
    const age = frame.captureAgeMs ?? frame.inferenceMs ?? 0;
    if (!Number.isFinite(age) || age < 0 || age > 500) return null;
    // 결과가 도착한 때가 아니라 촬영한 때를 쓴다: 그사이 점이 이미 움직였기 때문
    return {gaze: frame.gaze, time: now - age - startedAt};
  }
  // 기록마다 lag(ms) 전의 점 위치를 짝지어 회귀 표본 {gaze, target}을 만든다
  function pairPursuit(records, lag) {
    const samples = [];
    for (const record of records) {
      const step = pursuitPoint(record.time - lag);
      if (step?.steady) samples.push({gaze: record.gaze, target: step.point});
    }
    return samples;
  }
  // 카메라 버퍼·눈의 반응 때문에 시선은 점보다 조금 늦다. 그 지연을 모르므로 회귀 오차가 가장 작은 지연을 고른다
  function fitPursuit(records) {
    let best = null;
    for (let lag = 0; lag <= MAX_LAG_MS; lag += 25) {
      const samples = pairPursuit(records, lag);
      if (samples.length < 9) continue;
      const error = regression(samples, 1).error;
      if (!best || error < best.error) best = {lag, error};
    }
    if (!best) throw new Error('보정 자료가 부족합니다.');
    const model = fit(pairPursuit(records, best.lag));
    model.lag = best.lag;
    return model;
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
  globalThis.GazeCore = {fit, predict, Blink, MouthClick, NearestSelector, MovingAverage, ExponentialSmoothing, FixationFilter, jitter, distanceToRect, PURSUIT_PATH, pursuitPoint, pursuitRecord, fitPursuit, average};
  if (typeof module !== 'undefined') module.exports = globalThis.GazeCore;
})();
