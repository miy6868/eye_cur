let connection = null;
let enabled = false;
let activeTab = null;
let context = null;
let savedCalibration = null;
let status = '중지됨';
let generation = 0;
let wireId = 0;
const requests = new Map();
let pageRetryTimer = null, pageRetryAttempt = 0;
let socketRetryTimer = null, socketRetryAttempt = 0;
let pairingToken = null;
let savedWindow = null; // 여백을 만들기 전 창 상태: 중지하면 이대로 되돌린다

function retryPage() {
  if (!enabled || pageRetryTimer !== null) return;
  status = '페이지 연결 복구 중… 보정값을 유지합니다.';
  const delay = Math.min(4000, 250 * 2 ** Math.min(pageRetryAttempt++, 4));
  pageRetryTimer = setTimeout(() => {
    pageRetryTimer = null;
    if (enabled) followFocusedTab().catch(retryPage);
  }, delay);
}

function retrySocket() {
  if (!enabled || !pairingToken || socketRetryTimer !== null) return;
  status = '서버 재연결 중… 보정값을 유지합니다.';
  const delay = Math.min(5000, 500 * 2 ** Math.min(socketRetryAttempt++, 4));
  socketRetryTimer = setTimeout(() => {
    socketRetryTimer = null;
    if (enabled && !connection) connect(pairingToken);
  }, delay);
}

async function detach(reason = '다른 탭에서 계속합니다.') {
  const previous = activeTab, previousContext = context;
  activeTab = null; context = null; requests.clear();
  const epoch = ++generation;
  if (connection?.readyState === WebSocket.OPEN) connection.send(JSON.stringify({type: 'cancel'}));
  if (previous !== null) await chrome.tabs.sendMessage(previous, {type: 'suspend', context: previousContext, message: reason}).catch(() => {});
  return epoch;
}

// 창을 줄여 화면 가장자리에 여백을 만든다. 실패해도(타일링 창 관리자 등) 시선 추적은 계속한다
async function shrinkWindow(tabId, bounds) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const window = await chrome.windows.get(tab.windowId);
    // 이미 줄인 상태에서 다시 시작하면 줄인 크기를 원래 크기로 착각하지 않게 처음 것만 기억한다
    if (!savedWindow) {
      savedWindow = {id: window.id, state: window.state, left: window.left, top: window.top, width: window.width, height: window.height};
    }
    // 최대화·전체 화면 상태에서는 크기를 바꿀 수 없어 먼저 보통 창으로 바꾼다
    if (window.state !== 'normal') await chrome.windows.update(window.id, {state: 'normal'});
    await chrome.windows.update(window.id, bounds);
  } catch {}
}

async function restoreWindow() {
  const previous = savedWindow;
  savedWindow = null;
  if (!previous) return;
  try {
    if (previous.state === 'normal') {
      await chrome.windows.update(previous.id, {left: previous.left, top: previous.top, width: previous.width, height: previous.height});
    } else await chrome.windows.update(previous.id, {state: previous.state});
  } catch {}
}

async function stop(reason = '중지됨') {
  enabled = false; savedCalibration = null; status = reason;
  chrome.power.releaseKeepAwake(); // 끝났으니 화면 꺼짐·잠금을 원래대로 돌려준다
  clearTimeout(pageRetryTimer); clearTimeout(socketRetryTimer);
  pageRetryTimer = null; socketRetryTimer = null; pairingToken = null;
  pageRetryAttempt = 0; socketRetryAttempt = 0;
  const old = connection; connection = null;
  if (old) old.close();
  await detach(reason);
  await restoreWindow();
}

async function attach(tabId) {
  const operation = detach();
  const expected = generation;
  await operation;
  if (!enabled || expected !== generation) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const window = await chrome.windows.get(tab.windowId);
    if (!enabled || expected !== generation) return;
    if (!tab.active && window.focused) { await followFocusedTab(); return; }
    if (!window.focused || !/^https?:\/\//.test(tab.url || '')) {
      status = '대기 중 · 일반 웹페이지로 돌아오면 자동으로 계속합니다.'; return;
    }
    await chrome.scripting.executeScript({target: {tabId}, files: ['core.js', 'dom.js', 'content.js']});
    if (!enabled || expected !== generation) return;
    const nextContext = crypto.randomUUID();
    activeTab = tabId; context = nextContext;
    await chrome.tabs.sendMessage(tabId, {type: 'start', context: nextContext, calibration: savedCalibration});
    if (expected === generation) {
      clearTimeout(pageRetryTimer); pageRetryTimer = null; pageRetryAttempt = 0;
    }
    if (expected !== generation) {
      await chrome.tabs.sendMessage(tabId, {type: 'suspend', context: nextContext}).catch(() => {});
    }
  } catch (error) {
    if (expected === generation) {
      activeTab = null; context = null;
      if (/cannot access|permission|extensions gallery|chrome:\/\//i.test(error.message || '')) {
        status = '페이지 접근 권한이 없습니다. 확장 사이트 액세스를 확인하세요.';
      } else retryPage();
    }
  }
}

async function followFocusedTab() {
  if (!enabled) return;
  const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  if (tab && enabled && tab.id !== activeTab) await attach(tab.id);
}

function connect(token) {
  const socket = new WebSocket('ws://127.0.0.1:8765/ws');
  connection = socket;
  socket.onopen = () => {
    if (connection !== socket || !enabled) { socket.close(); return; }
    socket.send(JSON.stringify({type: 'auth', token}));
    if (activeTab === null) followFocusedTab().catch(retryPage);
  };
  socket.onmessage = async event => {
    if (connection !== socket || !enabled) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'error') {
      if (message.recoverable) {
        connection = null; socket.close(); await detach(); retrySocket();
      } else await stop(message.error);
      return;
    }
    if (message.type === 'frame') socketRetryAttempt = 0;
    if (message.type === 'status') status = message.message;
    if (message.type === 'selection') {
      const route = requests.get(message.requestId); requests.delete(message.requestId);
      if (!route || route.context !== context || route.tabId !== activeTab) return;
      message = {...message, requestId: route.requestId};
    }
    if (activeTab === null) return;
    const destination = activeTab, destinationContext = context;
    await chrome.tabs.sendMessage(destination, {...message, context: destinationContext}).catch(() => {
      if (activeTab === destination && context === destinationContext) {
        const operation = detach('페이지 연결 복구 중…');
        const expected = generation;
        operation.then(() => { if (enabled && expected === generation) retryPage(); });
      }
    });
  };
  socket.onclose = async event => {
    if (connection !== socket) return;
    connection = null;
    if (event?.code === 1008) { await stop('서버 인증 실패 · 연결 토큰을 확인하세요.'); return; }
    await detach('서버 재연결 중…');
    retrySocket();
  };
  // The close event schedules one retry; error must not erase calibration.
  socket.onerror = () => { if (connection === socket) status = '서버 응답 대기 중… 자동 재연결합니다.'; };
}

// 보정이 화면과 맞지 않게 되면 메모리와 브라우저 저장소에서 모두 지운다
function forgetCalibration() {
  savedCalibration = null;
  chrome.storage.local.remove('calibration');
}

async function start(tabId, token, bounds) {
  pairingToken = token;
  clearTimeout(socketRetryTimer); socketRetryTimer = null;
  // 지난 세션의 보정을 불러온다. ESC로 끄거나 브라우저를 다시 켜도 보정을 처음부터 하지 않는다
  // 창 크기·위치가 달라졌으면 content.js가 layout을 비교해 새로 보정한다
  const stored = await chrome.storage.local.get('calibration');
  savedCalibration = stored.calibration || null;
  // 페이지에 보정 화면을 띄우기 전에 창을 줄여야 줄어든 화면 기준으로 보정한다
  if (bounds) await shrinkWindow(tabId, bounds);
  enabled = true;
  // 눈과 입으로만 쓰면 키보드·마우스 입력이 없어서 운영체제가 쉬는 중으로 보고 화면을 어둡게 하거나 잠근다
  // (Hyprland hypridle은 4.5분에 어둡게, 5분에 잠금). 화면이 어두워지면 얼굴도 어두워져 인식이 멈추므로 실행 중에는 화면을 켜 둔다
  chrome.power.requestKeepAwake('display');
  if (!connection || connection.readyState > WebSocket.OPEN) connect(token);
  await attach(tabId);
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type === 'getStatus') {
    // 팝업이 보여 줄 것: 상태 문구, 실행 중인지, 마지막 보정의 점 오차(px)
    reply({status, enabled, calibrationError: savedCalibration?.model?.pixelError ?? null}); return;
  }
  if (message.type === 'start' && !sender.tab) {
    start(message.tabId, message.token, message.bounds).then(() => reply({ok: true})).catch(error => reply({error: error.message}));
    return true;
  }
  const current = sender.tab?.id === activeTab && message.context === context;
  if (message.type === 'stop' && (!sender.tab || current)) {
    stop(message.reason).then(() => reply({ok: true})); return true;
  }
  // 팝업의 다시 보정(sender.tab 없음): 팝업이 알려 준 탭에 새로 붙인다.
  // Linux에서는 팝업을 여는 것만으로 창 초점이 빠져 페이지가 이미 떼어져 있을 수 있어서 activeTab을 쓰지 않는다.
  // 그때 attach는 '대기 중'으로 끝나고, 팝업이 닫혀 Chrome 창에 초점이 돌아오면 저장된 보정 없이 붙어 보정부터 한다
  if (message.type === 'recalibrate' && !sender.tab) {
    if (!enabled) { reply({error: '먼저 시작을 누르세요.'}); return; }
    forgetCalibration(); attach(message.tabId).then(() => reply({ok: true})); return true;
  }
  if (!current || !enabled) return;
  if (message.type === 'calibrated') {
    savedCalibration = {model: message.model, layout: message.layout};
    // 메모리는 ESC 중지·브라우저 종료 때 사라지므로 다음 세션을 위해 저장소에도 남긴다
    chrome.storage.local.set({calibration: savedCalibration});
    reply({ok: true}); return;
  }
  if (message.type === 'recalibrate') {
    forgetCalibration(); attach(activeTab).then(() => reply({ok: true})); return true;
  }
  if (message.type === 'calibrationInvalid') { forgetCalibration(); return; }
  if (message.type === 'choose' && connection?.readyState === WebSocket.OPEN) {
    const id = ++wireId;
    requests.clear();
    requests.set(id, {tabId: activeTab, context, requestId: message.requestId});
    connection.send(JSON.stringify({...message, requestId: id})); reply({ok: true}); return;
  }
  if (message.type === 'calibrationLog' && connection?.readyState === WebSocket.OPEN) {
    connection.send(JSON.stringify(message)); return;
  }
  if (message.type === 'uiStatus') status = message.message;
});
chrome.tabs.onActivated.addListener(info => {
  if (!enabled) return;
  chrome.windows.get(info.windowId).then(window => { if (enabled && window.focused) attach(info.tabId); });
});
chrome.tabs.onRemoved.addListener(id => { if (enabled && id === activeTab) followFocusedTab(); });
chrome.tabs.onUpdated.addListener((id, change) => {
  if (!enabled) return;
  if (id === activeTab && change.status === 'loading') {
    const operation = detach('페이지 로딩 중…');
    const expected = generation;
    operation.then(() => { if (enabled && expected === generation) retryPage(); });
  }
  if (change.status === 'complete') {
    chrome.tabs.query({active: true, lastFocusedWindow: true}).then(([tab]) => {
      if (enabled && tab?.id === id && activeTab !== id) attach(id);
    });
  }
});
chrome.windows.onFocusChanged.addListener(id => {
  if (!enabled) return;
  if (id === chrome.windows.WINDOW_ID_NONE) { status = '다른 앱 사용 중 · Chrome으로 돌아오면 계속합니다.'; detach(); }
  else followFocusedTab();
});
