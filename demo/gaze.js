// 게임용 시선 좌표. 확장(content.js)이 /demo 페이지에만 보내는 'eye_cur:gaze' 메시지를 받는다.
// 카메라 없이도 시험할 수 있게 마우스도 받지만, 시선이 들어오는 동안(1초 안)은 마우스를 무시한다(책상에 닿은 마우스가 시선을 덮어썼다)
const gaze = {x: innerWidth / 2, y: innerHeight / 2};
let eyeAt = -1e9, mouseAt = -1e9;
addEventListener('message', event => {
  if (event.source !== window || event.data?.type !== 'eye_cur:gaze') return;
  gaze.x = event.data.x; gaze.y = event.data.y; eyeAt = performance.now();
});
addEventListener('mousemove', event => {
  if (performance.now() - eyeAt < 1000) return;
  gaze.x = event.clientX; gaze.y = event.clientY; mouseAt = performance.now();
});
// 위쪽 띠에 무엇으로 조종 중인지 보여 준다. 시선 신호가 안 오면 대개 확장·페이지를 새로고침하지 않은 것이다
const source = document.createElement('span');
document.querySelector('.bar')?.insertBefore(source, document.querySelector('.bar .grow'));
setInterval(() => {
  const now = performance.now();
  source.textContent = now - eyeAt < 1000 ? '👁 시선' : now - mouseAt < 3000 ? '🖱 마우스' : '⚠ 시선 신호 없음 (확장과 페이지를 새로고침해 보세요)';
}, 300);
// 최고 점수는 이 브라우저에만 남긴다
function best(game, score) {
  const key = `eye_cur:best:${game}`, old = Number(localStorage.getItem(key)) || 0;
  if (score > old) localStorage.setItem(key, score);
  return Math.max(old, score);
}
