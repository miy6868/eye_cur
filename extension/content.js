(() => {
  if (globalThis.__gazeInstalled) return;
  globalThis.__gazeInstalled = true;
  // false: 서버(Jev API) 대신 직접 만든 NearestSelector로 대상을 고른다. API 키가 없어도 동작한다.
  const USE_JEV = false;
  // 클릭 방식: 'mouth' = 입 벌리기 클릭(기본), 'eyes' = 기존 양눈 감기 클릭
  const CLICK_MODE = 'mouth';
  const CLICK_HINT = CLICK_MODE === 'mouth' ? '입을 0.5~2.0초 벌렸다 다무세요' : '양눈을 0.6~2.0초 감았다 뜨세요';
  const {predict, Blink, MouthClick, NearestSelector, MovingAverage, ExponentialSmoothing, FixationFilter, jitter, PURSUIT_PATH, pursuitPoint, pursuitRecord, fitPursuit, average} = globalThis.GazeCore;
  const nearest = new NearestSelector();
  // F 키로 순환하는 떨림 제거 필터. '끔'이면 원본 점을 그대로 쓴다
  const filterChoices = [
    {name: '끔', create: () => null},
    // 시선 값은 초당 약 9번 온다. 약한 필터(5개, 0.45)는 떨림이 남아서 쓰기 어려워 '강'부터 둔다
    // 이동평균 N개의 지연 ≈ (N-1)/2개, 지수평균 a의 지연 ≈ (1-a)/a개라서 같은 단계끼리 지연이 비슷하다
    {name: '이동평균 강(10)', create: () => new MovingAverage(10)},
    {name: '지수평균 강(0.2)', create: () => new ExponentialSmoothing(0.2)},
    {name: '이동평균 최강(20)', create: () => new MovingAverage(20)},
    {name: '지수평균 최강(0.1)', create: () => new ExponentialSmoothing(0.1)},
    // 응시 중에는 최대 30개(약 3초)를 평균해 지수평균 0.1보다 덜 떨리고, 시선이 뛰면 3개(약 0.3초) 만에 따라간다
    {name: '응시 고정(120px)', create: () => new FixationFilter(120, 3, 30)},
  ];
  let filterIndex = 5; // 응시 고정으로 시작
  let filter = filterChoices[filterIndex].create();
  let trail = []; // 최근 3초의 {raw, filtered, time}: 떨림 계산과 그래프용
  const GRAPH_MS = 3000;
  const JITTER_MS = 1500;
  // 고정 점 대신 움직이는 점을 따라 보게 해 표본이 화면 전체에 고르게 퍼지게 한다
  const MIN_PURSUIT_RECORDS = 40; // 경로를 다 돌았는데 이보다 적으면 얼굴을 자주 놓친 것이므로 실패 처리
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
    calibration = model ? null : {startedAt: null, records: [], heads: []}; // startedAt: 첫 시선 결과가 오면 점이 출발한다
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    shadow = host.attachShadow({mode: 'closed'});
    shadow.innerHTML = `
      <style>
      :host{all:initial}*{box-sizing:border-box}[hidden]{display:none!important}
      #veil{position:fixed;inset:0;background:#0c1728f5;pointer-events:auto}
      #use{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);padding:12px 22px;font:600 16px system-ui;background:#21dba0;color:#071b2a}
      #dot{position:fixed;width:26px;height:26px;border:5px solid #fff;border-radius:50%;background:#32dba0;transform:translate(-50%,-50%);box-shadow:0 0 0 14px #32dba029}
      #path{position:fixed;inset:0;width:100%;height:100%}
      #guide{position:fixed;top:50%;left:50%;transform:translate(-50%,calc(-100% - 8px));font:16px/1.5 system-ui;color:#fff;text-align:center}
      #panel{position:fixed;bottom:14px;left:14px;max-width:520px;border:1px solid #ffffff24;background:#142236;color:#fff;border-radius:9px;padding:10px 14px;font:13px/1.5 system-ui;display:flex;flex-wrap:wrap;gap:12px;align-items:center}
      button{pointer-events:auto;white-space:nowrap;border:0;border-radius:5px;padding:6px 9px;background:#33465e;color:#fff;cursor:pointer}
      /* 보정 중에는 정보 상자를 화면 가운데 두 줄 사이로 옮겨 점을 가리지 않게 한다 */
      #panel.calibrating{top:calc(50% + 8px);bottom:auto;left:50%;transform:translateX(-50%);max-width:min(760px,90vw)}
      #panel.calibrating :is(#mouth,#filter,#jitter,#graph){display:none}
      #raw{position:fixed;width:6px;height:6px;border-radius:50%;background:#ff3b3b;transform:translate(-50%,-50%)}
      #graph{background:#0c1728;border-radius:4px}
      #cursor{position:fixed;width:12px;height:12px;border:2px solid #fff;border-radius:50%;background:#176cff;transform:translate(-50%,-50%)}
      #target{position:fixed;border:3px solid #21dba0;border-radius:5px;background:#21dba01a;box-shadow:0 0 0 2px #071b2a99}
      </style>
      <div id="veil"><svg id="path" viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points="${PURSUIT_PATH.map(p => p.map(v => v * 100).join(' ')).join(' ')}" fill="none" stroke="#8a94a6" stroke-width="3" stroke-dasharray="8 6" vector-effect="non-scaling-stroke"/></svg><div id="guide">머리를 고정하고, 회색 선을 따라 움직이는 초록 점을 눈으로 따라가세요.<br>꺾이는 곳에서는 잠시 멈춥니다.</div><div id="dot"></div><button id="use" hidden>그래도 사용</button></div>
      <div id="raw" hidden></div><div id="cursor" hidden></div><div id="target" hidden></div>
      <div id="panel"><span id="eyes">눈 상태 준비 중</span><span id="mouth"></span><span id="head"></span><span id="status"></span><span id="filter"></span><span id="jitter"></span><canvas id="graph" width="200" height="50"></canvas><button id="recalibrate">다시 보정</button><button id="stop">중지 · ESC</button></div>`;
    document.documentElement.appendChild(host);
    shadow.querySelector('#stop').onclick = () => stop('중지됨');
    shadow.querySelector('#recalibrate').onclick = () => send({type: 'recalibrate'});
    shadow.querySelector('#use').onclick = () => finishCalibration(calibration.result);
    showFilterName();
    shadow.querySelector('#panel').classList.toggle('calibrating', !!calibration);
    if (calibration) { moveDot(calibration); status('움직이는 점 보정 · 카메라 연결 대기 중…'); }
    else { shadow.querySelector('#veil').hidden = true; status('저장된 보정으로 계속합니다 · 어긋나면 다시 보정을 누르세요.'); }
    timer = setInterval(() => {
      if (!running) return;
      if (geometry() !== layout) { send({type: 'calibrationInvalid'}); start({context: currentContext}); return; }
      if (performance.now() - lastFrame > 500) {
        invalidate(); hideCursor();
      }
      if (pending && performance.now() - pending.sent > 1800) {
        pending = null; requestNumber++;
        if (!clicker.active) status('Jev 응답 지연 · 선택 보류');
      }
    }, 100);
  }
  // 화면이 그려질 때마다 점을 경로 위 현재 위치로 옮긴다
  function moveDot(owner) {
    // 보정이 끝났거나 새로 시작했으면 이 반복을 멈춘다
    if (!running || calibration !== owner || owner.result) return;
    const elapsed = owner.startedAt === null ? 0 : performance.now() - owner.startedAt;
    const step = pursuitPoint(elapsed);
    if (!step) return;
    const dot = shadow.querySelector('#dot');
    dot.style.left = `${step.point[0] * 100}vw`; dot.style.top = `${step.point[1] * 100}vh`;
    requestAnimationFrame(() => moveDot(owner));
  }
  function calibrate(frame, now) {
    if (calibration.startedAt === null) {
      // 카메라가 늦게 켜져도 점이 먼저 출발하지 않도록 첫 시선 결과에서 시계를 시작한다
      if (!Array.isArray(frame.gaze)) return;
      calibration.startedAt = now;
    }
    const record = pursuitRecord(frame, now, calibration.startedAt);
    if (record) {
      calibration.records.push(record);
      // 보정할 때의 머리 상태를 기억해 두었다가 사용 중 얼마나 달라졌는지 비교한다
      if (Number.isFinite(frame.headRoll)) calibration.heads.push([frame.headRoll, frame.headDistance]);
    }
    if (pursuitPoint(now - calibration.startedAt)) {
      status(`시선 보정 중 · 표본 ${calibration.records.length}개 · 움직이는 초록 점을 눈으로 따라가세요`);
      return;
    }
    if (calibration.records.length < MIN_PURSUIT_RECORDS) {
      calibrationFailed(`시선 표본이 ${calibration.records.length}개뿐입니다. 얼굴이 카메라에 잘 보이는지 확인하고 다시 보정하세요.`);
      return;
    }
    try {
      model = fitPursuit(calibration.records);
      if (calibration.heads.length) {
        const [roll, distance] = average(calibration.heads);
        model.head = {roll, distance};
      }
    } catch (error) { calibrationFailed(error.message); return; }
    // 검증 점을 따로 보지 않는다. 표본 하나를 빼고 회귀한 뒤 뺀 표본을 맞혀 보는 교차 검증 오차를 쓴다
    const rms = model.crossError;
    if (!Number.isFinite(rms)) { calibrationFailed('시선 좌표 계산에 실패했습니다. 다시 보정해 주세요.'); return; }
    // 화면 비율 단위 오차를 픽셀로 대략 바꾼다 (가로·세로 오차가 비슷하다고 본다)
    const pixelRms = Math.round(rms * Math.hypot(innerWidth, innerHeight) / Math.SQRT2);
    if (rms > .15) {
      // 학습은 끝났으니 버리지 않고, 오차를 보여 준 뒤 사용자가 계속할지 고르게 한다
      calibration.result = {rms, pixelRms};
      const message = `교차 검증 오차 약 ${pixelRms}px로 기준보다 큽니다. 그래도 사용하거나 다시 보정하세요.`;
      shadow.querySelector('#guide').textContent = message;
      shadow.querySelector('#dot').hidden = true;
      shadow.querySelector('#use').hidden = false;
      status(message);
      return;
    }
    finishCalibration({rms, pixelRms});
  }
  function finishCalibration({rms, pixelRms}) {
    // 검증 오차만큼 후보 탐색 반경도 넓어지도록 모델 오차에 반영한다
    model.error = Math.max(model.error, rms);
    calibration = null; shadow.querySelector('#veil').hidden = true;
    shadow.querySelector('#panel').classList.remove('calibrating');
    send({type: 'calibrated', model, layout});
    status(`준비됨 · ${model.degree === 2 ? '비선형' : '선형'} 보정 · 검증 오차 약 ${pixelRms}px · 시선 지연 ${model.lag}ms · ${CLICK_HINT}.`);
  }
  function calibrationFailed(message) {
    running = false; clearInterval(timer); invalidate();
    shadow.querySelector('#guide').textContent = message;
    shadow.querySelector('#dot').hidden = true;
    status(message);
    // Keep the session/camera alive so the retry button can start calibration again.
    send({type: 'calibrationInvalid'});
  }
  // 머리 기울기·거리를 보여 주고, 보정할 때와 얼마나 달라졌는지 비교한다
  // 이 값이 많이 바뀔수록 가장자리 오차가 커지는지 확인하려는 측정용 표시
  function showHead(message) {
    let text = `머리 기울기 ${message.headRoll.toFixed(1)}° · 거리 ${message.headDistance}mm`;
    if (model?.head) {
      const roll = message.headRoll - model.head.roll;
      const distance = (message.headDistance / model.head.distance - 1) * 100;
      text += ` (보정 대비 ${roll >= 0 ? '+' : ''}${roll.toFixed(1)}°, ${distance >= 0 ? '+' : ''}${distance.toFixed(0)}%)`;
    }
    shadow.querySelector('#head').textContent = text;
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
    if (Number.isFinite(message.headRoll)) showHead(message);
    if (!document.hasFocus() || document.hidden || !message.valid) {
      invalidate(); hideCursor();
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
