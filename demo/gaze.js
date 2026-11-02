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
// 시선으로 하다가 신호가 끊겼는지(얼굴 잃음·입 벌림). 게임은 이때 잠시 멈춘다. 마우스로 할 때는 멈추지 않는다
const gazeLost = () => eyeAt > mouseAt && performance.now() - eyeAt > 800;
// 위쪽 띠에 무엇으로 조종 중인지 보여 준다. 시선 신호가 안 오면 대개 확장·페이지를 새로고침하지 않은 것이다
const source = document.createElement('span');
source.className = 'stat source';
document.querySelector('.hud')?.insertBefore(source, document.querySelector('.hud .grow'));
setInterval(() => {
  const now = performance.now();
  const state = now - eyeAt < 3000 ? 'eye' : now - mouseAt < 3000 ? 'mouse' : 'none';
  source.dataset.state = state; // 3초: 입을 벌려 클릭하는 동안(시선이 안 옴) 경고가 깜빡이지 않게
  source.textContent = {eye: '시선 연결됨', mouse: '마우스로 조종 중', none: '시선 신호 없음 · 확장과 페이지를 새로고침하세요'}[state];
}, 300);
