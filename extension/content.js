(() => {
  if (globalThis.__gazeInstalled) return;
  globalThis.__gazeInstalled = true;
  // false: 서버(Jev API) 대신 직접 만든 NearestSelector로 대상을 고른다. API 키가 없어도 동작한다.
  const USE_JEV = false;
  // 클릭 방식: 'mouth' = 입 벌리기 클릭(기본), 'eyes' = 기존 양눈 감기 클릭
  const CLICK_MODE = 'mouth';
  const CLICK_HINT = CLICK_MODE === 'mouth' ? '입을 0.5~2.0초 벌렸다 다무세요' : '양눈을 0.6~2.0초 감았다 뜨세요';
  const {fit, predict, correctBias, Blink, MouthClick, NearestSelector, MovingAverage, ExponentialSmoothing, jitter, CalibrationCollector} = globalThis.GazeCore;
  const nearest = new NearestSelector();
  // F 키로 순환하는 떨림 제거 필터. '끔'이면 원본 점을 그대로 쓴다
  const filterChoices = [
    {name: '끔', create: () => null},
    {name: '이동평균(5)', create: () => new MovingAverage(5)},
    {name: '지수평균(0.45)', create: () => new ExponentialSmoothing(0.45)},
    // 강한 필터: 시선 값이 초당 약 9번 오므로 둘 다 약 1초 분량을 섞는다. 떨림은 줄지만 커서가 늦게 따라온다
    {name: '이동평균 강(10)', create: () => new MovingAverage(10)},
    {name: '지수평균 강(0.2)', create: () => new ExponentialSmoothing(0.2)},
  ];
  let filterIndex = 2; // 기존 동작(0.55/0.45 지수평균)과 같게 시작
  let filter = filterChoices[filterIndex].create();
  let trail = []; // 최근 3초의 {raw, filtered, time}: 떨림 계산과 그래프용
  const GRAPH_MS = 3000;
  const JITTER_MS = 1500;
  const trainingPoints = [.04, .35, .65, .96].flatMap((y, row) =>
    (row % 2 ? [.96, .65, .35, .04] : [.04, .35, .65, .96]).map(x => [x, y]));
  const validationPoints = [[.06, .06], [.94, .06], [.94, .94], [.06, .94], [.5, .5]];
  const calibrationPoints = [...trainingPoints, ...validationPoints];
  const trainingCount = trainingPoints.length, validationCount = validationPoints.length;
  let currentContext;
  let running = false, host, shadow, model, calibration, smooth, clicker;
  let selected = null, pending = null, requestNumber = 0, lastRequest = 0;
  let lastFrame = 0, history = [], timer, layout, lastStatus = '';
  let ids = new WeakMap(), idNumber = 0;

  function send(message) { return chrome.runtime.sendMessage({...message, context: currentContext}).catch(() => {}); }
  function status(text) {
    if (!shadow || lastStatus === text) return;
    lastStatus = text;
    shadow.querySelector('#status').textContent = text;
    send({type: 'uiStatus', message: text});
  }
  function invalidate() {
    selected = null; pending = null; history = []; resetFilter();
    requestNumber++; clicker?.reset();
    nearest.reset(); // 스크롤·탭 이동 뒤에는 머무름을 처음부터 다시 잰다
    if (shadow) shadow.querySelector('#target').hidden = true;
  }
  function end(message) {
    running = false; clearInterval(timer); invalidate();
    if (shadow && message) {
      status(message);
      shadow.querySelector('#veil').hidden = true;
      hideCursor();
      shadow.querySelector('#stop').hidden = true;
      shadow.querySelector('#recalibrate').hidden = true;
      const notice = host;
      setTimeout(() => notice?.remove(), 8000);
      host = null; shadow = null;
      return;
    }
    host?.remove(); host = null; shadow = null;
  }
  function stop(message) { end(message); send({type: 'stop', reason: message}); }
  function geometry() { return [innerWidth, innerHeight, screenX, screenY, devicePixelRatio, visualViewport?.scale || 1].join(','); }
  function start(message = {}) {
    end(); currentContext = message.context; running = true; model = null; resetFilter(); clicker = CLICK_MODE === 'mouth' ? new MouthClick() : new Blink();
    ids = new WeakMap(); idNumber = 0; lastStatus = ''; lastFrame = performance.now();
    lastRequest = 0; layout = geometry();
    const saved = message.calibration;
    if (saved?.layout === layout) model = saved.model;
    else if (saved) send({type: 'calibrationInvalid'});
    calibration = model ? null : {index: 0, collector: null, samples: [], validation: [], retries: 0};
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    shadow = host.attachShadow({mode: 'closed'});
    shadow.innerHTML = `
      <style>
      :host{all:initial}*{box-sizing:border-box}[hidden]{display:none!important}
      #veil{position:fixed;inset:0;background:#0c1728f5;pointer-events:auto}
      #use{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);padding:12px 22px;font:600 16px system-ui;background:#21dba0;color:#071b2a}
      #dot{position:fixed;width:26px;height:26px;border:5px solid #fff;border-radius:50%;background:#32dba0;transform:translate(-50%,-50%);box-shadow:0 0 0 14px #32dba029}
      #guide{position:fixed;top:24px;left:50%;transform:translateX(-50%);font:16px/1.5 system-ui;color:#fff;text-align:center}
      #panel{position:fixed;bottom:14px;left:14px;max-width:520px;border:1px solid #ffffff24;background:#142236;color:#fff;border-radius:9px;padding:10px 14px;font:13px/1.5 system-ui;display:flex;flex-wrap:wrap;gap:12px;align-items:center}
      button{pointer-events:auto;white-space:nowrap;border:0;border-radius:5px;padding:6px 9px;background:#33465e;color:#fff;cursor:pointer}
      #raw{position:fixed;width:6px;height:6px;border-radius:50%;background:#ff3b3b;transform:translate(-50%,-50%)}
      #graph{background:#0c1728;border-radius:4px}
      #cursor{position:fixed;width:12px;height:12px;border:2px solid #fff;border-radius:50%;background:#176cff;transform:translate(-50%,-50%)}
      #target{position:fixed;border:3px solid #21dba0;border-radius:5px;background:#21dba01a;box-shadow:0 0 0 2px #071b2a99}
      </style>
      <div id="veil"><div id="guide">머리를 고정하고 초록 점을 바라보세요.<br>보정은 자동으로 진행됩니다.</div><div id="dot"></div><button id="use" hidden>그래도 사용</button></div>
      <div id="raw" hidden></div><div id="cursor" hidden></div><div id="target" hidden></div>
      <div id="panel"><span id="eyes">눈 상태 준비 중</span><span id="mouth"></span><span id="status"></span><span id="filter"></span><span id="jitter"></span><canvas id="graph" width="200" height="50"></canvas><button id="recalibrate">다시 보정</button><button id="stop">중지 · ESC</button></div>`;
    document.documentElement.appendChild(host);
    shadow.querySelector('#stop').onclick = () => stop('중지됨');
    shadow.querySelector('#recalibrate').onclick = () => send({type: 'recalibrate'});
    shadow.querySelector('#use').onclick = () => finishCalibration(calibration.result);
    showFilterName();
    if (calibration) { placeDot(); status('16점 정밀 보정 · 카메라 연결 대기 중…'); }
    else { shadow.querySelector('#veil').hidden = true; status('보정 유지 · 이 탭에서 계속합니다.'); }
    timer = setInterval(() => {
      if (!running) return;
      if (geometry() !== layout) { send({type: 'calibrationInvalid'}); start({context: currentContext}); return; }
      if (performance.now() - lastFrame > 500) {
        invalidate(); hideCursor();
        if (calibration) calibration.collector.resumeAt = performance.now() + 350;
      }
      if (pending && performance.now() - pending.sent > 1800) {
        pending = null; requestNumber++;
        if (!clicker.active) status('Jev 응답 지연 · 선택 보류');
      }
    }, 100);
  }
  function placeDot() {
    const point = calibrationPoints[calibration.index];
    const dot = shadow.querySelector('#dot');
    dot.style.left = `${point[0] * 100}vw`; dot.style.top = `${point[1] * 100}vh`;
    calibration.collector = new CalibrationCollector(performance.now());
  }
  function calibrate(frame, now) {
    const result = calibration.collector.add(frame, now);
    // Eye-only frames arrive much faster than CPU gaze results. Keep progress visible.
    if (result.reason === 'invalid' && now - calibration.collector.shownAt < 15000) return;
    const label = calibration.index < trainingCount ? `시선 보정 ${calibration.index + 1}/${trainingCount}` : `${calibration.refined ? '추가 보정 검증' : '보정 검증'} ${calibration.index - trainingCount + 1}/${validationCount}`;
    const progress = result.reason === 'unstable' ? `모델 출력 변화 확인 중 · 표본 ${result.count}` :
      result.reason === 'averaging' ? `모델 잡음 평균화 중 · 표본 ${result.count}/24` :
      result.reason === 'eyes' ? '눈을 뜬 상태의 표본 대기 중' :
      result.reason === 'invalid' ? 'CPU 시선 결과 대기 중' : `표본 ${result.count}/12 이상 수집 중`;
    status(`${label} · ${progress} · 초록 점을 보세요`);
    if (!result.ready) {
      if (now - calibration.collector.shownAt > 15000) {
        if (calibration.retries++ < 1) {
          placeDot(); status(`${label} · 이 점을 다시 측정합니다.`);
        } else calibrationFailed(`${label}: 사용할 시선 표본을 충분히 모으지 못했습니다. CPU 추론 지연이나 모델 출력 변화가 원인일 수 있으며, 실제 눈 움직임을 뜻하지는 않습니다.`);
      }
      return;
    }
    const gaze = result.gaze;
    const target = calibrationPoints[calibration.index];
    if (calibration.index >= trainingCount) {
      const delta = predict(model, gaze).map((v, k) => v - target[k]);
      const error = Math.hypot(...delta);
      const pixels = Math.round(Math.hypot(delta[0] * innerWidth, delta[1] * innerHeight));
      if (!Number.isFinite(error)) { calibrationFailed('시선 좌표 계산에 실패했습니다. 다시 보정해 주세요.'); return; }
      if (error > .18) {
        if (calibration.retries++ < 1) { placeDot(); status(`검증 오차 ${pixels}px · 이 점을 한 번 더 측정합니다.`); return; }
      }
      calibration.validation.push({error, pixels, gaze, target});
      if (calibration.index === calibrationPoints.length - 1) {
        const rms = Math.sqrt(calibration.validation.reduce((sum, v) => sum + v.error ** 2, 0) / validationCount);
        const pixelRms = Math.round(Math.sqrt(calibration.validation.reduce((sum, v) => sum + v.pixels ** 2, 0) / validationCount));
        if (rms > .15 || calibration.validation.some(v => v.error > .18)) {
          const corrected = !calibration.refined && correctBias(model, calibration.validation);
          if (corrected) {
            model = corrected; calibration.refined = true; calibration.validation = [];
            calibration.index = trainingCount; calibration.retries = 0; placeDot();
            status('일정한 위치 편향을 추가 보정했습니다. 새 표본으로 5점을 다시 검증합니다.');
            return;
          }
          const worst = Math.max(...calibration.validation.map(v => v.pixels));
          // 학습은 끝났으니 버리지 않고, 오차를 보여 준 뒤 사용자가 계속할지 고르게 한다
          calibration.result = {rms, pixelRms};
          const message = `검증 평균 ${pixelRms}px · 최대 ${worst}px로 기준보다 큽니다. 그래도 사용하거나 다시 보정하세요.`;
          shadow.querySelector('#guide').textContent = message;
          shadow.querySelector('#dot').hidden = true;
          shadow.querySelector('#use').hidden = false;
          status(message);
          return;
        }
        finishCalibration({rms, pixelRms});
        return;
      }
    } else calibration.samples.push({gaze, target});
    if (calibration.index === trainingCount - 1) {
      try {
        model = fit(calibration.samples);
        if (model.error > .15) throw new Error(`보정 점과 시선 출력의 대응 오차 ${(model.error * 100).toFixed(1)}%. 머리 움직임 외에 입력 영상·모델 오차가 원인일 수 있습니다.`);
      } catch (error) { calibrationFailed(error.message); return; }
    }
    calibration.index++; calibration.retries = 0; placeDot();
  }
  function finishCalibration({rms, pixelRms}) {
    // 검증 오차만큼 후보 탐색 반경도 넓어지도록 모델 오차에 반영한다
    model.error = Math.max(model.error, rms);
    calibration = null; shadow.querySelector('#veil').hidden = true;
    send({type: 'calibrated', model, layout});
    status(`준비됨 · ${model.degree === 2 ? '비선형' : '선형'} 보정 · 검증 오차 ${pixelRms}px · ${CLICK_HINT}.`);
  }
  function calibrationFailed(message) {
    running = false; clearInterval(timer); invalidate();
    shadow.querySelector('#guide').textContent = message;
    shadow.querySelector('#dot').hidden = true;
    status(message);
    // Keep the session/camera alive so the retry button can start calibration again.
    send({type: 'calibrationInvalid'});
  }
  function candidates(x, y) {
    const radius = Math.max(100, Math.min(240, (model.error + .06) * Math.min(innerWidth, innerHeight) * 2));
    return GazeDOM.collect(x, y, radius, element => {
      if (!ids.has(element)) ids.set(element, `e${++idNumber}`);
      return ids.get(element);
    });
  }
  function showTarget(item) {
    const target = shadow.querySelector('#target');
    if (!item) { target.hidden = true; return; }
    const [x, y, w, h] = item.rect;
    Object.assign(target.style, {left: `${x - 3}px`, top: `${y - 3}px`, width: `${w + 6}px`, height: `${h + 6}px`});
    target.hidden = false;
  }
  function click(item) {
    if (!document.hasFocus() || document.hidden || !GazeDOM.unchanged(item)) {
      invalidate(); status('대상이 바뀌어 클릭을 취소했습니다.'); return;
    }
    const element = item.element;
    invalidate();
    element.focus({preventScroll: true}); element.click();
    status('클릭 완료');
  }
  function frame(message) {
    if (!running) return;
    const now = performance.now(); lastFrame = now;
    shadow.querySelector('#eyes').textContent = !message.valid ? '눈 추적 끊김' : message.eyesReady === false ? '눈 뜬 상태 학습 중' : message.closed ? '양눈 감음' : message.closing ? '눈 감는 중' : '눈 뜸';
    if (Number.isFinite(message.openness)) shadow.querySelector('#eyes').textContent += ` · 눈 열림 ${Math.round(message.openness * 100)}%`;
    // 문턱값(벌림 > 0.30, 다뭄 < 0.20)을 맞출 수 있게 MAR 값을 그대로 보여 준다
    const mar = Number.isFinite(message.mar) ? message.mar.toFixed(2) : '-';
    shadow.querySelector('#mouth').textContent = `입 ${message.mouthOpen ? '벌림' : '다뭄'} · MAR ${mar}`;
    if (!document.hasFocus() || document.hidden || !message.valid) {
      invalidate(); hideCursor();
      if (calibration) calibration.collector.resumeAt = now + 350;
      status(!message.valid ? (message.error || '얼굴을 찾는 중… 카메라를 바라보세요.') : '페이지로 돌아오면 계속합니다.');
      return;
    }
    if (calibration?.result) return; // '그래도 사용' 버튼을 기다리는 중
    if (calibration) { calibrate(message, now); return; }
    if (!model) return;
    if (selected && !GazeDOM.unchanged(selected)) invalidate();
    const clicked = clicker.update(message, selected);
    if (clicker.active) {
      showTarget(selected);
      if (CLICK_MODE === 'mouth') mouthStatus(message.time);
      else if (clicker.started === null) status(selected ? '눈 감기 시작 · 클릭 대상 고정' : '선택된 대상 없음 · 먼저 초록 테두리를 확인하세요.');
      else {
        const elapsed = message.time - clicker.started;
        status(!selected ? '눈 감기 감지됨 · 선택된 대상이 없어 클릭하지 않습니다.' : elapsed <= 2000 ? `대상 고정 · 눈 감기 ${(elapsed / 1000).toFixed(1)}초 · 0.6~2.0초 안에 뜨세요` : '너무 오래 감음 · 클릭 취소');
      }
      return;
    }
    if (clicked) { click(clicked); return; }
    if (CLICK_MODE === 'mouth') mouthResult();
    else if (clicker.result === 'no-target') status('눈 감기는 인식됐지만 선택된 대상이 없습니다.');
    else if (clicker.result === 'short') status('짧은 깜빡임 · 클릭하려면 0.6초 이상 감아 주세요.');
    else if (clicker.result === 'long') status('2초를 넘겨 클릭을 취소했습니다.');
    if (!message.gaze) return;
    const point = predict(model, message.gaze);
    if (point.some(v => !Number.isFinite(v))) {
      pending = null; requestNumber++; history = []; resetFilter();
      hideCursor(); return;
    }
    if (point.some(v => v < -.1 || v > 1.1)) {
      pending = null; requestNumber++; history = []; resetFilter();
      hideCursor(); return;
    }
    const xy = [point[0] * innerWidth, point[1] * innerHeight];
    // 필터를 끈 상태면 원본 점을 그대로 쓴다. 대상 선택에는 이 필터 결과(smooth)를 쓴다
    smooth = filter ? filter.update(xy) : xy;
    showDot('#raw', xy);
    showDot('#cursor', smooth);
    trail.push({raw: xy, filtered: smooth, time: now});
    trail = trail.filter(p => now - p.time < GRAPH_MS);
    showJitter(now);
    drawGraph(now);
    history.push({x: Math.round(smooth[0]), y: Math.round(smooth[1]), time: now});
    history = history.filter(p => now - p.time < 1200).slice(-8);
    if (!USE_JEV) { chooseNearest(now); return; }
    const stable = history.slice(-3);
    if (pending || now - lastRequest < 400 || stable.length < 3 || now - stable[0].time < 200) return;
    if (stable.some(p => Math.hypot(p.x - smooth[0], p.y - smooth[1]) > 65)) return;
    const items = candidates(...smooth);
    if (!items.length) { status(selected ? `마지막 선택 유지: ${selected.name || selected.role}` : '시선 주변에 클릭 가능한 요소가 없습니다.'); return; }
    lastRequest = now;
    pending = {requestId: ++requestNumber, sent: now, items, gaze: [...smooth]};
    send({type: 'choose', requestId: pending.requestId, gaze: smooth.map(Math.round),
      history: history.map(p => ({x: p.x, y: p.y, ageMs: Math.round(now - p.time)})),
      candidates: items.map(({element, href, ...data}) => data)});
    if (!selected) status('Jev가 클릭 대상을 고르는 중…');
  }
  function mouthStatus(time) {
    const elapsed = time - clicker.started;
    if (!clicker.target) status('입 벌림 감지 · 선택된 대상이 없어 클릭하지 않습니다.');
    else if (elapsed <= 2000) status(`대상 고정 · 입 벌림 ${(elapsed / 1000).toFixed(1)}초 · 0.5~2.0초 안에 다무세요`);
    else status('너무 오래 벌림 · 클릭 취소');
  }
  function mouthResult() {
    if (clicker.result === 'no-target') status('입 벌림은 인식됐지만 선택된 대상이 없습니다.');
    else if (clicker.result === 'short') status('짧게 벌림(말하기 등)은 무시합니다 · 클릭하려면 0.5초 이상 벌려 주세요.');
    else if (clicker.result === 'long') status('2초를 넘겨 클릭을 취소했습니다.');
  }
  function resetFilter() {
    smooth = null;
    filter?.reset();
    trail = [];
  }
  function hideCursor() {
    shadow.querySelector('#cursor').hidden = true;
    shadow.querySelector('#raw').hidden = true;
  }
  function showDot(id, [x, y]) {
    const dot = shadow.querySelector(id);
    dot.hidden = false;
    dot.style.left = `${x}px`;
    dot.style.top = `${y}px`;
  }
  function showFilterName() {
    shadow.querySelector('#filter').textContent = `필터: ${filterChoices[filterIndex].name} · F로 변경`;
  }
  function nextFilter() {
    filterIndex = (filterIndex + 1) % filterChoices.length;
    filter = filterChoices[filterIndex].create();
    resetFilter(); // 이전 필터의 점이 섞이지 않게 떨림 기록도 새로 시작
    showFilterName();
  }
  function showJitter(now) {
    // 최근 1.5초 점들의 표준편차로 원본과 필터 결과의 떨림을 비교한다
    const recent = trail.filter(p => now - p.time < JITTER_MS);
    const raw = Math.round(jitter(recent.map(p => p.raw)));
    const filtered = Math.round(jitter(recent.map(p => p.filtered)));
    shadow.querySelector('#jitter').textContent = `떨림: 원본 ${raw}px → 필터 ${filtered}px`;
  }
  function drawGraph(now) {
    // 최근 3초의 x좌표: 빨강 = 원본, 파랑 = 필터. 오른쪽 끝이 지금이다
    const canvas = shadow.querySelector('#graph');
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    const xs = trail.flatMap(p => [p.raw[0], p.filtered[0]]);
    const low = Math.min(...xs);
    // 세로축을 최근 값 범위에 맞춰야 작은 떨림도 보인다 (최소 40px 범위)
    const high = Math.max(low + 40, ...xs);
    for (const [key, color] of [['raw', '#ff3b3b'], ['filtered', '#4d9bff']]) {
      context.strokeStyle = color;
      context.beginPath();
      for (const p of trail) {
        const gx = canvas.width * (1 - (now - p.time) / GRAPH_MS);
        const gy = canvas.height * (1 - (p[key][0] - low) / (high - low));
        context.lineTo(gx, gy);
      }
      context.stroke();
    }
  }
  function chooseNearest(now) {
    const item = nearest.update(candidates(...smooth), now);
    // 머무름 0.3초가 지나기 전에는 선택이 없으므로 테두리를 그리지 않는다
    if (!item) { status('대상을 0.3초 이상 바라보세요.'); return; }
    selected = item;
    showTarget(selected);
    status(`선택: ${item.name || item.role} · ${CLICK_HINT}.`);
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    // Always acknowledge receipt, including frames/status and obsolete contexts.
    // Otherwise a message-port closure can be mistaken for a missing document.
    if (message.type !== 'start' && message.type !== 'suspend') reply?.({ok: true});
    if (message.type === 'start') { start(message); reply?.({ok: true}); return; }
    if (message.context !== currentContext) return;
    if (message.type === 'suspend') { end(); reply?.({ok: true}); return; }
    if (message.type === 'stopped') { end(message.message); return; }
    if (!running) return;
    if (message.type === 'status') status(message.message);
    if (message.type === 'frame') frame(message);
    if (message.type === 'selection' && pending?.requestId === message.requestId) {
      const request = pending; pending = null;
      if (clicker.active || !document.hasFocus() || performance.now() - lastFrame > 400) return;
      const item = request.items.find(c => c.id === message.id);
      if (!item || !smooth || Math.hypot(...smooth.map((v, k) => v - request.gaze[k])) > 80 ||
          !GazeDOM.unchanged(item)) {
        status(selected ? `마지막 선택 유지: ${selected.name || selected.role}` : message.error || 'Jev 선택 보류 · 대상을 계속 바라보세요.'); return;
      }
      selected = {...item}; showTarget(selected);
      status(`선택: ${item.name || item.role} · ${CLICK_HINT}.`);
    }
  });
  document.addEventListener('keydown', event => { if (host && event.key === 'Escape') { event.preventDefault(); stop('ESC로 중지됨'); } }, true);
  document.addEventListener('keydown', event => {
    // event.code는 한글 입력 상태에서도 'KeyF'. Ctrl+F(찾기) 같은 단축키는 건드리지 않는다
    if (!running || event.code !== 'KeyF' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    // 입력칸에 타이핑 중이면 F는 글자로 남겨 둔다
    if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    event.preventDefault();
    nextFilter();
  }, true);
  document.addEventListener('visibilitychange', () => { if (running && document.hidden) { invalidate(); hideCursor(); } });
  window.addEventListener('scroll', () => { if (running) invalidate(); }, true);
  window.addEventListener('blur', () => { if (running) invalidate(); });
})();
