const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');

// stored: 가짜 chrome.storage.local 내용. 같은 객체를 넘기면 워커를 다시 켠 상황을 흉내 낸다
function harness(stored = {}) {
  const handlers = {}, sent = [], sockets = [], injected = [];
  let keepAwake = null; // 가짜 chrome.power: 지금 요청 중인 화면 유지 단계
  const event = name => ({addListener: fn => { handlers[name] = fn; }});
  let selected = 1;
  let focused = true;
  let delayedInjection = null;
  let failSend = false, failInjection = false, nextTimer = 0;
  const timers = new Map();
  const tabs = new Map([1, 2, 3].map(id => [id, {id, windowId: 1, url: id === 3 ? 'chrome://settings' : `https://example${id}.com/`}]));
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 0; this.messages = []; sockets.push(this); }
    send(text) { this.messages.push(JSON.parse(text)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen(); }
    receive(message) { return this.onmessage({data: JSON.stringify(message)}); }
  }
  const chrome = {
    runtime: {onMessage: event('message')},
    tabs: {
      get: async id => ({...tabs.get(id), active: id === selected}),
      // windowId로 물으면(탭 고르기 화면) 그 창의 탭 전체, 아니면 지금 보이는 탭 하나
      query: async query => query?.windowId ? [...tabs.values()].map(tab => ({...tab, title: `탭${tab.id}`, active: tab.id === selected})) : [{...tabs.get(selected), active: true}],
      update: async (id, props) => { if (props.active) { selected = id; handlers.activated({tabId: id, windowId: 1}); } return tabs.get(id); },
      sendMessage: async (tabId, message, options) => {
        if (failSend) { failSend = false; throw new Error('Could not establish connection. Receiving end does not exist.'); }
        sent.push({tabId, ...message, ...options}); return {ok: true};
      },
      onActivated: event('activated'), onRemoved: event('removed'), onUpdated: event('updated'),
    },
    scripting: {executeScript: async args => {
      if (failInjection) { failInjection = false; throw new Error('Frame was removed.'); }
      injected.push(args.target.tabId); if (delayedInjection) { const fn = delayedInjection; delayedInjection = null; await fn(); }
    }},
    windows: {WINDOW_ID_NONE: -1, get: async () => ({id: 1, focused}), onFocusChanged: event('focus')},
    power: {requestKeepAwake: level => { keepAwake = level; }, releaseKeepAwake: () => { keepAwake = null; }},
    storage: {local: {
      get: async key => (key in stored ? {[key]: stored[key]} : {}),
      set: async items => { Object.assign(stored, items); },
      remove: async key => { delete stored[key]; },
    }},
  };
  vm.runInNewContext(fs.readFileSync('extension/worker.js', 'utf8'), {
    chrome, WebSocket: Socket, crypto: {randomUUID}, console,
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
  const message = async (body, sender = {}) => {
    let response;
    handlers.message(body, sender, reply => { response = reply; });
    await flush(); return response;
  };
  return {sent, sockets, injected, handlers, message, flush,
    activate: async id => { selected = id; handlers.activated({tabId: id, windowId: 1}); await flush(); },
    focus: async value => { focused = value; handlers.focus(value ? 1 : -1); await flush(); },
    delayNext: fn => { delayedInjection = fn; },
    failNextSend: () => { failSend = true; },
    failNextInjection: () => { failInjection = true; },
    retry: async () => { const batch = [...timers.values()]; timers.clear(); for (const fn of batch) fn(); await flush(); },
    timerCount: () => timers.size,
    keepAwake: () => keepAwake,
    current: () => sent.filter(m => m.type === 'start').at(-1),
  };
}

test('tab switch preserves socket and calibration; server frames go only to the new tab', async () => {
  const h = harness();
  await h.message({type: 'start', tabId: 1, token: 'test'});
  h.sockets[0].open();
  const a = h.current();
  await h.message({type: 'calibrated', context: a.context, model: {degree: 2}, layout: 'fixed'}, {tab: {id: 1}});
  await h.activate(2);
  const b = h.current();
  assert.equal(b.tabId, 2);
  assert.equal(b.calibration.model.degree, 2);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].readyState, 1);
  await h.sockets[0].receive({type: 'frame', valid: true});
  const frame = h.sent.filter(m => m.type === 'frame').at(-1);
  assert.equal(frame.tabId, 2); assert.equal(frame.context, b.context);
  // 옛 탭의 페이지 메시지는 무시한다
  assert.equal(await h.message({type: 'calibrated', context: a.context, model: {degree: 9}, layout: 'fixed'}, {tab: {id: 1}}), undefined);
});

test('calibration survives ESC stop and worker restart; recalibrate and invalid layout forget it', async () => {
  const stored = {};
  const h = harness(stored); await h.message({type: 'start', tabId: 1, token: 'test'}); h.sockets[0].open();
  assert.equal(h.current().calibration, null);
  await h.message({type: 'calibrated', context: h.current().context, model: {degree: 2}, layout: 'fixed'}, {tab: {id: 1}});
  await h.message({type: 'stop', context: h.current().context, reason: 'ESC로 중지됨'}, {tab: {id: 1}});
  await h.message({type: 'start', tabId: 1, token: 'test'});
  assert.equal(h.current().calibration.model.degree, 2);
  // 새 워커(브라우저 재시작)도 같은 저장소에서 보정을 불러온다
  const fresh = harness(stored); await fresh.message({type: 'start', tabId: 1, token: 'test'});
  assert.equal(fresh.current().calibration.layout, 'fixed');
  await fresh.message({type: 'recalibrate', context: fresh.current().context}, {tab: {id: 1}});
  assert.equal(fresh.current().calibration, null);
  assert.equal(stored.calibration, undefined);
  await fresh.message({type: 'calibrated', context: fresh.current().context, model: {degree: 1}, layout: 'fixed'}, {tab: {id: 1}});
  await fresh.message({type: 'calibrationInvalid', context: fresh.current().context}, {tab: {id: 1}});
  assert.equal(stored.calibration, undefined);
});

test('missing page receiver retries without load-complete event and preserves calibration', async () => {
  const h = harness(); await h.message({type: 'start', tabId: 1, token: 'test'}); h.sockets[0].open();
  await h.message({type: 'calibrated', context: h.current().context, model: {degree: 2}, layout: 'fixed'}, {tab: {id: 1}});
  h.failNextSend();
  await h.sockets[0].receive({type: 'frame'}); await h.flush();
  assert.equal(h.timerCount(), 1);
  h.failNextInjection();
  await h.retry();
  assert.equal(h.timerCount(), 1);
  await h.retry();
  assert.equal(h.current().calibration.model.degree, 2);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.timerCount(), 0);
});

test('temporary socket closure reconnects with the saved model; stop cancels recovery', async () => {
  const h = harness(); await h.message({type: 'start', tabId: 1, token: 'test'}); h.sockets[0].open();
  await h.message({type: 'calibrated', context: h.current().context, model: {degree: 2}, layout: 'fixed'}, {tab: {id: 1}});
  h.sockets[0].readyState = 3;
  await h.sockets[0].onclose({code: 1006});
  assert.equal(h.timerCount(), 1);
  await h.retry(); h.sockets[1].open(); await h.flush();
  assert.equal(h.current().calibration.model.degree, 2);
  assert.equal(h.sockets[1].messages[0].type, 'auth');
  h.sockets[1].readyState = 3; await h.sockets[1].onclose({code: 1006});
  await h.message({type: 'stop'}); await h.retry();
  assert.equal(h.sockets.length, 2);
  assert.equal(h.timerCount(), 0);
});

test('invalid pairing token is terminal, recoverable busy error retries', async () => {
  const h = harness(); await h.message({type: 'start', tabId: 1, token: 'test'}); h.sockets[0].open();
  await h.sockets[0].receive({type: 'error', recoverable: true, error: 'busy'});
  assert.equal(h.timerCount(), 1);
  await h.retry(); h.sockets[1].open(); await h.flush();
  h.sockets[1].readyState = 3; await h.sockets[1].onclose({code: 1008});
  assert.equal(h.timerCount(), 0);
  assert.equal((await h.message({type: 'getStatus'})).enabled, false);
});

test('restricted tabs and external apps pause; returning resumes without camera reconnect', async () => {
  const h = harness(); await h.message({type: 'start', tabId: 1, token: 'test'}); h.sockets[0].open();
  await h.activate(3);
  const count = h.sent.length;
  await h.sockets[0].receive({type: 'frame'});
  assert.equal(h.sent.length, count);
  await h.activate(2);
  // 보정을 마친 뒤에만 다른 앱에서 멈춘다(보정 중에는 초점과 상관없다)
  await h.message({type: 'calibrated', context: h.current().context, model: {degree: 1}, layout: 'fixed'}, {tab: {id: 2}});
  await h.focus(false);
  const paused = h.sent.length;
  await h.sockets[0].receive({type: 'frame'});
  assert.equal(h.sent.length, paused);
  await h.focus(true);
  assert.equal(h.current().tabId, 2);
  assert.equal(h.sockets.length, 1);
});

test('navigation reattaches and delayed activation cannot revive the old tab', async () => {
  const h = harness(); await h.message({type: 'start', tabId: 1, token: 'test'}); h.sockets[0].open();
  h.handlers.updated(1, {status: 'loading'}); await h.flush();
  h.handlers.updated(1, {status: 'complete'}); await h.flush();
  assert.equal(h.sent.filter(m => m.type === 'start' && m.tabId === 1).length, 2);
  let release;
  h.delayNext(() => new Promise(resolve => { release = resolve; }));
  await h.activate(2);
  await h.activate(1);
  release(); await h.flush();
  assert.equal(h.current().tabId, 1);
  await h.message({type: 'stop'});
  const count = h.sent.length;
  await h.activate(2);
  assert.equal(h.sent.length, count);
  assert.equal(h.sockets[0].readyState, 3);
});

test('calibration log from the current page is forwarded to the server', async () => {
  const h = harness();
  await h.message({type: 'start', tabId: 1, token: 'test'});
  h.sockets[0].open();
  await h.message({type: 'calibrationLog', context: h.current().context, lag: 100}, {tab: {id: 1}});
  assert.equal(h.sockets[0].messages.find(m => m.type === 'calibrationLog').lag, 100);
});

test('screen stays awake while running and is released on stop', async () => {
  const h = harness(); await h.message({type: 'start', tabId: 1, token: 'test'});
  // 눈으로만 쓰는 동안 화면이 어두워지거나 잠기지 않게 한다
  assert.equal(h.keepAwake(), 'display');
  await h.message({type: 'stop'});
  assert.equal(h.keepAwake(), null);
});

test('popup recalibrates the viewed tab and shows the last calibration error', async () => {
  const h = harness(); await h.message({type: 'start', tabId: 1, token: 'test'}); h.sockets[0].open();
  await h.message({type: 'calibrated', context: h.current().context, model: {degree: 1, pixelError: 85}, layout: 'fixed'}, {tab: {id: 1}});
  assert.equal((await h.message({type: 'getStatus'})).calibrationError, 85);
  // 팝업에서 온 메시지에는 sender.tab이 없다
  assert.equal((await h.message({type: 'recalibrate', tabId: 1})).ok, true);
  assert.equal(h.current().calibration, null);
  assert.equal((await h.message({type: 'getStatus'})).calibrationError, null);
});

test('popup recalibrate works after opening the popup dropped window focus (Linux)', async () => {
  const h = harness(); await h.message({type: 'start', tabId: 1, token: 'test'}); h.sockets[0].open();
  await h.message({type: 'calibrated', context: h.current().context, model: {degree: 1}, layout: 'fixed'}, {tab: {id: 1}});
  await h.focus(false); // 팝업을 열면 창 초점이 NONE이 되어 페이지가 떼어진다
  const starts = h.sent.filter(m => m.type === 'start').length;
  // 초점이 없어도 보정은 바로 붙어서 시작한다
  assert.equal((await h.message({type: 'recalibrate', tabId: 1})).ok, true);
  assert.equal(h.sent.filter(m => m.type === 'start').length, starts + 1);
  assert.equal(h.current().calibration, null);
  // 팝업이 닫혀 초점이 돌아와도 같은 탭이라 보정을 처음부터 다시 하지 않는다
  await h.focus(true);
  assert.equal(h.sent.filter(m => m.type === 'start').length, starts + 1);
});

test('calibration ignores window focus: it keeps going when focus leaves Chrome', async () => {
  const h = harness(); await h.message({type: 'start', tabId: 1, token: 'test'}); h.sockets[0].open();
  const context = h.current().context;
  await h.focus(false);
  // 떼어 내지 않았으므로 프레임이 그대로 페이지로 간다
  assert.equal(h.sent.filter(m => m.type === 'suspend').length, 0);
  await h.sockets[0].receive({type: 'frame'});
  assert.equal(h.sent.at(-1).type, 'frame');
  assert.equal(h.sent.at(-1).context, context);
});

test('starting without a saved calibration attaches even when the window has no focus', async () => {
  const h = harness();
  await h.focus(false); // 리눅스에서 팝업이 열려 있는 상태
  await h.message({type: 'start', tabId: 1, token: 'test'});
  assert.equal(h.current().tabId, 1);
  assert.equal(h.current().calibration, null);
});

test('popup recalibrate while stopped explains what to do', async () => {
  const h = harness();
  assert.match((await h.message({type: 'recalibrate', tabId: 1})).error, /시작/);
});

test('frameRelay forwards only collect/click to the active tab frame, from the current page', async () => {
  const h = harness(); await h.message({type: 'start', tabId: 1, token: 'test'}); h.sockets[0].open();
  const {context} = h.current();
  const reply = await h.message({type: 'frameRelay', context, frameId: 7, request: {type: 'frameClick', id: 'e1'}}, {tab: {id: 1}});
  assert.deepEqual(reply, {ok: true});
  const relayed = h.sent.at(-1);
  assert.equal(relayed.tabId, 1); assert.equal(relayed.frameId, 7); assert.equal(relayed.type, 'frameClick');
  const count = h.sent.length;
  await h.message({type: 'frameRelay', context, frameId: 7, request: {type: 'start'}}, {tab: {id: 1}});
  await h.message({type: 'frameRelay', context: 'old', frameId: 7, request: {type: 'frameClick'}}, {tab: {id: 1}});
  assert.equal(h.sent.length, count);
});

test('tab picker lists only web tabs of the window and switches to the chosen one', async () => {
  const h = harness(); await h.message({type: 'start', tabId: 1, token: 'test'}); h.sockets[0].open();
  const a = h.current(), sender = {tab: {id: 1, windowId: 1}};
  const list = await h.message({type: 'listTabs', context: a.context}, sender);
  assert.deepEqual(list.map(tab => tab.id), [1, 2]); // chrome:// 탭(3)은 가면 돌아올 수 없어 뺀다
  assert.equal(list[0].active, true);
  assert.equal(await h.message({type: 'listTabs', context: 'old'}, sender), undefined);
  assert.equal(await h.message({type: 'switchTab', context: a.context, tabId: 2}, sender), true);
  await h.flush();
  assert.equal(h.current().tabId, 2);
  assert.notEqual(h.current().context, a.context);
});
