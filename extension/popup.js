const token = document.querySelector('#token');
const status = document.querySelector('#status');
const quality = document.querySelector('#quality');
const info = document.querySelector('#info');
chrome.storage.local.get(['pairingToken', 'showInfo']).then(data => {
  token.value = data.pairingToken || '';
  info.checked = !!data.showInfo;
});

// 워커가 알려 준 상태를 화면에 반영한다. 실행 중인지에 따라 보이는 버튼이 바뀐다(CSS의 .running)
function render(data) {
  document.body.classList.toggle('running', !!data?.enabled);
  // 실행 중에는 워커의 상태 문구를 쓰지 않는다: Linux에서는 팝업을 여는 것만으로 창 초점이 빠져
  // 문구가 '다른 앱 사용 중'으로 바뀌어서, Chrome을 보고 있는데도 다른 앱에 있다고 나왔다
  if (data?.enabled) status.textContent = '실행 중 · 시선이 어긋나면 다시 보정을 누르세요.';
  else if (data?.status) status.textContent = data.status;
  quality.textContent = Number.isFinite(data?.calibrationError) ? `마지막 보정 · 점 오차 약 ${data.calibrationError}px` : '';
}
async function refresh() {
  render(await chrome.runtime.sendMessage({type: 'getStatus'}).catch(() => null));
}
refresh();
// 시작·중지 직후 상태가 바뀌므로 팝업이 열려 있는 동안 0.5초마다 다시 읽는다
setInterval(refresh, 500);

document.querySelector('#start').onclick = async () => {
  try {
    if (!token.value.trim()) throw new Error('서버의 연결 토큰을 입력하세요.');
    await chrome.storage.local.set({pairingToken: token.value.trim()});
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    // 서비스 워커는 screen을 모르므로 팝업이 지금 모니터의 작업 영역으로 줄일 창 크기를 계산해 보낸다
    const area = {left: screen.availLeft, top: screen.availTop, width: screen.availWidth, height: screen.availHeight};
    // 서버가 창 줄이기를 끄라고 하면(start.sh의 SHRINK_WINDOW=0) 창을 그대로 둔다. 서버가 안 켜져 있으면 줄인다
    const health = await fetch('http://127.0.0.1:8765/health').then(response => response.json()).catch(() => ({}));
    const bounds = health.shrinkWindow === false ? null : GazeCore.windowBounds(area);
    const reply = await chrome.runtime.sendMessage({type: 'start', tabId: tab.id, token: token.value.trim(), bounds});
    if (reply.error) throw new Error(reply.error);
    window.close();
  } catch (error) { status.textContent = error.message; }
};
document.querySelector('#stop').onclick = async () => {
  await chrome.runtime.sendMessage({type: 'stop'});
  refresh();
};
document.querySelector('#recalibrate').onclick = async () => {
  // 지금 보고 있는 탭에서 다시 보정한다(시작과 같은 방법으로 탭을 찾는다)
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  const reply = await chrome.runtime.sendMessage({type: 'recalibrate', tabId: tab.id});
  if (reply?.error) { status.textContent = reply.error; return; }
  // 팝업이 떠 있으면 페이지에 초점이 없어 보정이 시작되지 않으므로 닫는다
  window.close();
};
// 스위치를 바꾸면 저장소에 쓰고, 열려 있는 페이지가 storage 변경을 듣고 바로 반영한다
info.onchange = () => chrome.storage.local.set({showInfo: info.checked});
