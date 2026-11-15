const canvas = document.querySelector('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
let pack;
let playing;
let frozen = false;
let cursor;
let hit = false;
let previousHit = false;
let lastDraw = '';
let loadId = 0;
let artAspectRatioPreserved = false;

function render(id, index, flip = false) {
  const item = pack[id];
  flip &&= !item.unflippedFrames?.includes(index);
  const key = [id, index, flip].join(':');
  if (lastDraw === key) return;
  lastDraw = key;
  const x = index % item.columns * item.frameWidth;
  const y = Math.floor(index / item.columns) * item.frameHeight;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  if (flip) {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  const target = fitFrame(item.frameWidth, item.frameHeight, canvas.width, canvas.height);
  artAspectRatioPreserved = Math.abs(target.w * item.frameHeight - target.h * item.frameWidth) < 0.01;
  ctx.drawImage(item.image, x, y, item.frameWidth, item.frameHeight, target.x, target.y, target.w, target.h);
  ctx.restore();
  checkCursor();
}

function checkCursor() {
  const { x, y } = cursor || { x: -1, y: -1 };
  hit = x >= 0 && y >= 0 && x < 1 && y < 1 &&
    ctx.getImageData(Math.floor(x * canvas.width), Math.floor(y * canvas.height), 1, 1).data[3] >= 44;
  if (hit !== previousHit) {
    previousHit = hit;
    window.pet.send('hit', hit);
  }
}

function start({ id, flip = false, repeatFrames = false, duration = null, startedAt = Date.now() }) {
  if (!pack?.[id]) return;
  playing = { id, flip, repeatFrames, startedAt, duration };
  paintAt(Date.now());
}

function paintAt(now) {
  if (!playing || frozen) return;
  const { id, flip, repeatFrames, duration, startedAt } = playing;
  const elapsed = duration === null ? now - startedAt : Math.min(now - startedAt, duration - 1);
  render(id, animationFrame(pack[id], elapsed, repeatFrames), flip);
}

function tick() {
  paintAt(Date.now());
  requestAnimationFrame(tick);
}

window.pet.on('pack', async ({ animations, token }) => {
  const current = ++loadId;
  try {
    const entries = await Promise.all(Object.entries(animations).map(async ([id, item]) => {
      const image = new Image();
      image.src = item.source;
      await image.decode();
      if (image.width !== item.columns * item.frameWidth ||
          image.height < Math.ceil(item.frameDurationsMs.length / item.columns) * item.frameHeight ||
          image.height % item.frameHeight !== 0) throw Error(`图集尺寸不符：${id}`);
      const cycle = item.frameDurationsMs.reduce((sum, delay) => sum + delay, 0);
      return [id, { ...item, image, cycle }];
    }));
    if (current !== loadId) return;
    pack = Object.fromEntries(entries);
    lastDraw = '';
    start({ id: 'idle', repeatFrames: pack.idle.loop });
    window.pet.send('loaded', { token });
  } catch (error) {
    if (current === loadId) window.pet.send('loaded', { token, error: error.message });
  }
});

window.pet.on('animate', start);
window.pet.on('freeze', () => { frozen = true; });
window.pet.on('resume', pausedFor => {
  if (playing && frozen) playing.startedAt += pausedFor;
  frozen = false;
});
window.pet.on('cursor', point => {
  cursor = point;
  checkCursor();
});

canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  canvas.setPointerCapture(event.pointerId);
  window.pet.send('pointer-down');
});
canvas.addEventListener('pointerup', event => {
  if (event.button === 0) window.pet.send('pointer-up');
});
canvas.addEventListener('pointercancel', () => window.pet.send('pointer-cancel'));
canvas.addEventListener('lostpointercapture', () => window.pet.send('pointer-cancel'));
canvas.addEventListener('contextmenu', event => {
  event.preventDefault();
  window.pet.send('menu');
});

window.pet.on('sample', ({ now, token }) => {
  paintAt(now);
  const [id, frame] = lastDraw.split(':');
  window.pet.send('sampled', { token, id, frame: Number(frame),
    aspectRatioPreserved: artAspectRatioPreserved, square: canvas.width === canvas.height && canvas.offsetWidth === canvas.offsetHeight });
});

window.pet.on('verify', () => {
  try {
    const hashes = {};
    for (const [id, item] of Object.entries(pack)) {
      const observed = new Set();
      for (let i = 0; i < item.frameDurationsMs.length; i++) {
        render(id, i);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let hasTransparent = false;
        let hasBody = false;
        let hash = 2166136261;
        for (let j = 3; j < data.length; j += 4) {
          hasTransparent ||= data[j] === 0;
          hasBody ||= data[j] >= 220;
          hash = Math.imul(hash ^ data[j] ^ data[j - 1], 16777619);
        }
        if (!hasBody || !hasTransparent) throw Error(`画面没有有效透明边缘：${id} ${i}`);
        observed.add(hash);
      }
      if (observed.size < 2) throw Error(`没有动画变化：${id}`);
      hashes[id] = observed.size;
    }
    start({ id: 'idle', repeatFrames: pack.idle.loop });
    window.pet.send('verified', { hashes });
  } catch (error) {
    window.pet.send('verified', { error: error.message });
  }
});

requestAnimationFrame(tick);
