const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');

// stored: 가짜 chrome.storage.local 내용. 같은 객체를 넘기면 워커를 다시 켠 상황을 흉내 낸다
function harness(stored = {}) {
  const handlers = {}, sent = [], sockets = [], injected = [];
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
      query: async () => [{...tabs.get(selected), active: true}],
      sendMessage: async (tabId, message) => {
        if (failSend) { failSend = false; throw new Error('Could not establish connection. Receiving end does not exist.'); }
        sent.push({tabId, ...message}); return {ok: true};
      },
      onActivated: event('activated'), onRemoved: event('removed'), onUpdated: event('updated'),
    },
    scripting: {executeScript: async args => {
      if (failInjection) { failInjection = false; throw new Error('Frame was removed.'); }
      injected.push(args.target.tabId); if (delayedInjection) { const fn = delayedInjection; delayedInjection = null; await fn(); }
    }},
    windows: {WINDOW_ID_NONE: -1, get: async () => ({focused}), onFocusChanged: event('focus')},
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
    current: () => sent.filter(m => m.type === 'start').at(-1),
  };
}

test('tab switch preserves socket and calibration, rejects old responses', async () => {
  const h = harness();
  await h.message({type: 'start', tabId: 1, token: 'test'});
  h.sockets[0].open();
  const a = h.current();
  await h.message({type: 'calibrated', context: a.context, model: {degree: 2}, layout: 'fixed'}, {tab: {id: 1}});
  await h.message({type: 'choose', context: a.context, requestId: 1}, {tab: {id: 1}});
  const oldId = h.sockets[0].messages.find(m => m.type === 'choose').requestId;
  await h.activate(2);
  const b = h.current();
  assert.equal(b.tabId, 2);
  assert.equal(b.calibration.model.degree, 2);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].readyState, 1);
  await h.sockets[0].receive({type: 'selection', requestId: oldId, id: 'e1'});
  assert.equal(h.sent.filter(m => m.type === 'selection').length, 0);
  await h.message({type: 'choose', context: b.context, requestId: 1}, {tab: {id: 2}});
  const id = h.sockets[0].messages.filter(m => m.type === 'choose').at(-1).requestId;
  assert.notEqual(id, oldId);
  await h.sockets[0].receive({type: 'selection', requestId: id, id: 'e2'});
  const reply = h.sent.filter(m => m.type === 'selection').at(-1);
  assert.equal(reply.tabId, 2); assert.equal(reply.requestId, 1); assert.equal(reply.context, b.context);
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
