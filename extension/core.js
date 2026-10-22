(() => {
  if (globalThis.GazeCore) return;
  // NearestSelector 설정: 시연하면서 바꿔 볼 숫자는 여기 모아 둔다
  const DWELL_MS = 300;        // 같은 요소가 이 시간 이상 계속 1등이어야 선택 (머무름)
  const SWITCH_MARGIN_PX = 30; // 새 1등이 이만큼 더 가까워야 선택을 바꿈 (끈적임)
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
  function summarize(readings) {
    const valid = readings.filter(g => Array.isArray(g) && g.length === 2 && g.every(Number.isFinite));
    if (valid.length < 12) return {ready: false, count: valid.length, reason: 'collecting'};
    const center = [0, 1].map(k => median(valid.map(g => g[k])));
    const mad = [0, 1].map(k => Math.max(.001, 1.4826 * median(valid.map(g => Math.abs(g[k] - center[k])))));
    const kept = valid.filter(g => g.every((v, k) => Math.abs(v - center[k]) <= 3.5 * mad[k]));
    if (kept.length < 12) return {ready: false, count: kept.length, reason: 'collecting'};
    const gaze = [0, 1].map(k => median(kept.map(g => g[k])));
    const distances = kept.map(g => Math.hypot(...g.map((v, k) => v - gaze[k]))).sort((a, b) => a - b);
    const spread = distances[Math.floor((distances.length - 1) * .9)];
    // Compare consecutive groups: stationary model noise is different from drift.
    const centers = [0, 1, 2].map(group => {
      const block = kept.slice(Math.floor(group * kept.length / 3), Math.floor((group + 1) * kept.length / 3));
      return [0, 1].map(k => median(block.map(g => g[k])));
    });
    const drift = Math.max(...centers.flatMap(a => centers.map(b => Math.hypot(a[0] - b[0], a[1] - b[1]))));
    const quiet = spread <= .035 && drift <= .025;
    const averaged = kept.length >= 24 && spread <= .08 && drift <= .018;
    const ready = quiet || averaged;
    return {ready, count: kept.length, gaze, spread, drift,
      reason: ready ? 'ready' : spread <= .08 && drift <= .025 ? 'averaging' : 'unstable'};
  }
  class CalibrationCollector {
    constructor(shownAt) { this.shownAt = shownAt; this.readings = []; this.resumeAt = shownAt + 900; }
    add(frame, now) {
      const age = frame.captureAgeMs ?? frame.inferenceMs ?? 0;
      if (!frame.valid || frame.closed || frame.closing || frame.eyesReady === false) {
        this.resumeAt = now + 350;
        return {ready: false, count: this.readings.length, reason: 'eyes'};
      }
      if (!Number.isFinite(age) || age < 0 || age > 500 || now - age < Math.max(this.shownAt + 900, this.resumeAt)) {
        return {ready: false, count: this.readings.length, reason: 'settling'};
      }
      if (!Array.isArray(frame.gaze) || frame.gaze.length !== 2 || !frame.gaze.every(Number.isFinite)) {
        return {ready: false, count: this.readings.length, reason: 'invalid'};
      }
      this.readings.push({gaze: frame.gaze, time: now - age});
      this.readings = this.readings.filter(r => now - r.time <= 10000).slice(-48);
      const result = summarize(this.readings.map(r => r.gaze));
      if (this.readings.at(-1).time - this.readings[0].time < 1200) result.ready = false;
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
  function correctBias(model, observations) {
    if (observations.length !== 5) return null;
    const residuals = observations.map(s => s.target.map((v, k) => v - predict(model, s.gaze)[k]));
    if (!residuals.flat().every(Number.isFinite)) return null;
    const offset = [0, 1].map(k => median(residuals.map(r => r[k])));
    const scatter = residuals.map(r => Math.hypot(...r.map((v, k) => v - offset[k])));
    // Only correct a consistent translation. Fresh measurements must validate it.
    if (Math.hypot(...offset) > .3 || Math.max(...scatter) > .12 ||
        Math.sqrt(scatter.reduce((sum, v) => sum + v * v, 0) / scatter.length) > .07) return null;
    return {...model, offset: offset.map((v, k) => v + (model.offset?.[k] || 0))};
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
  globalThis.GazeCore = {fit, predict, correctBias, Blink, NearestSelector, distanceToRect, summarize, CalibrationCollector};
  if (typeof module !== 'undefined') module.exports = globalThis.GazeCore;
})();
