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
  globalThis.GazeDOM = {collect, unchanged, available, regions};
})();
