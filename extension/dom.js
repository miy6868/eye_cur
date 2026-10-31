(() => {
  if (globalThis.GazeDOM) return;
  const selector = 'button,a[href],input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="checkbox"],[tabindex="0"]';
  const rectArray = r => [r.x, r.y, r.width, r.height];
  const inView = r => r[2] >= 3 && r[3] >= 3 && r[0] + r[2] > 0 && r[1] + r[3] > 0 && r[0] < innerWidth && r[1] < innerHeight;
  function canonical(element) { return element.closest('a[href],button') || element; }
  function titleOf(element) { return element.querySelector('h1,h2,h3,[role="heading"]'); }
  function regions(element) {
    const title = titleOf(element);
    const rectangles = [];
    // Inline anchors can have zero-height bounds around block headings. Text lines
    // also avoid treating the empty gap between wrapped link lines as clickable.
    if (title || element.matches('a[href]')) {
      const walker = document.createTreeWalker(title || element, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()) && rectangles.length < 80) {
        if (!node.textContent.trim()) continue;
        const parent = node.parentElement, style = getComputedStyle(parent);
        if (style.visibility !== 'visible' || style.display === 'none' || parent.closest('[hidden],[aria-hidden="true"]')) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        rectangles.push(...[...range.getClientRects()].map(rectArray));
      }
    }
    if (!rectangles.length) rectangles.push(...[...element.getClientRects()].map(rectArray));
    return rectangles.filter(inView);
  }
  function available(element, rect) {
    if (!element.isConnected || !rect || !inView(rect) || element.matches(':disabled') || element.closest('[inert],[aria-disabled="true"]')) return false;
    const style = getComputedStyle(element);
    if (style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) === 0) return false;
    const [x, y, w, h] = rect;
    const left = Math.max(0, x), right = Math.min(innerWidth - 1, x + w);
    const top = Math.max(0, y), bottom = Math.min(innerHeight - 1, y + h);
    for (const [fx, fy] of [[.5, .5], [.15, .5], [.85, .5], [.5, .2], [.5, .8]]) {
      const hit = document.elementFromPoint(left + (right - left) * fx, top + (bottom - top) * fy);
      if (hit === element || element.contains(hit)) return true;
    }
    return false;
  }
  function nearestRegion(element, x, y) {
    return regions(element).filter(r => available(element, r)).sort((a, b) =>
      GazeCore.distanceToRect(x, y, a) - GazeCore.distanceToRect(x, y, b))[0];
  }
  function unchanged(item) {
    if (!item.element.isConnected || item.href !== (item.element.getAttribute('href') || '')) return false;
    return regions(item.element).some(rect => rect.every((v, k) => Math.abs(v - item.rect[k]) <= 5) && available(item.element, rect));
  }
  function collect(x, y, radius, identify) {
    const seen = new Set(), items = [];
    for (const raw of document.querySelectorAll(selector)) {
      const element = canonical(raw);
      if (seen.has(element)) continue;
      seen.add(element);
      const rect = nearestRegion(element, x, y);
      if (!rect) continue;
      const distance = GazeCore.distanceToRect(x, y, rect);
      if (distance > radius) continue;
      const title = titleOf(element);
      const name = title?.textContent || element.getAttribute('aria-label') || element.labels?.[0]?.textContent || element.getAttribute('title') ||
        (element.tagName === 'INPUT' ? (['button', 'submit', 'reset'].includes(element.type) ? element.value : element.getAttribute('placeholder')) : element.textContent) || '';
      items.push({id: identify(element), element, rect, href: element.getAttribute('href') || '',
        name: name.trim().replace(/\s+/g, ' ').slice(0, 100), role: element.matches('a[href]') ? 'link' : element.getAttribute('role') || element.tagName.toLowerCase(),
        distance: Math.round(distance)});
    }
    return items.sort((a, b) => a.distance - b.distance || a.rect[2] * a.rect[3] - b.rect[2] * b.rect[3]).slice(0, 8);
  }
  // 실제 마우스 클릭과 같은 순서로 이벤트를 보낸다: click만 듣지 않고 mousedown/pointerdown에 반응하는 메뉴·버튼이 있다
  function press(element, rect) {
    const init = {bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: rect[0] + rect[2] / 2, clientY: rect[1] + rect[3] / 2};
    const pointer = {...init, pointerId: 1, pointerType: 'mouse', isPrimary: true};
    element.dispatchEvent(new PointerEvent('pointerdown', {...pointer, buttons: 1}));
    element.dispatchEvent(new MouseEvent('mousedown', {...init, buttons: 1}));
    element.focus({preventScroll: true});
    element.dispatchEvent(new PointerEvent('pointerup', pointer));
    element.dispatchEvent(new MouseEvent('mouseup', init));
    element.click();
  }
  // 가상 키보드가 글자를 넣을 수 있는 칸인지
  function editable(element) {
    if (!element || element.disabled || element.readOnly) return false;
    if (element.isContentEditable || element.tagName === 'TEXTAREA') return true;
    return element.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(element.type);
  }
  // 초점이 있는 입력칸에서 remove글자를 지우고 insert를 넣는다. execCommand는 사람이 친 것처럼 input 이벤트를 내서
  // React(값 직접 대입은 무시함)·디스코드 같은 contenteditable 편집기도 받아들인다
  function type(remove, insert) {
    for (let i = 0; i < remove; i++) document.execCommand('delete');
    if (insert) document.execCommand('insertText', false, insert);
  }
  // 초점이 있는 입력칸 내용을 모두 지운다. 사람이 Ctrl+A → Delete 한 것과 같아서 편집기도 받아들이고 Ctrl+Z로 되돌릴 수 있다
  function clear() {
    document.execCommand('selectAll');
    document.execCommand('delete');
  }
  // 엔터: 사이트가 keydown을 처리하면(디스코드 보내기 등) 그것으로 끝. 아니면 입력칸은 폼 제출, 여러 줄 칸은 줄바꿈
  function enter(element) {
    const init = {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true};
    const handled = !element.dispatchEvent(new KeyboardEvent('keydown', init));
    element.dispatchEvent(new KeyboardEvent('keyup', init));
    if (handled) return;
    if (element.tagName === 'INPUT') element.form?.requestSubmit();
    else document.execCommand('insertLineBreak');
  }
  function room(element, direction) {
    return direction > 0 ? element.scrollHeight - element.clientHeight - element.scrollTop : element.scrollTop;
  }
  // (x, y) 아래에서 direction(양수 = 아래) 쪽으로 더 스크롤할 수 있는 가장 안쪽 상자. 없으면 페이지 전체.
  // 같은 주소의 iframe(네이버 블로그·카페 본문 등: 바깥 페이지는 스크롤이 없다)은 그 안으로 들어가 찾는다
  // shortcut: 다른 주소의 iframe(네이버 지도 목록 등)은 contentDocument가 null이라 못 들어간다. 필요하면 frameRelay에 frameScroll을 더한다
  function scroller(x, y, direction, doc = document) {
    for (let element = doc.elementFromPoint(x, y); element && element !== doc.documentElement; element = element.parentElement) {
      const inner = element.tagName === 'IFRAME' && element.contentDocument;
      if (inner) {
        const r = element.getBoundingClientRect();
        const found = scroller(x - r.x - element.clientLeft, y - r.y - element.clientTop, direction, inner);
        if (found) return found;
      } else if (/auto|scroll|overlay/.test(getComputedStyle(element).overflowY) && room(element, direction) > 1) return element;
    }
    // iframe 안에서 더 갈 데가 없으면 바깥 페이지에서 계속 찾게 null
    return doc === document || room(doc.scrollingElement, direction) > 1 ? doc.scrollingElement : null;
  }
  globalThis.GazeDOM = {collect, unchanged, available, regions, press, editable, type, clear, enter, scroller};
})();
