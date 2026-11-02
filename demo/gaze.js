// 게임용 시선 좌표. 확장(content.js)이 /demo 페이지에만 보내는 'eye_cur:gaze' 메시지를 받는다.
// 카메라 없이도 시험할 수 있게 마우스 움직임도 같은 좌표로 받는다
const gaze = {x: innerWidth / 2, y: innerHeight / 2};
addEventListener('message', event => {
  if (event.source === window && event.data?.type === 'eye_cur:gaze') { gaze.x = event.data.x; gaze.y = event.data.y; }
});
addEventListener('mousemove', event => { gaze.x = event.clientX; gaze.y = event.clientY; });
// 최고 점수는 이 브라우저에만 남긴다
function best(game, score) {
  const key = `eye_cur:best:${game}`, old = Number(localStorage.getItem(key)) || 0;
  if (score > old) localStorage.setItem(key, score);
  return Math.max(old, score);
}
