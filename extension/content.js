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
  const {predict, Blink, MouthClick, NearestSelector, MovingAverage, ExponentialSmoothing, FixationFilter, jitter, CALIBRATION_POINTS, CALIBRATION_ORDER, gazeRecord, medianGaze, fitPoints, average, correctDrift, eyeRange, eyeSize, suggest, textChange, scrollSpeed, mouthPhase, MOUTH_MAX_MS} = globalThis.GazeCore;
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
  const POINT_TIMEOUT_MS = 2100;  // 그래도 이 시간이 지나면 다음 점으로: 18번 × 2.1초라도 40초를 넘지 않는다
  // 저장된 보정이 어떤 시선 모델·방식으로 만들어졌는지 표시: 둘 중 하나라도 바뀌면 예전 보정은 이어 쓰지 않고 다시 보정한다
  // (GazeTR과 UniGaze는 같은 곳을 봐도 출력 각도가 달라서, 예전 보정 계수를 그대로 쓰면 엉뚱한 곳을 가리킨다)
  const CALIBRATION_METHOD = 'unigaze-points9';
  let currentContext;
  let running = false, host, shadow, model, calibration, smooth, clicker;
  let selected = null, pending = null, requestNumber = 0, lastRequest = 0;
  let lastFrame = 0, history = [], timer, layout, lastStatus = '';
  let ids = new WeakMap(), idNumber = 0;
  let frameIds = new Map(), frameItems = [], frameBusy = false; // iframe 속 후보 (askFrames)
  // 팝업의 '화면에 정보 표시'. 사이트를 방해하지 않도록 기본은 꺼짐.
  // 켜야 왼쪽 아래 정보 상자가 보이고 단축키(F 필터, ESC 중지)가 동작한다
  let showInfo = false;
  let autoKeyboard = true; // 팝업의 '입력칸을 누르면 키보드 표시'
  // 메뉴(입을 2초 넘게 벌렸다 다물기)에서 들어가는 화면: null | 'menu' | 'scroll' | 'tabs' | 'keyboard'
  let mode = null;
  let scrollExit = null, scrollVelocity = 0, scrollBox = null, scrollAimed = 0, scrollFrame = 0, scrollTime = 0;
  let tabList = [], tabPage = 0;
  const TABS_PER_PAGE = 8;
  // 가상 키보드 상태. jamo: 지금 조합 중인 단어의 누른 키들, shown: 그 단어로 입력칸에 이미 넣은 글자
  const kb = {lang: 'ko', shift: false, symbols: false, jamo: [], shown: '', suggestions: [], target: null};
  const KEY_ROWS = {
    ko: ['ㅂㅈㄷㄱㅅㅛㅕㅑㅐㅔ', 'ㅁㄴㅇㄹㅎㅗㅓㅏㅣ', 'ㅋㅌㅊㅍㅠㅜㅡ'],
    koShift: ['ㅃㅉㄸㄲㅆㅛㅕㅑㅒㅖ', 'ㅁㄴㅇㄹㅎㅗㅓㅏㅣ', 'ㅋㅌㅊㅍㅠㅜㅡ'],
    en: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
    symbols: ['1234567890', '.,?!@#-_\'', '()/:;~"+'],
  };
  const wordLists = {}; // lang → Promise<[{word, key}]>, 키보드를 처음 열 때 불러온다

  function send(message) { return chrome.runtime.sendMessage({...message, context: currentContext}).catch(() => {}); }
  function status(text) {
    if (!shadow || lastStatus === text) return;
    lastStatus = text;
    shadow.querySelector('#status').textContent = text;
    send({type: 'uiStatus', message: text});
  }
  function identify(element) {
    if (!ids.has(element)) ids.set(element, `e${++idNumber}`);
    return ids.get(element);
  }
  function invalidate() {
    selected = null; pending = null; history = []; resetFilter(); lockGaze = null;
    requestNumber++; clicker?.reset();
    nearest.reset(); // 스크롤·탭 이동 뒤에는 머무름을 처음부터 다시 잰다
    if (shadow) { shadow.querySelector('#target').hidden = true; shadow.querySelector('#timer').hidden = true; }
  }
  function end(message) {
    running = false; clearInterval(timer); invalidate(); mode = null; resetComposition();
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
    calibration = model ? null : {shownAt: null, step: 0, records: [], log: [],
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
      #dot{position:fixed;width:22px;height:22px;border:6px solid #21dba0;border-radius:50%;background:#111827;transform:translate(-50%,-50%)}
      #guide{position:fixed;top:30%;left:50%;transform:translate(-50%,-50%);font:16px/1.5 system-ui;color:#111827;text-align:center}
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
      /* 입을 벌리는 동안 커서 자리에 시계 방향으로 차는 고리(2초에 가득). 색: 회색 = 아직 짧음, 초록 = 클릭, 빨강 = 대상 없음, 보라 = 메뉴 */
      #timer{position:fixed;width:76px;height:76px;transform:translate(-50%,-50%);--c:#9ca3af}
      #ring{position:absolute;inset:0;border-radius:50%;background:conic-gradient(var(--c) var(--p,0deg),#0b122080 0);-webkit-mask:radial-gradient(circle,transparent 23px,#000 24px);mask:radial-gradient(circle,transparent 23px,#000 24px)}
      #timer.click{--c:#21dba0}#timer.none{--c:#f87171}#timer.menu{--c:#a78bfa}
      #timerLabel{position:absolute;top:calc(100% + 6px);left:50%;transform:translateX(-50%);white-space:nowrap;font:700 18px system-ui;color:#fff;background:#0b1220d9;border-radius:6px;padding:2px 10px}
      /* 메뉴·탭·키보드: 시선 오차가 커도 누를 수 있게 버튼을 화면 크기에 맞춰 크게 만든다 */
      #overlay{position:fixed;inset:0;font-family:system-ui;color:#fff}
      #overlay button{pointer-events:auto;font:700 4.4vh/1.15 system-ui;border-radius:2vh;background:#1f3350;border:3px solid #ffffff30;padding:1vh;overflow:hidden}
      .sheet{position:fixed;inset:0;background:#0b1220;display:grid;gap:2.5vh;padding:5vh 5vw;pointer-events:auto}
      .menu{grid-template:repeat(2,1fr) .7fr/repeat(3,1fr)}
      .wide{grid-column:1/-1}
      .tabs{grid-template:repeat(2,1fr) .6fr/repeat(4,1fr)}
      .tabs .nav{grid-row:3}.tabs .middle{grid-column:2/4}
      #overlay .tab{display:flex;flex-direction:column;justify-content:center;gap:1vh;font-size:3.2vh;text-align:left;padding:2vh}
      .tab b{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
      .tab small{font:500 2.4vh system-ui;color:#9fb3c8}
      #overlay .current{border-color:#21dba0}
      .band{position:fixed;left:0;right:0;height:25vh;background:#176cff30;display:flex;align-items:center;justify-content:center;font:700 6vh system-ui;text-shadow:0 2px 6px #000}
      .up{top:0}.down{bottom:0}
      .hint{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#0b1220cc;border-radius:1.5vh;padding:1.5vh 3vh;font:600 3vh system-ui}
      .keys{position:fixed;left:0;right:0;height:62vh;background:#0b1220f2;display:flex;flex-direction:column;gap:1vh;padding:1.2vh 1vw;pointer-events:auto}
      .keys.bottom{bottom:0}.keys.top{top:0}
      .preview{flex:.55;display:flex;align-items:center;background:#ffffff14;border-radius:1.5vh;padding:0 2vh;font:500 3.2vh system-ui;white-space:nowrap;overflow:hidden}
      .row{flex:1;display:flex;gap:.7vw}
      .row>*{flex:1}
      #overlay .word{font-size:3.6vh;background:#123f36}
      #overlay .space{flex:3}
      #overlay .on{background:#176cff}
      .empty{border-radius:2vh;background:#ffffff08}
      </style>
      <div id="veil"><div id="guide">머리를 고정하고 초록 점을 바라보세요. 점이 작아지면 가운데를 봅니다.<br>회색 점선 원은 다음 점 자리입니다 · 9개 점을 앞으로 한 번, 거꾸로 한 번 · 약 30초</div><div id="next"></div><div id="dot"></div><div id="choices" hidden><button id="use">그래도 사용</button><button id="retry">다시 보정</button></div></div>
      <div id="overlay" hidden></div>
      <div id="raw" hidden></div><div id="cursor" hidden></div><div id="target" hidden></div><div id="timer" hidden><div id="ring"></div><div id="timerLabel"></div></div>
      <div id="panel"><span id="eyes">눈 상태 준비 중</span><span id="mouth"></span><span id="head"></span><span id="quality"></span><span id="drift"></span><span id="eyesize"></span><span id="status"></span><span id="filter"></span><span id="jitter"></span><canvas id="graph" width="200" height="50"></canvas></div>`;
    document.documentElement.appendChild(host);
    // 진짜 마우스로 키를 눌러도 페이지 입력칸의 초점을 빼앗지 않는다
    shadow.querySelector('#overlay').addEventListener('mousedown', event => event.preventDefault());
    shadow.querySelector('#use').onclick = () => finishCalibration(calibration.result);
    shadow.querySelector('#retry').onclick = () => send({type: 'recalibrate'});
    showFilterName();
    shadow.querySelector('#panel').classList.toggle('calibrating', !!calibration);
    applyInfo();
    if (calibration) { showPoint(null); status('9점 보정 · 카메라 연결 대기 중…'); }
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
    // 크게 나타나 작아지는 점이 눈을 끌어당긴다. 작아지는 0.8초가 눈이 옮겨 가는 시간(POINT_SETTLE_MS)이다
    dot.animate([{transform: 'translate(-50%,-50%) scale(3)'}, {transform: 'translate(-50%,-50%) scale(1)'}], POINT_SETTLE_MS);
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
      // 카메라가 늦게 켜져도 첫 점 시간이 먼저 흐르지 않도록 첫 시선 결과에서 시계를 시작한다
      if (!Array.isArray(frame.gaze)) return;
      calibration.shownAt = now;
    }
    // record.time은 점이 나타난 뒤 촬영까지 걸린 시간. 눈이 아직 옮겨 가는 중인 앞부분은 버린다
    const record = gazeRecord(frame, now, calibration.shownAt);
    if (record && record.time >= POINT_SETTLE_MS) {
      annotate(record, frame);
      calibration.records.push(record);
    }
    status(`시선 보정 중 · ${calibration.step + 1}/${CALIBRATION_ORDER.length} · 점이 작아지면 가운데를 바라보세요`);
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
  // 정보 상자를 보일지 정한다. 보정 중에는 안내(진행·얼굴 상태)라서 정보 표시를 꺼 두어도 보인다
  function applyInfo() {
    if (!shadow) return;
    shadow.querySelector('#panel').hidden = !showInfo && !calibration;
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
      shadow.querySelector('#guide').textContent = message;
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
    applyInfo();
    send({type: 'calibrated', model, layout});
    // 상태 줄은 다음 프레임에 바로 바뀌므로 보정 결과는 따로 계속 보여 준다
    shadow.querySelector('#quality').textContent = `보정 결과: 점 오차 약 ${pixelRms}px`;
    status(`준비됨 · 9점 보정 · 점 오차 약 ${pixelRms}px · ${CLICK_HINT}.`);
  }
  function calibrationFailed(message) {
    running = false; clearInterval(timer); invalidate();
    shadow.querySelector('#guide').textContent = message;
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
    // 띄워 둔 큰 버튼(메뉴·탭·키보드)도 후보. 메뉴·탭 화면은 페이지를 덮으므로 그 버튼만 본다
    const own = [...shadow.querySelectorAll('#overlay button:not([hidden])')].map(element => {
      const r = element.getBoundingClientRect(), rect = [r.x, r.y, r.width, r.height];
      return {id: identify(element), element, rect, name: element.textContent, role: 'button', overlay: true, distance: Math.round(GazeCore.distanceToRect(x, y, rect))};
    }).sort((a, b) => a.distance - b.distance);
    if (mode === 'menu' || mode === 'tabs') return own.slice(0, 8);
    const radius = Math.max(100, Math.min(240, (model.error + .06) * Math.min(innerWidth, innerHeight) * 2));
    askFrames(x, y, radius);
    const local = GazeDOM.collect(x, y, radius, identify);
    // iframe 후보는 한 박자 전에 받은 것이라, 거리는 지금 시선으로 다시 잰다
    const inFrames = frameItems.map(item => ({...item, distance: Math.round(GazeCore.distanceToRect(x, y, item.rect))}))
      .filter(item => item.distance <= radius);
    return [...own, ...local, ...inFrames].sort((a, b) => a.distance - b.distance || a.rect[2] * a.rect[3] - b.rect[2] * b.rect[3]).slice(0, 8);
  }
  // 다른 주소의 iframe(네이버 지도 검색 결과 등) 속 요소는 여기서 볼 수 없어서, 워커를 거쳐 그 프레임의 frame.js에 묻는다.
  // 답은 비동기로 오므로 frameItems에 담아 두고 다음 프레임에 쓴다. 좌표는 iframe 내용의 왼쪽 위만큼 옮겨 이 페이지 기준으로 바꾼다
  // shortcut: iframe 속 iframe, CSS transform으로 돌리거나 키운 iframe은 좌표가 어긋난다. 그런 사이트가 나오면 고친다
  function askFrames(x, y, radius) {
    if (frameBusy) return;
    const frames = [];
    for (const iframe of document.querySelectorAll('iframe')) {
      const r = iframe.getBoundingClientRect();
      if (GazeCore.distanceToRect(x, y, [r.x, r.y, r.width, r.height]) > radius) continue;
      let frameId;
      try { frameId = chrome.runtime.getFrameId(iframe); } catch { continue; }
      if (frameId < 0) continue;
      const style = getComputedStyle(iframe);
      frames.push({iframe, frameId, left: r.x + iframe.clientLeft + parseFloat(style.paddingLeft), top: r.y + iframe.clientTop + parseFloat(style.paddingTop)});
    }
    if (!frames.length) { frameItems = []; return; }
    frameBusy = true;
    const asked = currentContext;
    Promise.all(frames.map(frame => send({type: 'frameRelay', frameId: frame.frameId,
      request: {type: 'frameCollect', x: x - frame.left, y: y - frame.top, radius}}).then(items => (Array.isArray(items) ? items : []).map(item => {
      const key = `${frame.frameId}:${item.id}`;
      // Jev 서버는 e+숫자 id만 받으므로 이 페이지의 id 번호를 같이 쓴다
      if (!frameIds.has(key)) frameIds.set(key, `e${++idNumber}`);
      const rect = [item.rect[0] + frame.left, item.rect[1] + frame.top, item.rect[2], item.rect[3]];
      return {...item, id: frameIds.get(key), frameId: frame.frameId, frameItemId: item.id, iframe: frame.iframe, rect};
    })))).then(lists => {
      frameBusy = false;
      // 이 페이지의 다른 요소에 가려진 부분은 뺀다
      if (running && asked === currentContext) frameItems = lists.flat().filter(item => GazeDOM.available(item.iframe, item.rect));
    });
  }
  // 선택된 요소가 그대로인지. iframe 속 요소는 최근에 받은 목록에 같은 자리로 남아 있으면 그대로로 본다(클릭 직전에는 frame.js가 다시 확인)
  function unchanged(item) {
    if (item.overlay) return item.element.isConnected;
    if (item.frameId === undefined) return GazeDOM.unchanged(item);
    return frameItems.some(other => other.id === item.id && other.rect.every((v, k) => Math.abs(v - item.rect[k]) <= 5));
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
    if (!document.hasFocus() || document.hidden || !unchanged(item)) {
      invalidate(); status('대상이 바뀌어 클릭을 취소했습니다.'); return;
    }
    const gaze = lockGaze;
    invalidate();
    if (item.overlay) { item.element.click(); return; }
    if (mode === 'keyboard') resetComposition(); // 페이지를 누르면(추천 목록 등) 입력칸 내용이 바뀔 수 있어 조합을 새로 시작
    if (item.frameId === undefined) { GazeDOM.press(item.element, item.rect); status('클릭 완료'); }
    else send({type: 'frameRelay', frameId: item.frameId, request: {type: 'frameClick', id: item.frameItemId}})
      .then(ok => status(ok ? '클릭 완료' : '대상이 바뀌어 클릭을 취소했습니다.'));
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
    // 보정 중에는 페이지 초점을 따지지 않는다: 점이 화면에 보이기만 하면 되고,
    // Linux에서는 팝업을 열고 닫는 것만으로 초점이 오락가락해서 표본이 빠졌다
    const unfocused = !calibration && !document.hasFocus();
    if (unfocused || document.hidden || !message.valid) {
      invalidate(); hideCursor();
      status(!message.valid ? (message.error || '얼굴을 찾는 중… 카메라를 바라보세요.') : '페이지로 돌아오면 계속합니다.');
      return;
    }
    if (calibration?.result) return; // '그래도 사용' 버튼을 기다리는 중
    if (calibration) { calibrate(message, now); return; }
    if (!model) return;
    showEyeSize(message.openness);
    if (selected && !unchanged(selected)) invalidate();
    const wasActive = clicker.active;
    const clicked = clicker.update(message, mode === 'scroll' ? scrollExit : selected);
    if (!clicker.active) shadow.querySelector('#timer').hidden = true;
    if (clicker.active && !wasActive) {
      // 입을 벌리기 시작한 순간(대상 고정) 직전 0.5초의 예측 위치 평균. 입을 벌리는 동안엔 시선이 흔들릴 수 있다
      const recent = trail.filter(p => now - p.time < 500).map(p => p.raw);
      lockGaze = recent.length ? average(recent) : null;
    }
    if (clicker.active) {
      scrollVelocity = 0;
      showTarget(mode === 'scroll' ? scrollExit : selected);
      if (CLICK_MODE === 'mouth') { mouthStatus(message.time); showTimer(message.time - clicker.started); }
      else if (clicker.started === null) status(selected ? '눈 감기 시작 · 클릭 대상 고정' : '선택된 대상 없음 · 먼저 초록 테두리를 확인하세요.');
      else {
        const elapsed = message.time - clicker.started;
        status(elapsed > 2000 ? menuHint() : !clicker.target ? '눈 감기 감지됨 · 대상 없음 · 2초 넘게 감으면 메뉴' : `대상 고정 · 눈 감기 ${(elapsed / 1000).toFixed(1)}초 · 0.6~2.0초 안에 뜨세요`);
      }
      return;
    }
    if (clicked) { click(clicked); return; }
    // 2초 넘게 벌렸다(감았다) 끝내면 메뉴를 연다. 메뉴가 떠 있으면 닫는다
    if (clicker.result === 'long') setMode(mode === 'menu' ? null : 'menu');
    else if (CLICK_MODE === 'mouth') mouthResult();
    else if (clicker.result === 'no-target') status('눈 감기는 인식됐지만 선택된 대상이 없습니다.');
    else if (clicker.result === 'short') status('짧은 깜빡임 · 클릭하려면 0.6초 이상 감아 주세요.');
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
    if (mode === 'scroll') { aimScroll(smooth, now); return; }
    if (!USE_JEV || mode) { chooseNearest(now); return; }
    const stable = history.slice(-3);
    if (pending || now - lastRequest < 400 || stable.length < 3 || now - stable[0].time < 200) return;
    if (stable.some(p => Math.hypot(p.x - smooth[0], p.y - smooth[1]) > 65)) return;
    const items = candidates(...smooth);
    if (!items.length) { status(selected ? `마지막 선택 유지: ${selected.name || selected.role}` : '시선 주변에 클릭 가능한 요소가 없습니다.'); return; }
    lastRequest = now;
    pending = {requestId: ++requestNumber, sent: now, items, gaze: [...smooth]};
    send({type: 'choose', requestId: pending.requestId, gaze: smooth.map(Math.round),
      history: history.map(p => ({x: p.x, y: p.y, ageMs: Math.round(now - p.time)})),
      candidates: items.map(({id, name, role, rect, distance}) => ({id, name, role, rect, distance}))});
    if (!selected) status('Jev가 클릭 대상을 고르는 중…');
  }
  function mouthStatus(time) {
    const elapsed = time - clicker.started;
    if (elapsed > 2000) status(menuHint());
    else if (!clicker.target) status('입 벌림 감지 · 대상 없음 · 2초 넘게 벌리면 메뉴');
    else status(`대상 고정 · 입 벌림 ${(elapsed / 1000).toFixed(1)}초 · 0.5~2.0초 안에 다무세요`);
  }
  // 입 벌림 진행 고리: 벌린 순간의 커서 자리에 두고, 지금 다물면 무엇이 되는지 색과 글자로 보여 준다
  function showTimer(elapsed) {
    const timer = shadow.querySelector('#timer'), target = clicker.target;
    const [x, y] = smooth || (target ? [target.rect[0] + target.rect[2] / 2, target.rect[1] + target.rect[3] / 2] : [innerWidth / 2, innerHeight / 2]);
    const phase = mouthPhase(elapsed);
    timer.className = phase === 'click' && !target ? 'none' : phase;
    timer.style.left = `${x}px`; timer.style.top = `${y}px`;
    timer.style.setProperty('--p', `${Math.min(1, elapsed / MOUTH_MAX_MS) * 360}deg`);
    shadow.querySelector('#timerLabel').textContent = phase === 'wait' ? '…' : phase === 'menu' ? (mode === 'menu' ? '메뉴 닫기' : '메뉴') :
      !target ? '대상 없음' : target === scrollExit ? '스크롤 끝' : '클릭';
    timer.hidden = false;
  }
  function menuHint() { return mode === 'menu' ? '지금 끝내면 메뉴를 닫습니다' : '지금 끝내면 메뉴를 엽니다'; }
  function mouthResult() {
    if (clicker.result === 'no-target') status('입 벌림은 인식됐지만 선택된 대상이 없습니다.');
    else if (clicker.result === 'short') status('짧게 벌림(말하기 등)은 무시합니다 · 클릭하려면 0.5초 이상 벌려 주세요.');
  }
  function resetFilter() {
    smooth = null; scrollVelocity = 0; // 시선을 잃으면 스크롤도 멈춘다
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
    if (!item) { status(mode ? '버튼을 0.3초 이상 바라보세요.' : '대상을 0.3초 이상 바라보세요.'); return; }
    selected = item;
    showTarget(selected);
    status(`선택: ${item.name || item.role} · ${CLICK_HINT}.`);
  }
  // ── 메뉴·스크롤·탭·키보드 ──
  // 입을 2초 넘게 벌렸다 다물면 메뉴. 띄운 버튼도 페이지 요소처럼 후보가 되어 같은 방법(바라보기 + 입 클릭)으로 누른다.
  // 화면은 상태가 바뀔 때마다 통째로 다시 그린다(render)
  function make(tag, className, text, action) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    if (action) element.onclick = action;
    return element;
  }
  function setMode(next) {
    mode = next; invalidate(); tabPage = 0;
    if (next !== 'keyboard') resetComposition();
    if (next === 'keyboard') { loadWords(kb.lang); kb.target = document.activeElement; }
    if (next === 'scroll' && !scrollFrame) scrollFrame = requestAnimationFrame(scrollStep);
    render();
    status({menu: '메뉴 · 버튼을 바라보고 입을 벌렸다 다무세요', scroll: '스크롤 · 위·아래 띠를 보면 움직이고 가운데를 보면 멈춥니다 · 입을 벌렸다 다물면 끝',
      tabs: '탭 고르기 · 갈 탭을 바라보고 입을 벌렸다 다무세요', keyboard: '키보드 · 키를 바라보고 입을 벌렸다 다무세요'}[next] || '메뉴를 닫았습니다');
  }
  function render() {
    const overlay = shadow.querySelector('#overlay');
    overlay.replaceChildren();
    overlay.hidden = !mode;
    if (mode === 'menu') {
      const sheet = make('div', 'sheet menu');
      sheet.append(
        make('button', '', '← 뒤로', () => { setMode(null); window.history.back(); }),
        make('button', '', '앞으로 →', () => { setMode(null); window.history.forward(); }),
        make('button', '', '⟳ 새로고침', () => { setMode(null); location.reload(); }),
        make('button', '', '↕ 스크롤', () => setMode('scroll')),
        make('button', '', '▦ 탭', openTabs),
        make('button', '', '⌨ 키보드', () => setMode('keyboard')),
        make('button', 'wide', '✕ 닫기', () => setMode(null)));
      overlay.append(sheet);
    }
    if (mode === 'scroll') {
      const exit = make('button', '', '스크롤 끝내기', () => setMode(null));
      exit.hidden = true; // 보이지 않는 버튼: 화면 어디를 보든 입을 벌렸다 다물면 이것이 눌린다
      overlay.append(make('div', 'band up', '▲ 위로'), make('div', 'band down', '▼ 아래로'), make('div', 'hint', '가운데를 보면 멈춤 · 입을 벌렸다 다물면 끝'), exit);
      scrollExit = {id: 'scroll-exit', element: exit, rect: [0, 0, innerWidth, innerHeight], name: '스크롤 끝내기', role: 'button', overlay: true};
    }
    if (mode === 'tabs') {
      const sheet = make('div', 'sheet tabs');
      const last = Math.max(0, Math.ceil(tabList.length / TABS_PER_PAGE) - 1);
      for (const tab of tabList.slice(tabPage * TABS_PER_PAGE, (tabPage + 1) * TABS_PER_PAGE)) {
        const card = make('button', tab.active ? 'tab current' : 'tab', undefined, () => switchTab(tab));
        card.append(make('b', '', tab.title || tab.url), make('small', '', tab.active ? '지금 탭' : new URL(tab.url).hostname));
        sheet.append(card);
      }
      sheet.append(tabPage > 0 ? make('button', 'nav', '◀ 이전', () => { tabPage--; render(); }) : make('div', 'nav'),
        make('button', 'nav middle', '✕ 닫기', () => setMode(null)),
        tabPage < last ? make('button', 'nav', '다음 ▶', () => { tabPage++; render(); }) : make('div', 'nav'));
      overlay.append(sheet);
    }
    if (mode === 'keyboard') overlay.append(keyboardView());
  }
  function aimScroll([x, y], now) {
    scrollVelocity = scrollSpeed(y / innerHeight);
    // 띠 위를 보고 있어도 띠는 마우스를 통과시키므로 그 아래 페이지의 스크롤 상자를 찾는다(디스코드 대화 목록 등)
    scrollBox = scrollVelocity ? GazeDOM.scroller(Math.min(innerWidth - 1, Math.max(0, x)), Math.min(innerHeight - 1, Math.max(0, y)), scrollVelocity) : null;
    scrollAimed = now;
  }
  // 시선은 초당 약 9번 오므로 화면 새로 고침마다 조금씩 움직여 부드럽게 스크롤한다
  function scrollStep(time) {
    if (!running || mode !== 'scroll') { scrollFrame = 0; scrollTime = 0; return; }
    if (scrollTime && scrollVelocity && scrollBox && performance.now() - scrollAimed < 400) scrollBox.scrollBy(0, scrollVelocity * Math.min(50, time - scrollTime) / 1000);
    scrollTime = time;
    scrollFrame = requestAnimationFrame(scrollStep);
  }
  function openTabs() {
    send({type: 'listTabs'}).then(list => {
      if (!running || mode !== 'menu') return;
      tabList = Array.isArray(list) ? list : [];
      setMode('tabs');
      // 지금 탭이 있는 쪽을 먼저 보여 준다
      tabPage = Math.max(0, Math.floor(tabList.findIndex(tab => tab.active) / TABS_PER_PAGE));
      render();
    });
  }
  function switchTab(tab) {
    setMode(null);
    if (tab.active) return;
    // 탭이 바뀌면 워커가 이 페이지를 멈추고 새 탭에 붙인다(보정은 그대로)
    send({type: 'switchTab', tabId: tab.id}).then(ok => { if (!ok && running) status('탭을 바꾸지 못했습니다.'); });
  }
  // 가상 키보드: 일반 자판(두벌식/QWERTY). 한글 조합은 es-hangul(assemble)에 맡긴다
  function keyboardView() {
    const target = document.activeElement;
    const ready = GazeDOM.editable(target);
    // 입력칸이 화면 아래쪽에 있으면(디스코드 등) 키보드를 위에 띄워 칸이 가려지지 않게 한다
    const box = ready && target.getBoundingClientRect();
    const board = make('div', `keys ${ready && box.y + box.height / 2 > innerHeight / 2 ? 'top' : 'bottom'}`);
    board.append(make('div', 'preview', ready ? previewText(target) : '입력칸을 먼저 선택하세요 · 키보드 밖 페이지에서 입력칸을 바라보고 클릭'));
    const words = make('div', 'row');
    for (let i = 0; i < 5; i++) words.append(kb.suggestions[i] ? make('button', 'word', kb.suggestions[i], () => pickWord(kb.suggestions[i])) : make('div', 'empty'));
    board.append(words);
    const rows = kb.symbols ? KEY_ROWS.symbols : kb.lang === 'ko' ? KEY_ROWS[kb.shift ? 'koShift' : 'ko'] : KEY_ROWS.en.map(row => kb.shift ? row.toUpperCase() : row);
    rows.forEach((letters, index) => {
      const row = make('div', 'row');
      if (index === 2 && !kb.symbols) row.append(make('button', kb.shift ? 'on' : '', '⇧', () => { kb.shift = !kb.shift; render(); }));
      for (const letter of letters) row.append(make('button', '', letter, () => typeKey(letter)));
      if (index === 2) row.append(make('button', '', '⌫', backspace));
      board.append(row);
    });
    const controls = make('div', 'row');
    controls.append(
      make('button', '', kb.symbols ? (kb.lang === 'ko' ? '가' : 'abc') : '123', () => { resetComposition(); kb.symbols = !kb.symbols; render(); }),
      make('button', '', kb.lang === 'ko' ? '한→영' : '영→한', () => { resetComposition(); kb.lang = kb.lang === 'ko' ? 'en' : 'ko'; kb.symbols = false; kb.shift = false; loadWords(kb.lang); render(); }),
      make('button', 'space', '스페이스', () => { if (!typingTarget()) return; resetComposition(); GazeDOM.type(0, ' '); render(); }),
      make('button', '', '⏎ 엔터', () => { const target = typingTarget(); if (!target) return; resetComposition(); GazeDOM.enter(target); render(); }),
      make('button', '', '✕ 닫기', () => setMode(null)));
    board.append(controls);
    return board;
  }
  // 키보드 위 줄: 입력칸이 가려져도 무엇이 들어갔는지 보이게 끝부분을 보여 준다
  function previewText(target) {
    const text = 'value' in target && target.tagName !== 'BUTTON' ? target.value : target.innerText;
    const shown = target.type === 'password' ? '•'.repeat(text.length) : text.replace(/\s+/g, ' ');
    return (shown.length > 60 ? `…${shown.slice(-60)}` : shown) + '▏';
  }
  // 글자를 넣을 입력칸. 초점이 다른 칸으로 옮겨 갔으면 조합을 새로 시작한다
  function typingTarget() {
    const target = document.activeElement;
    if (!GazeDOM.editable(target)) { status('입력칸을 먼저 선택하세요.'); return null; }
    if (target !== kb.target) { resetComposition(); kb.target = target; }
    return target;
  }
  function resetComposition() { kb.jamo = []; kb.shown = ''; kb.suggestions = []; }
  // 조합 중인 단어를 다시 만들어 입력칸에서 달라진 끝부분만 바꾼다 ('안' + ㅏ → '아나')
  function compose() {
    const next = kb.lang === 'ko' ? globalThis.Hangul.assemble(kb.jamo) : kb.jamo.join('');
    const {remove, insert} = textChange(kb.shown, next);
    GazeDOM.type(remove, insert);
    kb.shown = next;
    refreshWords();
  }
  function typeKey(letter) {
    if (!typingTarget()) return;
    if (kb.symbols) { resetComposition(); GazeDOM.type(0, letter); render(); return; }
    kb.jamo.push(letter); kb.shift = false;
    compose();
  }
  function backspace() {
    if (!typingTarget()) return;
    if (kb.jamo.length) { kb.jamo.pop(); compose(); return; } // 조합 중이면 자모 하나만 지운다
    GazeDOM.type(1, ''); render();
  }
  function pickWord(word) {
    if (!typingTarget()) return;
    // 대문자로 시작했으면 추천 단어도 대문자로 시작
    const text = kb.lang === 'en' && /^[A-Z]/.test(kb.shown) ? word[0].toUpperCase() + word.slice(1) : word;
    const {remove, insert} = textChange(kb.shown, `${text} `);
    GazeDOM.type(remove, insert);
    resetComposition(); render();
  }
  function loadWords(lang) {
    // 단어 목록: FrequencyWords(자막 빈도, CC-BY-SA 4.0)에서 scripts/build_words.py로 만든 2만 개
    wordLists[lang] ??= fetch(chrome.runtime.getURL(`words/${lang}.json`)).then(response => response.json())
      .then(list => list.map(word => ({word, key: lang === 'ko' ? globalThis.Hangul.disassemble(word) : word})))
      .catch(() => []);
    return wordLists[lang];
  }
  function refreshWords() {
    const shown = kb.shown, lang = kb.lang;
    render();
    if (!shown) return;
    loadWords(lang).then(entries => {
      if (mode !== 'keyboard' || kb.shown !== shown || kb.lang !== lang) return;
      kb.suggestions = suggest(entries, lang === 'ko' ? globalThis.Hangul.disassemble(shown) : shown.toLowerCase(), lang === 'ko' ? shown : shown.toLowerCase());
      render();
    });
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
          !unchanged(item)) {
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
  // 팝업에서 스위치를 바꾸면 storage가 바뀌고, 열려 있는 탭에도 바로 적용된다
  chrome.storage.local.get(['showInfo', 'autoKeyboard']).then(data => { showInfo = !!data.showInfo; autoKeyboard = data.autoKeyboard !== false; applyInfo(); });
  chrome.storage.onChanged.addListener(changes => {
    if (changes.autoKeyboard) autoKeyboard = changes.autoKeyboard.newValue !== false;
    if (!changes.showInfo) return;
    showInfo = !!changes.showInfo.newValue;
    applyInfo();
  });
  document.addEventListener('visibilitychange', () => { if (running && document.hidden) { invalidate(); hideCursor(); } });
  // 스크롤 모드에서는 스크롤할 때마다 초기화하면 필터·입 클릭이 끊기므로 그대로 둔다
  window.addEventListener('scroll', () => { if (running && mode !== 'scroll') invalidate(); }, true);
  // 입력칸에 초점이 오면(시선 클릭·마우스 모두) 키보드를 띄운다. 이미 떠 있으면 미리보기·위치를 새로 그린다
  document.addEventListener('focusin', event => {
    if (!running || !model || calibration || !GazeDOM.editable(event.target)) return;
    if (mode === 'keyboard') { resetComposition(); kb.target = event.target; render(); }
    else if (!mode && autoKeyboard) setMode('keyboard');
  }, true);
  window.addEventListener('blur', () => { if (running) invalidate(); });
})();
