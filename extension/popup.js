const token = document.querySelector('#token');
const status = document.querySelector('#status');
chrome.storage.local.get('pairingToken').then(data => { token.value = data.pairingToken || ''; });
chrome.runtime.sendMessage({type: 'getStatus'}).then(data => {
  if (data?.status) status.textContent = data.status;
});
document.querySelector('#start').onclick = async () => {
  try {
    if (!token.value.trim()) throw new Error('서버의 연결 토큰을 입력하세요.');
    await chrome.storage.local.set({pairingToken: token.value.trim()});
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    const reply = await chrome.runtime.sendMessage({type: 'start', tabId: tab.id, token: token.value.trim()});
    if (reply.error) throw new Error(reply.error);
    window.close();
  } catch (error) { status.textContent = error.message; }
};
document.querySelector('#stop').onclick = async () => {
  await chrome.runtime.sendMessage({type: 'stop'});
  status.textContent = '중지됨';
};
