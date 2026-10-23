const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Blink, MouthClick, NearestSelector, MovingAverage, ExponentialSmoothing, FixationFilter, jitter, fit, predict, distanceToRect, summarize, CalibrationCollector} = require('../extension/core.js');
const frame = (time, closed = false, valid = true) => ({time, closed, valid});

test('ordinary blink does not click', () => {
  const b = new Blink();
  b.update(frame(0), 'a'); b.update(frame(100, true), 'a');
  assert.equal(b.update(frame(250), 'b'), null);
});

test('deliberate 1.6 second closure clicks on reopening', () => {
  const b = new Blink(); b.update(frame(0), 'last');
  for (const time of [100, 400, 700, 1000, 1300, 1600]) b.update(frame(time, true), 'last');
  assert.equal(b.update(frame(1700), 'last'), 'last');
});

test('target freezes at eyelid descent before gaze shifts or eyes fully close', () => {
  const b = new Blink(); b.update(frame(0), 'a');
  b.update({...frame(100), closing: true}, 'a');
  assert.equal(b.active, true);
  b.update({...frame(150), closing: true}, 'wrong');
  b.update(frame(200, true), 'wrong');
  b.update(frame(500, true), null); b.update(frame(800, true), null);
  assert.equal(b.update(frame(900), 'wrong'), 'a');
  assert.equal(b.active, false);
});

test('prolonged squint cannot arm a stale target', () => {
  const b = new Blink(); b.update(frame(0), 'a');
  for (const time of [100, 350, 650]) b.update({...frame(time), closing: true}, 'a');
  b.update(frame(700, true), 'a'); b.update(frame(1000, true), 'a'); b.update(frame(1300, true), 'a');
  assert.equal(b.update(frame(1400), 'a'), null);
  assert.equal(b.result, 'no-target');
});
test('long blink clicks the pre-close target once, with cooldown', () => {
  const b = new Blink(); b.update(frame(0), 'a');
  b.update(frame(100, true), 'a'); b.update(frame(400, true), 'b'); b.update(frame(700, true), 'b');
  assert.equal(b.update(frame(900), 'b'), 'a');
  assert.equal(b.update(frame(1000), 'b'), null);
  b.update(frame(1050, true), 'b'); b.update(frame(1300, true), 'b');
  assert.equal(b.update(frame(1650), 'b'), null);
});
test('face loss, frame gaps, unselected targets and overly long closure cancel clicks', () => {
  for (const scenario of ['lost', 'gap', 'none', 'long']) {
    const b = new Blink(); b.update(frame(0), 'a');
    b.update(frame(100, true), scenario === 'none' ? null : 'a');
    b.update(frame(400, true), 'a');
    if (scenario === 'lost') b.update(frame(500, false, false), 'a');
    if (scenario === 'gap') { assert.equal(b.update(frame(1000), 'a'), null); continue; }
    b.update(frame(700, true), 'a');
    if (scenario === 'long') {
      b.update(frame(1000, true), 'a'); b.update(frame(1300, true), 'a');
      b.update(frame(1600, true), 'a'); b.update(frame(1900, true), 'a');
      assert.equal(b.update(frame(2200), 'a'), null);
    } else assert.equal(b.update(frame(850), 'a'), null);
  }
});
test('affine calibration recovers held-out positions', () => {
  const samples = [];
  for (const x of [.15, .5, .85]) for (const y of [.15, .5, .85]) samples.push({gaze: [x * .4 - .2, y * .3 - .1], target: [x, y]});
  const model = fit(samples), result = predict(model, [.4 * .3 - .2, .3 * .7 - .1]);
  assert.ok(Math.abs(result[0] - .3) < 1e-8 && Math.abs(result[1] - .7) < 1e-8);
  assert.throws(() => fit(samples.map(s => ({...s, gaze: [0, 0]}))));
});
test('distance uses element boundary, not only its center', () => {
  assert.equal(distanceToRect(30, 30, [10, 10, 100, 40]), 0);
  assert.equal(distanceToRect(120, 30, [10, 10, 100, 40]), 10);
});

test('calibration rejects sparse readings but removes isolated outliers', () => {
  const steady = Array.from({length: 14}, (_, i) => [.1 + (i % 3 - 1) * .001, -.2]);
  assert.equal(summarize(steady.slice(0, 5)).ready, false);
  const result = summarize([...steady, [.9, .8], [-.6, -.7]]);
  assert.equal(result.ready, true);
  assert.ok(Math.abs(result.gaze[0] - .1) < .002);
  assert.equal(result.count, 14);
});
test('CPU-delayed frames from the previous point are excluded', () => {
  const c = new CalibrationCollector(1000);
  // Arrives after settling but was captured before settling finished.
  c.add({valid: true, gaze: [4, 4], captureAgeMs: 400}, 1900);
  assert.equal(c.readings.length, 0);
  let result;
  for (let i = 0; i < 14; i++) result = c.add({valid: true, gaze: [.1, .2], captureAgeMs: 120}, 2200 + i * 150);
  assert.equal(result.ready, true);
  assert.deepEqual(result.gaze, [.1, .2]);
});
test('closed eyes and immediate reopening do not enter calibration data', () => {
  const c = new CalibrationCollector(0);
  c.add({valid: true, closed: true}, 1500);
  c.add({valid: true, gaze: [.5, .5], captureAgeMs: 100}, 1900);
  assert.equal(c.readings.length, 0);
  c.add({valid: true, gaze: [.1, .2], captureAgeMs: 100}, 2000);
  assert.equal(c.readings.length, 1);
});

test('each point collects for a fixed 1 second, then uses the median', () => {
  const collector = new CalibrationCollector(0);
  let result;
  // 0.6초 안정화 뒤부터 0.1초마다 표본. 1초가 안 됐으면 표본이 충분해도 기다린다
  for (let i = 0; i < 10; i++) result = collector.add({valid: true, gaze: [.1 + (i % 2 ? .04 : -.04), .2]}, 600 + i * 100);
  assert.equal(result.ready, false);
  result = collector.add({valid: true, gaze: [.1, .2]}, 1600);
  assert.equal(result.ready, true);
  assert.ok(Math.abs(result.gaze[0] - .1) < 1e-8);
});

test('slow CPU sampling waits until the minimum sample count', () => {
  const collector = new CalibrationCollector(0);
  let result;
  for (let i = 0; i < 5; i++) result = collector.add({valid: true, gaze: [.1, .2], captureAgeMs: 200}, 1200 + i * 600);
  assert.equal(result.ready, false);
  result = collector.add({valid: true, gaze: [.1, .2], captureAgeMs: 200}, 1200 + 5 * 600);
  assert.equal(result.ready, true);
  assert.equal(result.count, 6);
});

test('eye-only frames and short face loss preserve collected calibration samples', () => {
  const collector = new CalibrationCollector(0);
  for (let i = 0; i < 6; i++) collector.add({valid: true, gaze: [.1, .2]}, 1000 + i * 200);
  for (let i = 0; i < 10; i++) collector.add({valid: true}, 2050 + i * 20);
  collector.add({valid: false}, 2300);
  assert.equal(collector.readings.length, 6);
  let result;
  for (let i = 0; i < 6; i++) result = collector.add({valid: true, gaze: [.1, .2]}, 2700 + i * 200);
  assert.equal(result.ready, true);
  assert.equal(result.count, 12);
});

test('16-point calibration selects nonlinearity only when held-out points improve', () => {
  const mapping = ([x, y]) => [.5 + .8*x + .25*y*y, .5 + .8*y + .2*x*y];
  const samples = [-.4, -.15, .15, .4].flatMap(x => [-.4, -.15, .15, .4].map(y => ({gaze: [x, y], target: mapping([x, y])})));
  const model = fit(samples);
  assert.equal(model.degree, 2);
  for (const gaze of [[-.25, .1], [.2, -.3], [0, 0]]) {
    assert.ok(Math.hypot(...predict(model, gaze).map((v, k) => v - mapping(gaze)[k])) < .005);
  }
  const linear = fit(samples.map(s => ({gaze: s.gaze, target: s.gaze.map(v => .5 + v)})));
  assert.equal(linear.degree, 1);
});

// NearestSelector: 후보는 GazeDOM.collect처럼 거리순으로 넣는다
const near = (id, distance) => ({id, distance});

test('NearestSelector picks the closest candidate after dwelling', () => {
  const s = new NearestSelector();
  s.update([near('a', 5), near('b', 50)], 0);
  assert.equal(s.update([near('a', 5), near('b', 50)], 300).id, 'a');
});

test('NearestSelector does not select before 0.3 seconds', () => {
  const s = new NearestSelector();
  assert.equal(s.update([near('a', 5)], 0), null);
  assert.equal(s.update([near('a', 5)], 299), null);
});

test('NearestSelector keeps the selection unless the new leader is 30px closer', () => {
  const s = new NearestSelector();
  s.update([near('a', 0)], 0); s.update([near('a', 0)], 300);
  // b가 1등이지만 20px 차이뿐이라 0.3초가 지나도 a를 유지
  s.update([near('b', 0), near('a', 20)], 400);
  assert.equal(s.update([near('b', 0), near('a', 20)], 800).id, 'a');
  // 30px 이상 차이가 나면 b로 바뀜
  assert.equal(s.update([near('b', 0), near('a', 30)], 900).id, 'b');
});

test('MovingAverage averages only the last size points', () => {
  const f = new MovingAverage(3);
  assert.deepEqual(f.update([0, 0]), [0, 0]);
  assert.deepEqual(f.update([3, 6]), [1.5, 3]);
  f.update([6, 12]);
  // [0, 0]은 창 밖으로 밀려나 (3+6+9)/3, (6+12+18)/3
  assert.deepEqual(f.update([9, 18]), [6, 12]);
});

test('ExponentialSmoothing mixes new and previous values by alpha', () => {
  const f = new ExponentialSmoothing(0.45);
  assert.deepEqual(f.update([100, 0]), [100, 0]);
  const [x, y] = f.update([200, 100]);
  assert.ok(Math.abs(x - 145) < 1e-9 && Math.abs(y - 45) < 1e-9);
});

test('filters forget old points after reset', () => {
  const average = new MovingAverage(5), smooth = new ExponentialSmoothing(0.45);
  average.update([100, 100]); smooth.update([100, 100]);
  average.reset(); smooth.reset();
  assert.deepEqual(average.update([10, 20]), [10, 20]);
  assert.deepEqual(smooth.update([10, 20]), [10, 20]);
});

test('FixationFilter averages a fixation and ignores one stray point', () => {
  const f = new FixationFilter(120, 3, 30);
  f.update([100, 100]);
  f.update([140, 100]);
  // 한 번 멀리 튄 점은 무시하고 기존 응시 평균을 유지한다
  assert.deepEqual(f.update([600, 100]), [120, 100]);
  assert.deepEqual(f.update([120, 100]), [120, 100]);
});

test('FixationFilter jumps after 3 nearby far points, not after scattered noise', () => {
  const f = new FixationFilter(120, 3, 30);
  f.update([100, 100]);
  // 서로 먼 방향으로 튄 점 3개는 시선 이동이 아니다
  f.update([600, 100]);
  f.update([100, 600]);
  assert.deepEqual(f.update([-400, 100]), [100, 100]);
  // 같은 곳에 3번 연속 오면 바로 새 위치로 옮긴다
  f.update([800, 500]);
  f.update([820, 500]);
  assert.deepEqual(f.update([840, 500]), [820, 500]);
});

test('FixationFilter keeps only the last maxPoints points', () => {
  const f = new FixationFilter(120, 3, 2);
  f.update([0, 0]);
  f.update([10, 0]);
  assert.deepEqual(f.update([20, 0]), [15, 0]);
  f.reset();
  assert.deepEqual(f.update([500, 500]), [500, 500]);
});

test('jitter is the standard deviation of points in pixels', () => {
  assert.equal(jitter([[5, 5]]), 0);
  assert.equal(jitter([[0, 0], [6, 8]]), 5);
});

// MouthClick: 0.1초마다 프레임이 오고, open초 동안 벌렸다가 다문다
function mouthClick(openSeconds) {
  const m = new MouthClick();
  m.update({valid: true, mouthOpen: false, time: 0}, 'a');
  for (let time = 100; time <= 100 + openSeconds * 1000; time += 100) m.update({valid: true, mouthOpen: true, time}, 'a');
  return {m, clicked: m.update({valid: true, mouthOpen: false, time: 200 + openSeconds * 1000}, 'b')};
}

test('MouthClick ignores a 0.2 second opening like speech', () => {
  const {m, clicked} = mouthClick(0.2);
  assert.equal(clicked, null);
  assert.equal(m.result, 'short');
});

test('MouthClick clicks the target fixed when the mouth opened after 1 second', () => {
  const {m, clicked} = mouthClick(1);
  assert.equal(clicked, 'a');
  // 0.8초 쿨다운 안에 다시 벌렸다 다물어도 클릭하지 않는다
  for (let time = 1300; time <= 1900; time += 100) m.update({valid: true, mouthOpen: true, time}, 'a');
  assert.equal(m.update({valid: true, mouthOpen: false, time: 1950}, 'a'), null);
  assert.equal(m.result, 'cooldown');
});

test('MouthClick cancels an opening longer than 2 seconds', () => {
  const {m, clicked} = mouthClick(2.5);
  assert.equal(clicked, null);
  assert.equal(m.result, 'long');
});
