(() => {
  if (globalThis.GazeDOM) return;
  // 메뉴 항목(role=menuitem 등)은 보통 tabindex="-1"이라 역할로 따로 넣는다. summary = 접기/펴기, label = 연결된 입력칸·체크박스를 누른다,
  // [onclick] = 옛날식 사이트(학교·관공서)의 눌리는 표 칸·그림
  const selector = 'button,a[href],input:not([type="hidden"]),select,textarea,summary,label,[onclick],[tabindex="0"],' +
    ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem'].map(role => `[role="${role}"]`).join(',');
  const rectArray = r => [r.x, r.y, r.width, r.height];
  const inView = r => r[2] >= 3 && r[3] >= 3 && r[0] + r[2] > 0 && r[1] + r[3] > 0 && r[0] < innerWidth && r[1] < innerHeight;
  function canonical(element) { return element.closest('a[href],button') || element; }
  function titleOf(element) { return element.querySelector('h1,h2,h3,[role="heading"]'); }
  function regions(element) {
    const boxes = () => [...element.getClientRects()].map(rectArray).filter(inView);
    // 블록·인라인 블록·flex 상자(카드, 메뉴 항목, 목차 줄, 아이콘 버튼)는 마우스처럼 상자 전체를 눌리는 곳으로 본다.
    // 예전에는 링크를 글자 줄로만 재서 카드의 그림이나 글자 옆 빈칸을 보면 멀다고 빠졌다
    const display = getComputedStyle(element).display;
    if (display !== 'inline' && display !== 'contents') return boxes();
    const title = titleOf(element);
    const rectangles = [];
    // 줄바꿈된 인라인 링크는 글자 줄만 쓴다: 상자로 재면 줄 사이 빈 곳도 눌리는 곳이 된다
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
    // 인라인 상자 조각도 더한다: 아이콘만 있는 링크(글자는 화면 읽기용으로 숨김), 블록을 감싼 인라인 링크(Chrome은 그 블록을 조각에 넣는다)
    return [...rectangles.filter(inView), ...boxes()];
  }
  function available(element, rect) {
    if (!element.isConnected || !rect || !inView(rect) || element.matches(':disabled') || element.closest('[inert],[aria-disabled="true"]')) return false;
    const style = getComputedStyle(element);
    // 투명(opacity 0)은 빼지 않는다: 위키백과 메뉴처럼 아이콘 위에 투명한 체크박스를 덮은 사이트가 있고, 마우스도 그것을 누른다.
    // 정말 안 보이는 것은 아래 elementFromPoint 검사(pointer-events 없음·가려짐)에서 빠진다
    if (style.visibility !== 'visible' || style.display === 'none') return false;
    const [x, y, w, h] = rect;
    const left = Math.max(0, x), right = Math.min(innerWidth - 1, x + w);
    const top = Math.max(0, y), bottom = Math.min(innerHeight - 1, y + h);
    for (const [fx, fy] of [[.5, .5], [.15, .5], [.85, .5], [.5, .2], [.5, .8]]) {
      const hit = document.elementFromPoint(left + (right - left) * fx, top + (bottom - top) * fy);
      if (hit === element || element.contains(hit)) return true;
    }
    return false;
  }
  // 가까운 조각부터 가려짐을 검사해 처음 보이는 것(가려짐 검사는 elementFromPoint 5번이라 비싸다)
  function nearestRegion(element, x, y) {
    return regions(element).sort((a, b) => GazeCore.distanceToRect(x, y, a) - GazeCore.distanceToRect(x, y, b)).find(r => available(element, r));
  }
  // 선택자에 안 걸리지만 마우스를 올리면 손가락 모양인 것(자바스크립트로만 눌리는 div·li 등). 시선과 그 둘레 8곳 아래만 본다.
  // cursor는 자식에게 물려주므로, 손가락 모양이 시작되는 가장 바깥 요소를 고른다. 화면 절반보다 큰 것(페이지 전체에 pointer를 준 사이트)은 뺀다
  function pointerTargets(x, y, radius) {
    const found = new Set();
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [.7, .7], [-.7, .7], [.7, -.7], [-.7, -.7]]) {
      let element = document.elementFromPoint(x + dx * radius / 2, y + dy * radius / 2);
      if (!element || getComputedStyle(element).cursor !== 'pointer') continue;
      while (element.parentElement && element.parentElement !== document.body && getComputedStyle(element.parentElement).cursor === 'pointer') element = element.parentElement;
      const r = element.getBoundingClientRect();
      if (element !== document.body && r.width * r.height < innerWidth * innerHeight / 2) found.add(element);
    }
    return found;
  }
  function unchanged(item) {
    if (!item.element.isConnected || item.href !== (item.element.getAttribute('href') || '')) return false;
    return regions(item.element).some(rect => rect.every((v, k) => Math.abs(v - item.rect[k]) <= 5) && available(item.element, rect));
  }
  function collect(x, y, radius, identify) {
    const seen = new Set(), items = [];
    for (const raw of [...document.querySelectorAll(selector), ...pointerTargets(x, y, radius)]) {
      const element = canonical(raw);
      if (seen.has(element)) continue;
      seen.add(element);
      // 먼저 바깥 상자로 먼 요소를 거른다: 글자 줄·가려짐 검사(regions·available)는 비싸서 요소가 수천 개인 페이지(유튜브 등)에서
      // 프레임마다 다 하면 처리가 밀렸다. 링크 안의 제목·블록도 이 상자에 들어간다(Chrome에서 확인). 크기 0인 상자는 거르지 않는다
      // shortcut: position:absolute인 자식은 이 상자 밖에 있을 수 있어 그 부분만 멀면 빠진다. 그런 사이트가 나오면 고친다
      const box = element.getBoundingClientRect();
      if (box.width && box.height && GazeCore.distanceToRect(x, y, rectArray(box)) > radius) continue;
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
