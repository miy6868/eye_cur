// 페이지 안의 iframe(예: 네이버 지도 검색 결과 = pcmap.place.naver.com)에서 돈다.
// 맨 위 페이지의 content.js는 다른 주소의 iframe 속 요소를 볼 수 없으므로, 워커를 거쳐 온 요청에 답해
// 이 프레임의 클릭 후보를 모아 주고(frameCollect), 고른 요소를 대신 클릭한다(frameClick). 좌표는 이 프레임 기준
(() => {
  if (window === top || globalThis.__gazeFrame) return;
  globalThis.__gazeFrame = true;
  const ids = new WeakMap();
  let number = 0, items = new Map();
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.type === 'frameCollect') {
      const found = GazeDOM.collect(message.x, message.y, message.radius, element => {
        if (!ids.has(element)) ids.set(element, `e${++number}`);
        return ids.get(element);
      });
      items = new Map(found.map(item => [item.id, item]));
      reply(found.map(({element, ...data}) => data));
    } else if (message.type === 'frameClick') {
      const item = items.get(message.id);
      const ok = !!item && !document.hidden && GazeDOM.unchanged(item);
      if (ok) GazeDOM.press(item.element, item.rect);
      reply(ok);
    }
    // 다른 메시지(frame·status 등)는 맨 위 content.js가 답한다
  });
})();
