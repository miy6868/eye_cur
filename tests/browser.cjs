/* Headless integration test: real DOM + content script, deterministic gaze/API messages. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_PATH || 'playwright');

(async () => {
  const browser = await playwright.chromium.launch({headless: true,
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  try {
    const page = await browser.newPage({viewport: {width: 1200, height: 900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(fs.readFileSync(path.join(__dirname, '../demo.html'), 'utf8'));
    await page.evaluate(() => {
      window.clock = 1000; window.sent = []; window.listener = null;
      Object.defineProperty(performance, 'now', {value: () => window.clock});
      document.hasFocus = () => true;
      const attachShadow = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (options) {
        const root = attachShadow.call(this, options); window.gazeShadow = root; return root;
      };
      window.chrome = {runtime: {sendMessage: async message => { window.sent.push(message); },
        onMessage: {addListener: callback => { window.listener = callback; }}},
        storage: {local: {get: async () => ({})}, onChanged: {addListener: () => {}}}};
      window.tick = (gaze, closed = false, dt = 100, valid = true) => {
        window.clock += dt;
        window.listener({type: 'frame', gaze, closed, valid, time: window.clock});
      };
    });
    await page.addScriptTag({path: path.join(__dirname, '../extension/vendor/es-hangul.js')});
    await page.addScriptTag({path: path.join(__dirname, '../extension/core.js')});
    await page.addScriptTag({path: path.join(__dirname, '../extension/dom.js')});
    await page.addScriptTag({path: path.join(__dirname, '../extension/content.js')});
    await page.evaluate(async () => {
      window.listener({type: 'start'});
      for (let tick = 0; tick < 1000; tick++) {
        // 움직이는 점은 requestAnimationFrame에서 위치가 바뀐다
        await new Promise(requestAnimationFrame);
        const dot = window.gazeShadow.querySelector('#dot');
        const point = [parseFloat(dot.style.left) / 100, parseFloat(dot.style.top) / 100];
        const gaze = [point[0] * .4 - .2, point[1] * .3 - .1];
        window.tick(gaze);
        if (window.sent.filter(m => m.type === 'uiStatus').at(-1)?.message.startsWith('준비됨')) break;
      }
    });
    assert.match(await page.evaluate(() => window.sent.filter(m => m.type === 'uiStatus').at(-1).message), /준비됨/);
    assert.ok(await page.evaluate(() => window.sent.some(m => m.type === 'uiStatus' && m.message.startsWith('시선 보정 중'))));
    assert.ok(await page.evaluate(() => window.sent.some(m => m.type === 'calibrated')));
    assert.equal(await page.evaluate(() => {
      let acknowledgements = 0;
      window.listener({type: 'status', message: 'ready'}, {}, () => acknowledgements++);
      window.listener({type: 'frame', valid: false, time: window.clock}, {}, () => acknowledgements++);
      window.listener({type: 'selection', requestId: -1, context: 'obsolete'}, {}, () => acknowledgements++);
      return acknowledgements;
    }), 3);

    const target = await page.locator('button').first().boundingBox();
    const gaze = [(target.x + target.width / 2) / 1200 * .4 - .2, (target.y + target.height / 2) / 900 * .3 - .1];
    async function aimAndSelect(step = 100) {
      await page.evaluate(({g, step}) => {
        for (let i = 0; i < 8; i++) window.tick(g, false, step);
        const request = window.sent.filter(m => m.type === 'choose').at(-1);
        if (!request) throw new Error('No choose request');
        const candidate = request.candidates.find(c => c.name === '왼쪽 위');
        if (!candidate) throw new Error('Expected button absent from candidates');
        window.listener({type: 'selection', requestId: request.requestId, id: candidate.id});
      }, {g: gaze, step});
    }
    await aimAndSelect(350); // Slow CPU gaze updates must still produce a target.
    await page.evaluate(g => { window.tick(g, true); window.tick(g, false, 150); }, gaze);
    assert.match(await page.locator('#result').innerText(), /아직/);
    await aimAndSelect();
    await page.evaluate(g => {
      // A declined Jev response and a prolonged gaze departure retain the last selection.
      for (let i = 0; i < 8; i++) window.tick(g);
      const req = window.sent.filter(m => m.type === 'choose').at(-1);
      window.listener({type: 'selection', requestId: req.requestId, id: 'none'});
      if (window.gazeShadow.querySelector('#target').hidden) throw new Error('Declined choice erased last selection');
      for (let i = 0; i < 30; i++) window.tick([20, 20]);
      if (window.gazeShadow.querySelector('#target').hidden) throw new Error('Last selection expired while gaze moved away');
      // One gaze spike immediately before eyelid descent must not erase the target.
      window.tick([20, 20], false, 50);
      window.clock += 50;
      window.listener({type: 'frame', gaze: [20, 20], valid: true, closed: false, closing: true, time: window.clock});
      if (!window.gazeShadow.querySelector('#status').textContent.includes('대상 고정')) throw new Error('Target was not frozen at eyelid descent');
      window.tick(g, true); window.tick(g, true, 300); window.tick(g, true, 300); window.tick(g, false, 100);
    }, gaze);
    assert.equal(await page.locator('#result').innerText(), '1회 클릭: 왼쪽 위');

    // In-flight replies must not revive a selection after a scroll.
    await aimAndSelect();
    await page.evaluate(g => {
      const req = window.sent.filter(m => m.type === 'choose').at(-1);
      window.dispatchEvent(new Event('scroll'));
      window.listener({type: 'selection', requestId: req.requestId, id: req.candidates[0].id});
      window.tick(g, true); window.tick(g, true, 300); window.tick(g, true, 300); window.tick(g, false, 100);
    }, gaze);
    assert.equal(await page.locator('#result').innerText(), '1회 클릭: 왼쪽 위');

    // Removing a selected element while the eyes are closed cancels activation.
    await aimAndSelect();
    await page.evaluate(g => {
      window.tick(g, true); document.querySelector('button').remove();
      window.tick(g, true, 300); window.tick(g, true, 300); window.tick(g, false, 100);
    }, gaze);
    assert.equal(await page.locator('#result').innerText(), '1회 클릭: 왼쪽 위');
    assert.deepEqual(errors, []);

    // Reattach to another tab/document context using the session calibration.
    await page.evaluate(() => {
      const saved = window.sent.find(m => m.type === 'calibrated');
      window.listener({type: 'suspend'});
      window.listener({type: 'start', context: 'tab-b', calibration: {model: saved.model, layout: saved.layout}});
      if (!window.gazeShadow.querySelector('#veil').hidden) throw new Error('Calibration was not restored');
      window.listener({type: 'suspend', context: 'old-tab'});
      if (!window.gazeShadow.host.isConnected) throw new Error('Old context suspended new tab');
    });
    await page.keyboard.press('Escape');
    assert.ok(await page.evaluate(() => window.sent.some(m => m.type === 'stop')));
    console.log('PASS: moving-dot calibration, DOM candidates, blink click, stale reply, removed element, calibration transfer, ESC');

    // Search-result layout: inline zero-height parent, multiline heading and covered links.
    await page.evaluate(html => { document.body.innerHTML = html; }, `<style>body{margin:30px}h3{font:24px/1.3 Arial;width:260px}a{color:blue}.cover{position:absolute;inset:0;background:white;z-index:2}</style>
      <a id="result-link" href="#destination" style="display:contents"><span>Example site breadcrumb</span><h3><span role="link" tabindex="0">A long website title that wraps over multiple lines</span></h3></a>
      <div style="position:relative;width:200px"><a id="covered" href="#wrong">Covered link</a><div class="cover"></div></div>
      <output id="clicked"></output>`);
    const domResult = await page.evaluate(() => {
      const anchor = document.querySelector('#result-link');
      anchor.addEventListener('click', event => { event.preventDefault(); document.querySelector('#clicked').textContent = 'right-link'; });
      let next = 0;
      const heading = document.querySelector('h3').getBoundingClientRect();
      const found = GazeDOM.collect(heading.left + 20, heading.top + 12, 500, () => `e${++next}`);
      const item = found.find(i => i.element === anchor);
      if (!item || !GazeDOM.unchanged(item)) throw new Error('Search title not clickable');
      if (found.filter(i => i.element === anchor).length !== 1) throw new Error('Duplicate nested target');
      if (found.some(i => i.element.id === 'covered')) throw new Error('Covered link was offered');
      item.element.click();
      anchor.href = '#changed';
      if (GazeDOM.unchanged(item)) throw new Error('Changed destination accepted');
      return {name: item.name, count: GazeDOM.regions(anchor).length};
    });
    assert.equal(await page.locator('#clicked').innerText(), 'right-link');
    assert.match(domResult.name, /^A long website title/);
    assert.ok(domResult.count > 1);
    console.log('PASS: search-title fragments, actionable ancestor, deduplication, occlusion, changed href');


    await page.evaluate(() => {
      window.listener({type: 'start', context: 'failed-calibration'});
      for (let i = 0; i < 1000; i++) {
        window.clock += 100;
        window.listener({type: 'frame', context: 'failed-calibration', gaze: [.1, .2], valid: true, closed: false, time: window.clock});
        if (window.sent.some(m => m.type === 'calibrationInvalid' && m.context === 'failed-calibration')) break;
      }
      if (!window.sent.some(m => m.type === 'calibrationInvalid' && m.context === 'failed-calibration')) throw new Error('Expected calibration failure');
      if (window.sent.some(m => m.type === 'stop' && m.context === 'failed-calibration')) throw new Error('Calibration failure stopped whole session');
      if (window.gazeShadow.querySelector('#veil').hidden) throw new Error('Failure UI was dismissed');
      window.gazeShadow.querySelector('#recalibrate').click();
      if (!window.sent.some(m => m.type === 'recalibrate' && m.context === 'failed-calibration')) throw new Error('Retry button not connected');
    });
    await page.keyboard.press('Escape');
    assert.ok(await page.evaluate(() => window.sent.some(m => m.type === 'stop' && m.context === 'failed-calibration')));
    console.log('PASS: failed calibration retains session, retry remains available, ESC still stops');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
