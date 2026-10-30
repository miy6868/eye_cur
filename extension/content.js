(() => {
  if (globalThis.__gazeInstalled) return;
  globalThis.__gazeInstalled = true;
  // false: 서버(Jev API) 대신 직접 만든 NearestSelector로 대상을 고른다. API 키가 없어도 동작한다.
  const USE_JEV = false;
  // 클릭 방식: 'mouth' = 입 벌리기 클릭(기본), 'eyes' = 기존 양눈 감기 클릭
  const CLICK_MODE = 'mouth';
  // true: 클릭할 때마다 그 요소를 보고 있었다고 보고 시선 오프셋을 고친다(클릭 보정). 효과를 아직 측정하지 않아 기본은 끔
  const CLICK_DRIFT = false;
  const CLICK_HINT = CLICK_MODE === 'mouth' ? '입을 0.5~2.0초 벌렸다 다무세요' : '양눈을 0.6~2.0초 감았다 뜨세요';
  const {predict, Blink, MouthClick, NearestSelector, MovingAverage, ExponentialSmoothing, FixationFilter, jitter, CALIBRATION_POINTS, CALIBRATION_ORDER, gazeRecord, medianGaze, fitPoints, average, correctDrift, eyeRange, eyeSize} = globalThis.GazeCore;
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
  let lockGaze = null; // 클릭 대상이 고정되는 순간의 예측 위치(px): 클릭이 끝나면 드리프트 보정에 쓴다
  const GRAPH_MS = 3000;
  const JITTER_MS = 1500;
  // 9점 응시 보정: 점마다 0.8초는 눈이 옮겨 가는 시간이라 버리고, 0.8초 동안 표본을 모은다. 18번 × 1.6초 ≈ 29초
  // 0.8초인 이유: 눈꺼풀은 눈보다 늦게 내려와서, 아래쪽 점에서는 0.5초가 지나도 시선 값이 계속 바뀌었다.
  // 기록 2개에서 0.8~1초 뒤 값만 쓰면 아래 줄 오차가 줄었다(88→57px, 106→80px)
  const POINT_SETTLE_MS = 800;
  const POINT_COLLECT_MS = 800;
  const POINT_MIN_RECORDS = 3;    // 눈을 감아 표본이 이보다 적으면 조금 더 기다린다
  const POINT_TIMEOUT_MS = 2100;  // 그래도 이 시간이 지나면 다음 점으로: 2초 + 18번 × 2.1초 = 39.8초라도 40초를 넘지 않는다
  const START_DELAY_MS = 2000;    // 보정을 누르자마자 점을 보기는 어려워서, 첫 점을 보여 준 채 2초 세고 시작한다
  // 저장된 보정이 어떤 시선 모델·방식으로 만들어졌는지 표시: 둘 중 하나라도 바뀌면 예전 보정은 이어 쓰지 않고 다시 보정한다
  // (GazeTR과 UniGaze는 같은 곳을 봐도 출력 각도가 달라서, 예전 보정 계수를 그대로 쓰면 엉뚱한 곳을 가리킨다)
  const CALIBRATION_METHOD = 'unigaze-points9';
  let currentContext;
  let running = false, host, shadow, model, calibration, smooth, clicker;
  let selected = null, pending = null, requestNumber = 0, lastRequest = 0;
  let lastFrame = 0, history = [], timer, layout, lastStatus = '';
  let ids = new WeakMap(), idNumber = 0;
  // 팝업의 '화면에 정보 표시'. 사이트를 방해하지 않도록 기본은 꺼짐.
  // 켜야 왼쪽 아래 정보 상자가 보이고 단축키(F 필터, ESC 중지)가 동작한다
  let showInfo = false;

  function send(message) { return chrome.runtime.sendMessage({...message, context: currentContext}).catch(() => {}); }
  function status(text) {
    if (!shadow || lastStatus === text) return;
    lastStatus = text;
    shadow.querySelector('#status').textContent = text;
    send({type: 'uiStatus', message: text});
  }
  function invalidate() {
    selected = null; pending = null; history = []; resetFilter(); lockGaze = null;
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
      // 중지 이유(서버 끊김 등)는 정보 표시를 꺼 두었어도 8초 동안 보여 준다
      shadow.querySelector('#panel').hidden = false;
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
    // 같은 창 배치에서 지금 방식으로 만든 보정만 이어서 쓴다
    if (saved?.layout === layout && saved.model?.method === CALIBRATION_METHOD) model = saved.model;
    else if (saved) send({type: 'calibrationInvalid'});
    // 클릭 보정을 껐으면 예전에 저장된 오프셋도 쓰지 않는다
    if (model && !CLICK_DRIFT) delete model.offset;
    // step: 몇 번째 점인지(0~17), records: 지금 점에서 모은 기록, log: 서버에 남길 모든 기록
    // startAt: 2초 세기가 끝나는 시각(첫 시선 결과가 오면 정한다)
    calibration = model ? null : {startAt: null, shownAt: null, step: 0, records: [], log: [],
      points: CALIBRATION_POINTS.map(target => ({target, medians: []}))};
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    shadow = host.attachShadow({mode: 'closed'});
    shadow.innerHTML = `
      <style>
      :host{all:initial}*{box-sizing:border-box}[hidden]{display:none!important}
      /* 보정 화면은 웹페이지처럼 밝게: 어두운 화면에서 보정하고 밝은 페이지에서 쓰면 얼굴 조명·동공 크기가 달라져 시선 값이 통째로 밀린다 */
      #veil{position:fixed;inset:0;background:#f6f7f9;pointer-events:auto}
      #choices{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);display:flex;gap:12px}
      #choices button{padding:12px 22px;font:600 16px system-ui;border-radius:8px}
      #use{background:#21dba0;color:#071b2a}
      #next{position:fixed;width:46px;height:46px;border:3px dashed #9ca3af;border-radius:50%;transform:translate(-50%,-50%)}
      #dot{position:fixed;width:66px;height:66px;border:18px solid #21dba0;border-radius:50%;background:#111827;transform:translate(-50%,-50%)}
      /* 작아지는 움직임은 크기를 바꾸는 전환으로 만든다(시간은 showPoint에서 POINT_SETTLE_MS로 정함) */
      #dot.small{width:22px;height:22px;border-width:6px;transition-property:width,height,border-width;transition-timing-function:ease-out}
      #guide{position:fixed;top:30%;left:50%;transform:translate(-50%,-50%);font:16px/1.5 system-ui;color:#111827;text-align:center}
      #guide p{margin:0}
      #progress{margin-top:8px!important;font-weight:600;color:#4b5563}
      /* 정보 상자는 보기만 한다: 마우스가 통과해서 아래 사이트를 그대로 누를 수 있다 */
      #panel{position:fixed;bottom:14px;left:14px;max-width:520px;border:1px solid #ffffff24;background:#142236;color:#fff;border-radius:9px;padding:10px 14px;font:13px/1.5 system-ui;display:flex;flex-wrap:wrap;gap:12px;align-items:center;pointer-events:none}
      button{pointer-events:auto;white-space:nowrap;border:0;border-radius:5px;padding:6px 9px;background:#33465e;color:#fff;cursor:pointer}
      /* 보정 중에는 안내(30%)와 정보 상자(70%)를 점 줄(10·50·90%) 사이에 두어 점을 가리지 않게 한다 */
      #panel.calibrating{top:70%;bottom:auto;left:50%;transform:translate(-50%,-50%);max-width:min(760px,90vw)}
      #panel.calibrating :is(#mouth,#filter,#jitter,#graph){display:none}
      #eyesize{color:#ffcf4d;font-weight:600}
      #raw{position:fixed;width:6px;height:6px;border-radius:50%;background:#ff3b3b;transform:translate(-50%,-50%)}
      #graph{background:#0c1728;border-radius:4px}
      #cursor{position:fixed;width:12px;height:12px;border:2px solid #fff;border-radius:50%;background:#176cff;transform:translate(-50%,-50%)}
      #target{position:fixed;border:3px solid #21dba0;border-radius:5px;background:#21dba01a;box-shadow:0 0 0 2px #071b2a99}
      /* 입을 벌리는 동안은 주황색: 정보 상자를 꺼 두어도 클릭이 진행 중인지 보인다 */
      #target.arming{border-color:#f59e0b;background:#f59e0b2e}
      </style>
      <div id="veil"><div id="guide"><p id="guide-text">머리를 고정하고 초록 점을 바라보세요. 점이 작아지면 가운데를 봅니다.<br>회색 점선 원은 다음 점 자리입니다 · 9개 점을 앞으로 한 번, 거꾸로 한 번 · 2초 뒤 시작, 약 30초</p><p id="progress"></p></div><div id="next"></div><div id="dot"></div><div id="choices" hidden><button id="use">그래도 사용</button><button id="retry">다시 보정</button></div></div>
      <div id="raw" hidden></div><div id="cursor" hidden></div><div id="target" hidden></div>
      <div id="panel"><span id="eyes">눈 상태 준비 중</span><span id="mouth"></span><span id="head"></span><span id="quality"></span><span id="drift"></span><span id="eyesize"></span><span id="status"></span><span id="filter"></span><span id="jitter"></span><canvas id="graph" width="200" height="50"></canvas></div>`;
    document.documentElement.appendChild(host);
    shadow.querySelector('#use').onclick = () => finishCalibration(calibration.result);
    shadow.querySelector('#retry').onclick = () => send({type: 'recalibrate'});
    showFilterName();
    applyInfo();
    shadow.querySelector('#panel').classList.toggle('calibrating', !!calibration);
    if (calibration) { showPoint(null); status('9점 보정 · 카메라 연결 대기 중…'); progress('카메라 연결 대기 중…'); }
    else { shadow.querySelector('#veil').hidden = true; status('저장된 보정으로 계속합니다 · 어긋나면 확장 아이콘의 다시 보정을 누르세요.'); showDrift(); }
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
  // 보정 점 하나를 보여 준다. now가 null이면 첫 시선 결과가 올 때 시간을 재기 시작한다
  function showPoint(now) {
    calibration.shownAt = now;
    calibration.records = [];
    const [x, y] = CALIBRATION_POINTS[CALIBRATION_ORDER[calibration.step]];
    const dot = shadow.querySelector('#dot');
    dot.style.left = `${x * 100}vw`; dot.style.top = `${y * 100}vh`;
    // 크게 나타나 작아지는 점이 눈을 끌어당긴다. 작아지는 0.8초가 눈이 옮겨 가는 시간(POINT_SETTLE_MS)이다.
    // transform 애니메이션(scale)은 점을 따로 떼어 그리는 층을 만들었다 없애서, Hyprland(화면 배율 1.2)에서
    // 시작 직후 화면이 깜빡이고 찢어졌다. 그래서 점의 크기(width·height)를 바꾸는 전환으로 만든다
    dot.classList.remove('small');
    dot.getBoundingClientRect(); // 큰 크기를 한 번 계산시켜야 다음 줄의 전환이 큰 크기에서부터 다시 시작한다
    dot.style.transitionDuration = `${POINT_SETTLE_MS}ms`;
    dot.classList.add('small');
    // 다음 점 자리를 회색 점선 원으로 미리 보여 준다: 처음 쓰는 사용자도 점이 어디로 갈지 안다
    // 같은 점을 한 번 더 볼 때(바퀴가 바뀔 때)는 원이 지금 점을 둘러싸서 "그대로 보라"는 뜻이 된다
    const next = CALIBRATION_ORDER[calibration.step + 1];
    const ring = shadow.querySelector('#next');
    ring.hidden = next === undefined; // 마지막 점에서는 다음이 없다
    if (next === undefined) return;
    ring.style.left = `${CALIBRATION_POINTS[next][0] * 100}vw`; ring.style.top = `${CALIBRATION_POINTS[next][1] * 100}vh`;
  }
  function calibrate(frame, now) {
    if (calibration.shownAt === null) {
      // 카메라가 늦게 켜져도 시간이 먼저 흐르지 않도록 첫 시선 결과에서 세기 시작한다
      if (!Array.isArray(frame.gaze)) {
        // 얼굴은 찾았지만 아직 시선 값이 없다: 처음 0.5초쯤은 눈 뜬 상태를 배우는 중이라 시선을 계산하지 않는다
        if (frame.eyesReady === false) progress('눈 뜬 상태를 배우는 중… 화면을 편하게 바라보세요');
        return;
      }
      if (calibration.startAt === null) calibration.startAt = now + START_DELAY_MS;
      if (now < calibration.startAt) {
        const seconds = Math.ceil((calibration.startAt - now) / 1000);
        progress(`${seconds}초 뒤 시작 · 왼쪽 위 초록 점을 바라보세요`);
        status(`보정 준비 · ${seconds}초 뒤 시작`);
        return;
      }
      // 점이 한 번 더 크게 나타났다 작아지며 시작을 알린다
      showPoint(now);
    }
    // record.time은 점이 나타난 뒤 촬영까지 걸린 시간. 눈이 아직 옮겨 가는 중인 앞부분은 버린다
    const record = gazeRecord(frame, now, calibration.shownAt);
    if (record && record.time >= POINT_SETTLE_MS) {
      annotate(record, frame);
      calibration.records.push(record);
    }
    status(`시선 보정 중 · ${calibration.step + 1}/${CALIBRATION_ORDER.length} · 점이 작아지면 가운데를 바라보세요`);
    progress(`${calibration.step + 1} / ${CALIBRATION_ORDER.length}`);
    const elapsed = now - calibration.shownAt;
    const enough = elapsed >= POINT_SETTLE_MS + POINT_COLLECT_MS && calibration.records.length >= POINT_MIN_RECORDS;
    if (!enough && elapsed < POINT_TIMEOUT_MS) return;
    finishPoint();
    if (calibration.step < CALIBRATION_ORDER.length) { showPoint(now); return; }
    learn();
  }
  // 지금 점의 기록을 중앙값 하나로 줄여 그 점에 더하고 다음 점으로 넘어간다
  function finishPoint() {
    const index = CALIBRATION_ORDER[calibration.step];
    if (calibration.records.length) calibration.points[index].medians.push(medianGaze(calibration.records));
    // 기록 분석용: 어느 점(point)의 몇 번째 차례(step)였는지 붙여 모두 남긴다
    for (const record of calibration.records) calibration.log.push({...record, point: index, step: calibration.step});
    calibration.step++;
  }
  // 18번을 모두 보면 회귀로 시선 → 화면 관계를 배운다
  function learn() {
    const missing = calibration.points.filter(p => !p.medians.length).length;
    if (missing) {
      calibrationFailed(`점 ${missing}개에서 시선 표본을 얻지 못했습니다. 얼굴이 카메라에 잘 보이는지 확인하고 다시 보정하세요.`);
      return;
    }
    try {
      model = fitPoints(calibration.points);
    } catch (error) { calibrationFailed(error.message); return; }
    model.method = CALIBRATION_METHOD;
    const heads = calibration.log.filter(r => r.head).map(r => r.head);
    if (heads.length) {
      const [roll, distance] = average(heads);
      const [pitch] = average(heads.map(h => [h[2], h[3]]));
      model.head = {roll, distance, pitch};
    }
    const openness = calibration.log.map(r => r.openness).filter(Number.isFinite);
    if (openness.length) model.eyeRange = eyeRange(openness);
    judge();
  }
  // 보정 화면 안내 아래에 진행 상황을 쓴다: 정보 상자를 꺼 두어도 몇 번째 점인지 보인다
  function progress(text) {
    shadow.querySelector('#progress').textContent = text;
  }
  // 정보 표시를 켜고 끈 상태를 화면에 반영한다
  function applyInfo() {
    if (!shadow) return;
    shadow.querySelector('#panel').hidden = !showInfo;
  }
  // 기록에 머리 상태 [기울기, 거리, 끄덕임, 돌림]와 홍채 위치를 붙인다: 사용 중 비교와 기록 분석용
  function annotate(record, frame) {
    if (Number.isFinite(frame.headRoll)) record.head = [frame.headRoll, frame.headDistance, frame.headPitch, frame.headYaw];
    if (Array.isArray(frame.iris)) record.iris = frame.iris;
    if (Number.isFinite(frame.openness)) record.openness = frame.openness;
  }
  // 오차를 계산하고 기록을 서버에 보낸 뒤, 쓸지 말지 정한다
  function judge() {
    // 교차 검증 오차: 점 하나를 빼고 회귀한 뒤 뺀 점을 맞혀 본 오차. 보정에 쓰지 않은 위치의 오차와 비슷하다
    const rms = model.crossError;
    // 화면 비율 단위 오차를 픽셀로 대략 바꾼다 (가로·세로 오차가 비슷하다고 본다)
    const pixelRms = Math.round(rms * Math.hypot(innerWidth, innerHeight) / Math.SQRT2);
    // 나중에 회귀·입력을 바꿨을 때 같은 자료로 비교할 수 있도록 원래 값을 모두 남긴다
    send({type: 'calibrationLog', screen: [innerWidth, innerHeight], method: CALIBRATION_METHOD,
      crossError: rms, errorPixels: pixelRms, points: calibration.points, records: calibration.log});
    if (!Number.isFinite(rms)) { calibrationFailed('시선 좌표 계산에 실패했습니다. 다시 보정해 주세요.'); return; }
    if (rms > .15) {
      // 학습은 끝났으니 버리지 않고, 오차를 보여 준 뒤 사용자가 계속할지 고르게 한다
      calibration.result = {rms, pixelRms};
      const message = `점 오차 약 ${pixelRms}px로 기준보다 큽니다. 그래도 사용하거나 다시 보정하세요.`;
      shadow.querySelector('#guide-text').textContent = message;
      progress('');
      shadow.querySelector('#dot').hidden = true;
      shadow.querySelector('#choices').hidden = false;
      status(message);
      return;
    }
    finishCalibration({rms, pixelRms});
  }
  function finishCalibration({rms, pixelRms}) {
    // 검증 오차만큼 후보 탐색 반경도 넓어지도록 모델 오차에 반영한다
    model.error = Math.max(model.error, rms);
    // 팝업에서 보정 결과를 보여 주도록 픽셀 오차를 모델과 함께 저장한다
    model.pixelError = pixelRms;
    calibration = null; shadow.querySelector('#veil').hidden = true;
    shadow.querySelector('#panel').classList.remove('calibrating');
    send({type: 'calibrated', model, layout});
    // 상태 줄은 다음 프레임에 바로 바뀌므로 보정 결과는 따로 계속 보여 준다
    shadow.querySelector('#quality').textContent = `보정 결과: 점 오차 약 ${pixelRms}px`;
    status(`준비됨 · 9점 보정 · 점 오차 약 ${pixelRms}px · ${CLICK_HINT}.`);
  }
  function calibrationFailed(message) {
    running = false; clearInterval(timer); invalidate();
    shadow.querySelector('#guide-text').textContent = message;
    progress('');
    shadow.querySelector('#dot').hidden = true;
    shadow.querySelector('#next').hidden = true;
    // 실패 화면에서 바로 다시 할 수 있게 다시 보정 버튼만 보여 준다
    shadow.querySelector('#choices').hidden = false;
    shadow.querySelector('#use').hidden = true;
    status(message);
    // Keep the session/camera alive so the retry button can start calibration again.
    send({type: 'calibrationInvalid'});
  }
  // 머리 기울기·거리를 보여 주고, 보정할 때와 얼마나 달라졌는지 비교한다
  // 이 값이 많이 바뀔수록 가장자리 오차가 커지는지 확인하려는 측정용 표시
  function showHead(message) {
    let text = `머리 기울기 ${message.headRoll.toFixed(1)}° · 끄덕임 ${message.headPitch?.toFixed(1)}° · 거리 ${message.headDistance}mm`;
    if (model?.head) {
      const roll = message.headRoll - model.head.roll;
      const pitch = message.headPitch - model.head.pitch;
      const distance = (message.headDistance / model.head.distance - 1) * 100;
      const signed = (value, digits) => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
      text += ` (보정 대비 기울기 ${signed(roll, 1)}°, 끄덕임 ${signed(pitch, 1)}°, 거리 ${signed(distance, 0)}%)`;
    }
    shadow.querySelector('#head').textContent = text;
  }
  // 보정 때보다 눈을 너무 크게/작게 뜨면 알려 준다 (그때는 예측이 틀어지기 쉽다)
  function showEyeSize(openness) {
    const size = eyeSize(openness, model.eyeRange);
    shadow.querySelector('#eyesize').textContent =
      size === 'big' ? '눈을 보정 때보다 크게 떴어요 · 평소처럼 뜨세요' :
      size === 'small' ? '눈을 보정 때보다 작게 떴어요 · 평소처럼 뜨세요' : '';
  }
  // 클릭으로 고친 오프셋을 픽셀로 보여 준다
  function showDrift() {
    const drift = shadow.querySelector('#drift');
    if (!model?.offset) { drift.textContent = ''; return; }
    const [x, y] = model.offset.map((v, k) => Math.round(v * [innerWidth, innerHeight][k]));
    drift.textContent = `클릭 보정 (${x >= 0 ? '+' : ''}${x}, ${y >= 0 ? '+' : ''}${y})px`;
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
    target.classList.toggle('arming', clicker.active);
    Object.assign(target.style, {left: `${x - 3}px`, top: `${y - 3}px`, width: `${w + 6}px`, height: `${h + 6}px`});
    target.hidden = false;
  }
  function click(item) {
    if (document.hidden || !GazeDOM.unchanged(item)) {
      invalidate(); status('대상이 바뀌어 클릭을 취소했습니다.'); return;
    }
    const element = item.element;
    const gaze = lockGaze;
    invalidate();
    element.focus({preventScroll: true}); element.click();
    status('클릭 완료');
    if (CLICK_DRIFT && gaze) {
      // 방금 클릭한 요소를 보고 있었으므로, 그만큼 예측이 어긋났다고 보고 오프셋을 고친다
      model.offset = correctDrift(model.offset, gaze, item.rect, [innerWidth, innerHeight]);
      send({type: 'calibrated', model, layout}); // 다른 탭·다음 실행에서도 고친 값을 쓴다
      showDrift();
    }
  }
  function frame(message) {
    if (!running) return;
    const now = performance.now(); lastFrame = now;
    shadow.querySelector('#eyes').textContent = !message.valid ? '눈 추적 끊김' : message.eyesReady === false ? '눈 뜬 상태 학습 중' : message.closed ? '양눈 감음' : message.closing ? '눈 감는 중' : '눈 뜸';
    if (Number.isFinite(message.openness)) shadow.querySelector('#eyes').textContent += ` · 눈 열림 ${Math.round(message.openness * 100)}%`;
    // 문턱값(벌림 > 0.20, 다뭄 < 0.12)을 맞출 수 있게 MAR 값을 그대로 보여 준다
    const mar = Number.isFinite(message.mar) ? message.mar.toFixed(2) : '-';
    shadow.querySelector('#mouth').textContent = `입 ${message.mouthOpen ? '벌림' : '다뭄'} · MAR ${mar}`;
    if (Number.isFinite(message.headRoll)) showHead(message);
    // 키보드 초점(document.hasFocus)이 아니라 화면에 보이는지로 멈춘다. 시선은 화면만 보이면 되고,
    // Linux(Wayland)에서는 팝업을 닫은 뒤 창에 초점이 있어도 페이지가 초점이 없다고 나와 보정 표본이 버려졌다
    if (document.hidden || !message.valid) {
      invalidate(); hideCursor();
      const reason = !message.valid ? (message.error || '얼굴을 찾는 중… 카메라를 바라보세요.') : '페이지로 돌아오면 계속합니다.';
      status(reason);
      // 보정 화면에도 무엇을 기다리는지 보여 준다 ('카메라 연결 대기 중'에 멈춰 보이지 않게)
      if (calibration && !calibration.result) progress(reason);
      return;
    }
    if (calibration?.result) return; // '그래도 사용' 버튼을 기다리는 중
    if (calibration) { calibrate(message, now); return; }
    if (!model) return;
    showEyeSize(message.openness);
    if (selected && !GazeDOM.unchanged(selected)) invalidate();
    const wasActive = clicker.active;
    const clicked = clicker.update(message, selected);
    if (clicker.active && !wasActive) {
      // 입을 벌리기 시작한 순간(대상 고정) 직전 0.5초의 예측 위치 평균. 입을 벌리는 동안엔 시선이 흔들릴 수 있다
      const recent = trail.filter(p => now - p.time < 500).map(p => p.raw);
      lockGaze = recent.length ? average(recent) : null;
    }
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
    showDot('#raw', xy); // 빨간 원본 점: 필터 전 시선. 정보 표시와 상관없이 늘 보여 준다
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
      if (clicker.active || document.hidden || performance.now() - lastFrame > 400) return;
      const item = request.items.find(c => c.id === message.id);
      if (!item || !smooth || Math.hypot(...smooth.map((v, k) => v - request.gaze[k])) > 80 ||
          !GazeDOM.unchanged(item)) {
        status(selected ? `마지막 선택 유지: ${selected.name || selected.role}` : message.error || 'Jev 선택 보류 · 대상을 계속 바라보세요.'); return;
      }
      selected = {...item}; showTarget(selected);
      status(`선택: ${item.name || item.role} · ${CLICK_HINT}.`);
    }
  });
  // 단축키는 정보 표시를 켰을 때만: 꺼 두면 사이트의 ESC(창 닫기)·F 키를 가로채지 않는다
  document.addEventListener('keydown', event => { if (host && showInfo && event.key === 'Escape') { event.preventDefault(); stop('ESC로 중지됨'); } }, true);
  document.addEventListener('keydown', event => {
    // event.code는 한글 입력 상태에서도 'KeyF'. Ctrl+F(찾기) 같은 단축키는 건드리지 않는다
    if (!running || !showInfo || event.code !== 'KeyF' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    // 입력칸에 타이핑 중이면 F는 글자로 남겨 둔다
    if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    event.preventDefault();
    nextFilter();
  }, true);
  // 팝업에서 바꾸면 storage가 바뀌고, 열려 있는 탭에도 바로 적용된다
  chrome.storage.local.get('showInfo').then(data => { showInfo = !!data.showInfo; applyInfo(); });
  chrome.storage.onChanged.addListener(changes => {
    if (!changes.showInfo) return;
    showInfo = !!changes.showInfo.newValue;
    applyInfo();
  });
  document.addEventListener('visibilitychange', () => { if (running && document.hidden) { invalidate(); hideCursor(); } });
  window.addEventListener('scroll', () => { if (running) invalidate(); }, true);
})();
