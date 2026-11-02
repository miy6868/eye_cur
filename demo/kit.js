// 게임 공용 도구: 선명한 캔버스, 미리 그린 그림, 입자, 화면 흔들림, 떠오르는 글자, 효과음(Web Audio 합성), 최고 점수.
// 학교 노트북은 시선 모델이 CPU를 많이 쓴다. 무거운 그림(배경·빛·운석)은 한 번만 그려 두고 매 프레임에는 drawImage만 한다
const DPR = Math.min(devicePixelRatio || 1, 1.5);
const TAU = Math.PI * 2;
const FONT = '"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif';
const rand = (a, b) => a + Math.random() * (b - a);
const pick = list => list[Math.floor(Math.random() * list.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = t => 1 - (1 - t) ** 3;
const easeOutBack = t => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
const rgba = ([r, g, b], a = 1) => `rgba(${r},${g},${b},${a})`;
const $ = selector => document.querySelector(selector);

// 화면 크기 캔버스. 좌표는 CSS px로 쓰고 실제 픽셀은 DPR배
function setupCanvas(canvas, onResize) {
  const view = {ctx: canvas.getContext('2d'), w: 0, h: 0};
  function resize() {
    view.w = innerWidth; view.h = innerHeight;
    canvas.width = Math.round(view.w * DPR); canvas.height = Math.round(view.h * DPR);
    canvas.style.width = `${view.w}px`; canvas.style.height = `${view.h}px`;
    view.ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    onResize?.(view);
  }
  addEventListener('resize', resize);
  resize();
  return view;
}
// 미리 그려 두는 그림. scale < 1이면 흐릿해도 되는 큰 그림(성운·안개)을 작게 그려 메모리와 시간을 아낀다
function sprite(w, h, draw, scale = DPR) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w * scale)); c.height = Math.max(1, Math.ceil(h * scale));
  const g = c.getContext('2d');
  g.scale(scale, scale);
  draw(g, w, h);
  c.w = w; c.h = h;
  return c;
}
function drawSprite(ctx, s, x, y, scale = 1, rotation = 0) {
  const w = s.w * scale, h = s.h * scale;
  if (!rotation) { ctx.drawImage(s, x - w / 2, y - h / 2, w, h); return; }
  ctx.save(); ctx.translate(x, y); ctx.rotate(rotation); ctx.drawImage(s, -w / 2, -h / 2, w, h); ctx.restore();
}
// 둥근 빛 번짐. 'lighter'로 겹쳐 그리면 빛처럼 보인다
const glows = new Map();
function glow(color, radius = 64) {
  const key = `${color}|${radius}`;
  if (!glows.has(key)) glows.set(key, sprite(radius * 2, radius * 2, g => {
    const grad = g.createRadialGradient(radius, radius, 0, radius, radius, radius);
    grad.addColorStop(0, rgba(color, 1)); grad.addColorStop(.22, rgba(color, .5)); grad.addColorStop(.55, rgba(color, .14)); grad.addColorStop(1, rgba(color, 0));
    g.fillStyle = grad; g.fillRect(0, 0, radius * 2, radius * 2);
  }));
  return glows.get(key);
}
function light(ctx, color, x, y, radius, alpha = 1) {
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = alpha;
  ctx.drawImage(glow(color), x - radius, y - radius, radius * 2, radius * 2);
  ctx.restore();
}
// 가장자리를 어둡게(영화 같은 느낌). 화면 크기가 바뀔 때만 다시 그린다
function vignette(w, h, color = [0, 0, 0], strength = .75) {
  return sprite(w, h, g => {
    const grad = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * .35, w / 2, h / 2, Math.hypot(w, h) / 2);
    grad.addColorStop(0, rgba(color, 0)); grad.addColorStop(1, rgba(color, strength));
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
  }, .5);
}

class Particles {
  constructor(max = 700) { this.list = []; this.max = max; }
  // o: count, angle, spread, speed [a,b], life [a,b], size [a,b], color, glow, gravity, drag, grow(수명 동안 크기 변화 비율), alpha, vx/vy(더하는 속도), jitter(시작 위치 흩뿌림)
  emit(x, y, o = {}) {
    const count = o.count ?? 12;
    for (let i = 0; i < count && this.list.length < this.max; i++) {
      const a = (o.angle ?? 0) + rand(-1, 1) * (o.spread ?? Math.PI), s = rand(...(o.speed ?? [40, 160])), j = o.jitter ?? 0;
      this.list.push({
        x: x + rand(-j, j), y: y + rand(-j, j), vx: Math.cos(a) * s + (o.vx ?? 0), vy: Math.sin(a) * s + (o.vy ?? 0),
        age: 0, life: rand(...(o.life ?? [.4, .9])), size: rand(...(o.size ?? [2, 4])), color: o.color ?? [255, 255, 255],
        glow: o.glow ?? false, gravity: o.gravity ?? 0, drag: o.drag ?? 1.5, grow: o.grow ?? -.6, alpha: o.alpha ?? 1,
      });
    }
  }
  update(dt) {
    for (const p of this.list) {
      p.age += dt;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vy = p.vy * k + p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    this.list = this.list.filter(p => p.age < p.life);
  }
  draw(ctx) {
    ctx.save();
    for (const p of this.list) {
      const t = p.age / p.life, size = Math.max(.2, p.size * (1 + p.grow * t));
      ctx.globalAlpha = p.alpha * (1 - t * t);
      if (p.glow) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(glow(p.color), p.x - size * 2.5, p.y - size * 2.5, size * 5, size * 5);
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = rgba(p.color);
        ctx.beginPath(); ctx.arc(p.x, p.y, size, 0, TAU); ctx.fill();
      }
    }
    ctx.restore();
  }
}

const shake = {
  power: 0,
  add(power) { this.power = Math.min(28, this.power + power); },
  apply(ctx, dt) {
    const p = this.power;
    this.power *= Math.exp(-dt * 9);
    if (p > .3) ctx.translate(rand(-p, p), rand(-p, p));
  },
};

class Popups {
  constructor() { this.list = []; }
  add(x, y, text, {color = '#fff', size = 30, life = 1} = {}) { this.list.push({x, y, text, color, size, life, age: 0}); }
  update(dt) { for (const p of this.list) p.age += dt; this.list = this.list.filter(p => p.age < p.life); }
  draw(ctx) {
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    for (const p of this.list) {
      const t = p.age / p.life, scale = t < .18 ? easeOutBack(t / .18) : 1;
      ctx.globalAlpha = t < .6 ? 1 : 1 - (t - .6) / .4;
      ctx.font = `900 ${p.size * scale}px ${FONT}`;
      const y = p.y - easeOutCubic(t) * 50;
      ctx.lineWidth = p.size * .22; ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.strokeText(p.text, p.x, y);
      ctx.fillStyle = p.color; ctx.fillText(p.text, p.x, y);
    }
    ctx.restore();
  }
}

// 효과음은 파일 없이 합성한다. 브라우저 규칙상 실제 마우스·키보드 입력이 한 번은 있어야 소리가 난다
// (확장의 시선 클릭은 스크립트가 만든 클릭이라 '사람 입력'으로 치지 않는다). 그래서 소리 버튼이 상태를 알려 준다
const Sound = {
  ctx: null, out: null, noiseBuffer: null,
  on: localStorage.getItem('eye_cur:sound') !== 'off',
  start() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const compressor = this.ctx.createDynamicsCompressor();
      compressor.connect(this.ctx.destination);
      this.out = this.ctx.createGain(); this.out.gain.value = .55; this.out.connect(compressor);
      const length = this.ctx.sampleRate;
      this.noiseBuffer = this.ctx.createBuffer(1, length, length);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      this.ctx.onstatechange = showSound;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  },
  running() { return this.ctx?.state === 'running'; },
  tone({type = 'sine', from = 440, to = from, time = .15, gain = .2, delay = 0, attack = .005}) {
    const c = this.ctx, t = c.currentTime + delay, osc = c.createOscillator(), amp = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t); osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + time);
    amp.gain.setValueAtTime(.0001, t); amp.gain.exponentialRampToValueAtTime(gain, t + attack); amp.gain.exponentialRampToValueAtTime(.0001, t + time);
    osc.connect(amp).connect(this.out); osc.start(t); osc.stop(t + time + .05);
  },
  noise({time = .3, gain = .3, type = 'lowpass', from = 3000, to = 200, q = .8, delay = 0, attack = .005}) {
    const c = this.ctx, t = c.currentTime + delay, src = c.createBufferSource(), filter = c.createBiquadFilter(), amp = c.createGain();
    src.buffer = this.noiseBuffer; src.loop = true;
    filter.type = type; filter.Q.value = q;
    filter.frequency.setValueAtTime(from, t); filter.frequency.exponentialRampToValueAtTime(to, t + time);
    amp.gain.setValueAtTime(.0001, t); amp.gain.exponentialRampToValueAtTime(gain, t + attack); amp.gain.exponentialRampToValueAtTime(.0001, t + time);
    src.connect(filter).connect(amp).connect(this.out); src.start(t, Math.random() * .5); src.stop(t + time + .05);
  },
  play(name) {
    if (!this.on) return;
    this.start();
    if (this.running()) SFX[name]?.(this);
  },
};
const SFX = {
  start: s => [523, 659, 784, 1047].forEach((f, i) => s.tone({type: 'triangle', from: f, time: .3, gain: .16, delay: i * .07})),
  go: s => { s.tone({type: 'sawtooth', from: 220, to: 880, time: .35, gain: .08}); s.noise({time: .5, gain: .15, type: 'bandpass', from: 400, to: 4000, q: 1.5}); },
  pickup: s => { s.tone({from: 880, to: 1760, time: .18, gain: .18}); s.tone({type: 'triangle', from: 1320, to: 2640, time: .22, gain: .09, delay: .06}); },
  explode: s => { s.noise({time: 1.4, gain: .8, from: 3000, to: 40}); s.tone({from: 110, to: 28, time: .9, gain: .7}); s.noise({time: .25, gain: .4, type: 'highpass', from: 6000, to: 2000, delay: .02}); },
  whoosh: s => s.noise({time: .35, gain: .16, type: 'bandpass', from: 500, to: 3500, q: 2.5, attack: .08}),
  sizzle: s => s.noise({time: .14, gain: .035, type: 'bandpass', from: 2400, to: 3600, q: 5}),
  vanish: s => { s.noise({time: .6, gain: .22, type: 'bandpass', from: 3200, to: 260, q: 1.6}); s.tone({from: 1100, to: 260, time: .45, gain: .08}); s.tone({type: 'triangle', from: 1568, time: .25, gain: .05, delay: .08}); },
  hurt: s => { s.tone({type: 'sawtooth', from: 200, to: 45, time: .55, gain: .2}); s.noise({time: .4, gain: .35, from: 900, to: 80}); },
  over: s => [392, 330, 262, 196].forEach((f, i) => s.tone({type: 'triangle', from: f, to: f * .97, time: .45, gain: .15, delay: i * .18})),
  pop: s => s.tone({from: 260, to: 620, time: .13, gain: .12}),
  whack: s => { s.tone({from: 190, to: 48, time: .22, gain: .65}); s.noise({time: .09, gain: .45, from: 5000, to: 700}); },
  thud: s => s.noise({time: .15, gain: .2, from: 900, to: 120}),
  gold: s => [1047, 1319, 1568, 2093, 2637].forEach((f, i) => s.tone({from: f, time: .35, gain: .1, delay: i * .05})),
  tick: s => s.tone({type: 'square', from: 1700, time: .035, gain: .04}),
  warn: s => s.tone({type: 'square', from: 660, to: 620, time: .12, gain: .06}),
  level: s => [440, 554, 659, 880].forEach((f, i) => s.tone({type: 'sawtooth', from: f, time: .2, gain: .06, delay: i * .07})),
  miss: s => s.tone({from: 330, to: 190, time: .22, gain: .08}),
};
addEventListener('pointerdown', event => { if (event.isTrusted && Sound.on) Sound.start(); }, true);
addEventListener('keydown', event => { if (event.isTrusted && Sound.on) Sound.start(); }, true);

// 위쪽 띠의 소리 버튼(입 클릭으로도 켜고 끌 수 있다)
const ICON = {
  on: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
  off: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>',
};
const soundButton = document.createElement('button');
soundButton.className = 'pill sound';
function showSound() {
  soundButton.innerHTML = !Sound.on ? `${ICON.off}소리 꺼짐` : Sound.running() ? `${ICON.on}소리 켜짐` : `${ICON.on}소리: 마우스로 한 번 누르세요`;
}
soundButton.onclick = event => {
  // 켜져 있는데 브라우저가 막아 둔 상태면, 실제 마우스 클릭은 끄지 않고 소리를 연다
  if (Sound.on && !Sound.running() && event.isTrusted) Sound.start();
  else { Sound.on = !Sound.on; localStorage.setItem('eye_cur:sound', Sound.on ? 'on' : 'off'); if (Sound.on) Sound.start(); }
  showSound();
};
$('.hud')?.insertBefore(soundButton, $('.hud .grow'));
if (Sound.on) Sound.start(); // 같은 사이트에서 이미 마우스를 눌렀다면 바로 켜진다
showSound();

// 최고 점수는 이 브라우저에만 남긴다. 새 기록이면 true
function best(game, score) {
  const key = `eye_cur:best:${game}`, old = Number(localStorage.getItem(key)) || 0;
  if (score > old) localStorage.setItem(key, score);
  return {best: Math.max(old, score), isNew: score > old && score > 0};
}
// 가운데 큰 글자를 잠깐 띄운다
let bannerTimer;
function banner(text, sub = '', ms = 1200) {
  const box = $('#banner');
  box.innerHTML = `<div>${text}${sub ? `<small>${sub}</small>` : ''}</div>`;
  box.hidden = false;
  clearTimeout(bannerTimer);
  if (ms) bannerTimer = setTimeout(() => { box.hidden = true; }, ms);
}
function hideBanner() { clearTimeout(bannerTimer); $('#banner').hidden = true; }
// 프레임 사이 시간(초). 탭을 오래 비웠다 돌아와도 한 번에 크게 뛰지 않게 자른다
function clock() {
  let last = performance.now();
  return now => { const dt = Math.min(.05, (now - last) / 1000); last = now; return dt; };
}
