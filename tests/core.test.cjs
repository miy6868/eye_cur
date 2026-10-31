const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {Blink, MouthClick, NearestSelector, MovingAverage, ExponentialSmoothing, FixationFilter, jitter, fit, predict, distanceToRect, CALIBRATION_POINTS, CALIBRATION_ORDER, gazeRecord, medianGaze, fitPoints, correctDrift, eyeRange, eyeSize, suggest, textChange, scrollSpeed, mouthPhase, SETTINGS, configure} = require('../extension/core.js');
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

test('gaze records keep the capture time, not the arrival time', () => {
  // 3000ms에 도착했지만 200ms 전에 찍은 프레임. 점은 1000ms에 나타났다
  assert.deepEqual(gazeRecord({valid: true, gaze: [.1, .2], captureAgeMs: 200}, 3000, 1000), {gaze: [.1, .2], time: 1800});
  assert.equal(gazeRecord({valid: true, closed: true, gaze: [.1, .2]}, 3000, 0), null);
  assert.equal(gazeRecord({valid: true}, 3000, 0), null);
  assert.equal(gazeRecord({valid: true, gaze: [.1, .2], captureAgeMs: 900}, 3000, 0), null);
});

test('calibration visits each of the 9 points twice, forward then backward', () => {
  assert.equal(CALIBRATION_ORDER.length, 18);
  for (const index of CALIBRATION_POINTS.keys()) {
    const steps = CALIBRATION_ORDER.flatMap((value, step) => value === index ? [step] : []);
    // 두 번 본 차례의 평균이 모든 점에서 8.5로 같다
    assert.equal(steps.length, 2);
    assert.equal((steps[0] + steps[1]) / 2, 8.5);
  }
});

test('median of a point ignores a stray frame', () => {
  const records = [{gaze: [.1, .2]}, {gaze: [.1, .2]}, {gaze: [.9, -.5]}];
  assert.deepEqual(medianGaze(records), [.1, .2]);
});

// 9개 점을 order 순서로 보며, 차례마다 시선 값이 세로로 0.004씩 밀리는(드리프트) 상황
function driftingPoints(order) {
  const points = CALIBRATION_POINTS.map(target => ({target, medians: []}));
  order.forEach((index, step) => {
    const [x, y] = CALIBRATION_POINTS[index];
    points[index].medians.push([x * .4 - .2, y * .3 - .1 + step * .004]);
  });
  return points;
}

test('round trip turns slow drift into the same shift for every point', () => {
  // 왕복: 드리프트가 모든 점에 똑같이 더해져서 1차 회귀가 정확히 맞는다
  const roundTrip = fitPoints(driftingPoints(CALIBRATION_ORDER));
  assert.ok(roundTrip.crossError < 1e-9);
  // 같은 방향으로 두 바퀴: 늦게 본 점일수록 더 밀려 점 사이 관계가 틀어진다
  const forward = [...CALIBRATION_POINTS.keys()];
  const twice = fitPoints(driftingPoints([...forward, ...forward]));
  assert.ok(twice.crossError > .01);
});

test('point fit averages both passes and uses one pass when the other is missing', () => {
  const points = CALIBRATION_POINTS.map(([x, y]) => ({target: [x, y], medians: [[x * .4 - .2 + .01, y * .3 - .1], [x * .4 - .2 - .01, y * .3 - .1]]}));
  // 한 점은 눈을 감아 한 바퀴만 얻었다
  points[4].medians = [[.5 * .4 - .2, .5 * .3 - .1]];
  const model = fitPoints(points);
  const result = predict(model, [.3 * .4 - .2, .7 * .3 - .1]);
  assert.ok(Math.abs(result[0] - .3) < 1e-8 && Math.abs(result[1] - .7) < 1e-8);
  assert.equal(model.degree, 1);
});

test('a click moves the offset halfway toward the clicked element center', () => {
  // 요소 가운데 (500, 300), 예측 (460, 360): 가로 +40px, 세로 -60px 차이의 절반만큼
  const offset = correctDrift(undefined, [460, 360], [450, 280, 100, 40], [1000, 600]);
  assert.ok(Math.abs(offset[0] - .02) < 1e-9 && Math.abs(offset[1] + .05) < 1e-9);
  // 이어서 다시 고치면 기존 오프셋에 더해진다
  assert.ok(Math.abs(correctDrift(offset, [460, 360], [450, 280, 100, 40], [1000, 600])[0] - .04) < 1e-9);
  // 가로로 긴 링크(300px)는 어디를 봤는지 몰라 가로는 그대로, 세로만 고친다
  const wide = correctDrift([0, 0], [460, 360], [350, 280, 300, 40], [1000, 600]);
  assert.equal(wide[0], 0);
  assert.ok(Math.abs(wide[1] + .05) < 1e-9);
});

test('eye size warning uses the openness range seen during calibration', () => {
  // 보정 중 눈 열림 0.80~1.00 (가끔 튄 값 0.3, 1.3은 5~95% 범위 밖이라 무시)
  const range = eyeRange([.3, ...Array.from({length: 98}, (_, i) => .8 + .2 * i / 97), 1.3]);
  assert.ok(Math.abs(range[0] - .8) < .01 && Math.abs(range[1] - 1) < .01);
  assert.equal(eyeSize(.9, range), null);
  assert.equal(eyeSize(.77, range), null);   // 여유(0.05) 안
  assert.equal(eyeSize(.7, range), 'small');
  assert.equal(eyeSize(1.1, range), 'big');
  assert.equal(eyeSize(.5, undefined), null); // 예전 보정에는 범위가 없다
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

test('long mouth opening reports long even without a target (opens the menu)', () => {
  const m = new MouthClick();
  m.update({valid: true, mouthOpen: false, time: 0}, null);
  for (let time = 100; time <= 2600; time += 100) m.update({valid: true, mouthOpen: true, time}, null);
  assert.equal(m.update({valid: true, mouthOpen: false, time: 2700}, null), null);
  assert.equal(m.result, 'long');
});

test('mouthPhase tells what closing the mouth would do now', () => {
  assert.equal(mouthPhase(300), 'wait');
  assert.equal(mouthPhase(500), 'click');
  assert.equal(mouthPhase(2000), 'click');
  assert.equal(mouthPhase(2100), 'menu');
});

test('configure takes config.toml values of the right type and click timing follows them', () => {
  const saved = structuredClone(SETTINGS);
  try {
    configure({click: {mouth_min_ms: 300, mouth_max_ms: '9', mode: 'eyes'}, select: {dwell_ms: NaN}, unknown: {x: 1}});
    assert.equal(SETTINGS.click.mouth_min_ms, 300);
    assert.equal(SETTINGS.click.mouth_max_ms, 2000); // 글자로 온 숫자는 받지 않는다
    assert.equal(SETTINGS.click.mode, 'eyes');
    assert.equal(SETTINGS.select.dwell_ms, 300);
    assert.equal(mouthPhase(350), 'click');
  } finally { configure(saved); }
  assert.equal(mouthPhase(350), 'wait');
});

test('suggest matches by jamo prefix, typed syllables first, and skips the exact word', () => {
  const entries = [['하고', 'ㅎㅏㄱㅗ'], ['학교', 'ㅎㅏㄱㄱㅛ'], ['학', 'ㅎㅏㄱ'], ['하나', 'ㅎㅏㄴㅏ'], ['you', 'you']].map(([word, key]) => ({word, key}));
  assert.deepEqual(suggest(entries, 'ㅎㅏㄱ', '학'), ['학교', '하고']); // '학'으로 시작하는 단어가 먼저
  assert.deepEqual(suggest(entries, 'ㅎ', 'ㅎ', 2), ['하고', '학교']);
  assert.deepEqual(suggest(entries, '', ''), []);
  assert.deepEqual(suggest(entries, 'yo', 'yo'), ['you']);
});

test('textChange removes only the changed tail of the composing text', () => {
  assert.deepEqual(textChange('', 'ㅇ'), {remove: 0, insert: 'ㅇ'});
  assert.deepEqual(textChange('ㅇ', '아'), {remove: 1, insert: '아'});
  assert.deepEqual(textChange('안', '아나'), {remove: 1, insert: '아나'});
  assert.deepEqual(textChange('안녕', '안녀'), {remove: 1, insert: '녀'});
  assert.deepEqual(textChange('hel', 'hello '), {remove: 0, insert: 'lo '});
});

test('scrollSpeed is zero in the middle and faster toward the edges', () => {
  assert.equal(scrollSpeed(.5), 0);
  assert.ok(scrollSpeed(.2) < 0 && scrollSpeed(.8) > 0);
  assert.ok(scrollSpeed(0) < scrollSpeed(.2));
  assert.equal(scrollSpeed(-.1), scrollSpeed(0)); // 화면 밖은 최고 속도로 자른다
  assert.equal(scrollSpeed(1), -scrollSpeed(0));
});

test('core.js default settings match config.toml (the two must change together)', () => {
  // 작은 TOML 읽기: [섹션] 아래 '키 = 숫자 또는 "글자"' 줄만 본다
  let section; const toml = {};
  for (const line of fs.readFileSync('config.toml', 'utf8').split('\n')) {
    const head = line.match(/^\[(\w+)\]/);
    if (head) { section = toml[head[1]] = {}; continue; }
    const pair = line.match(/^(\w+)\s*=\s*("[^"]*"|[\d.]+)/);
    if (pair && section) section[pair[1]] = JSON.parse(pair[2]);
  }
  for (const [name, keys] of Object.entries(SETTINGS)) assert.deepEqual(keys, toml[name], name);
});
