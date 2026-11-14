const canvas = document.querySelector('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
let pack;
let playing;
let cursor;
let hit = false;
let previousHit = false;
let lastDraw = '';
let loadId = 0;

function render(id, index, flip = false) {
  const item = pack[id];
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
  ctx.drawImage(item.image, x, y, item.frameWidth, item.frameHeight, 0, 0, canvas.width, canvas.height);
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

function start({ id, flip = false, repeat = pack?.[id]?.loop === true && (id === 'idle' || id === 'tail-nap') }) {
  if (!pack?.[id]) return;
  const duration = pack[id].frameDurationsMs.reduce((total, delay) => total + delay, 0);
  playing = { id, flip, repeat, duration, start: performance.now() };
  render(id, 0, flip);
}

function tick(now) {
  if (playing) {
    const { id, start: started, flip, repeat, duration } = playing;
    const delays = pack[id].frameDurationsMs;
    let remaining = now - started;
    if (!repeat && remaining >= duration) {
      window.pet.send('ended', id);
      start({ id: 'idle' });
    } else {
      remaining %= duration;
      const frame = delays.findIndex(delay => (remaining -= delay) < 0);
      render(id, Math.max(0, frame), flip);
    }
  }
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
      return [id, { ...item, image }];
    }));
    if (current !== loadId) return;
    pack = Object.fromEntries(entries);
    lastDraw = '';
    start({ id: 'idle' });
    window.pet.send('loaded', { token });
  } catch (error) {
    if (current === loadId) window.pet.send('loaded', { token, error: error.message });
  }
});

window.pet.on('animate', start);
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
canvas.addEventListener('contextmenu', event => {
  event.preventDefault();
  window.pet.send('menu');
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
    start({ id: 'idle' });
    window.pet.send('verified', { hashes });
  } catch (error) {
    window.pet.send('verified', { error: error.message });
  }
});

requestAnimationFrame(tick);
