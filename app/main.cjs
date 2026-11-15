const { app, BrowserWindow, Menu, Tray, screen, ipcMain, dialog, nativeImage, session } = require('electron');
const fs = require('node:fs/promises');
const { appendFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const path = require('node:path');
const { readPack, actions: packActions } = require('./packs.cjs');
const { planPlayback } = require('./playback.js');

const bundled = app.isPackaged ? path.join(process.resourcesPath, 'pet-pack') :
  path.join(__dirname, '..', process.env.PET_LOCAL_ART === '1' ? 'private-assets/pet-pack' : 'demo-pack');
const smokePath = process.env.DESKTOP_PET_SMOKE_FILE ||
  process.argv.find(arg => arg.startsWith('--smoke-file='))?.slice('--smoke-file='.length);
function trace(phase) {
  if (smokePath) appendFileSync(smokePath + '.trace', new Date().toISOString() + ' ' + phase + '\n');
}
trace('main script');
const localBrand = path.basename(process.execPath, path.extname(process.execPath)) === 'MomongaDesktopPet' ||
  (!app.isPackaged && process.env.PET_LOCAL_ART === '1');
const appFolder = localBrand ? 'MomongaDesktopPet' : 'DesktopPetPlayer';
const smokeProfile = process.argv.find(arg => arg.startsWith('--smoke-profile='))?.slice('--smoke-profile='.length);
const profile = smokePath ?
  (smokeProfile && path.isAbsolute(smokeProfile) ? smokeProfile : path.join(path.dirname(smokePath), 'smoke-profile')) :
  path.join(app.getPath('appData'), appFolder);
app.setName(localBrand ? '飞鼠桌宠' : 'Desktop Pet Player');
app.setPath('userData', profile);
if (process.platform === 'win32') app.setAppUserModelId(localBrand ? 'BitCrowder.MomongaDesktopPet' : 'BitCrowder.DesktopPetPlayer');
if (process.platform === 'darwin') app.dock?.hide();

const actions = {
  idle: '待机眨眼',
  'act-cute': '捧脸装可爱',
  glide: '滑翔',
  'tail-nap': '睡觉',
  snack: '喂点心',
  'tantrum-roll': '耍赖打滚',
  'sneaky-peek': '探头偷看',
  'tiny-steps': '散步',
};
const sizes = [128, 176, 224];
const defaults = { size: 176, top: true, roam: true };
let settings = { ...defaults };
let win;
let tray;
let activePack;
let packToken = 0;
let loading;
let importing = false;
let nearbyBefore = false;
let motion;
let pressed;
let click;
let hit = false;
let ignoring = true;
let lastInput = Date.now();
let lastCursor;
let lastPeek = 0;
let lastScreenCursor;
let nextRoamAt = Date.now() + 30000;
let nextPeekAt = Date.now() + 2000;
let current = 'idle';
let endsAt = null;
let activeCustomPack = null;
let sampleRequest;
let sampleToken = 0;
let writeQueue = Promise.resolve();
let desktopTimer;
let constrainDisplay;
let stopping = false;
let quitRequested = false;
let quitReady = false;
let smokeResult;

function desktopReady() {
  return !stopping && win && !win.isDestroyed() && win.webContents?.isDestroyed() === false;
}

function stopDesktop() {
  if (stopping) return;
  stopping = true;
  clearInterval(desktopTimer);
  clearTimeout(click);
  desktopTimer = click = pressed = motion = null;
  if (constrainDisplay) {
    screen.off('display-removed', constrainDisplay);
    screen.off('display-metrics-changed', constrainDisplay);
    constrainDisplay = null;
  }
  loading?.done('桌宠正在退出');
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

function startDesktopTimer() {
  desktopTimer = setInterval(() => {
    if (!desktopReady()) return;
    const now = Date.now();
    advancePlayback(now);
    updateCursor(now);
    behaviors(now);
  }, 25).unref();
}

function save() {
  const payload = JSON.stringify(settings);
  writeQueue = writeQueue.catch(console.error).then(async () => {
    const file = path.join(profile, 'settings.json');
    await fs.writeFile(file + '.tmp', payload);
    await fs.rename(file + '.tmp', file);
  });
  return writeQueue;
}

function clamp(bounds, area = screen.getDisplayMatching(bounds).workArea) {
  const maxX = Math.max(area.x, area.x + area.width - bounds.width);
  const maxY = Math.max(area.y, area.y + area.height - bounds.height);
  return { x: Math.round(Math.max(area.x, Math.min(maxX, bounds.x))),
    y: Math.round(Math.max(area.y, Math.min(maxY, bounds.y))) };
}

function placeDefault() {
  const near = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  win.setBounds({ width: settings.size, height: settings.size,
    x: near.x + near.width - settings.size - 20, y: near.y + near.height - settings.size - 14 });
}

function remember() {
  const { x, y } = win.getBounds();
  settings.position = { x, y };
  void save().catch(console.error);
}

function refreshIgnore() {
  if (!desktopReady()) return;
  const next = !hit && !pressed;
  if (next === ignoring) return;
  ignoring = next;
  win.setIgnoreMouseEvents(ignoring, { forward: true });
}

function beginPointer(cursor, now = Date.now()) {
  if (pressed || importing) return;
  activity();
  const { x, y } = win.getBounds();
  const secondClick = Boolean(click);
  clearTimeout(click);
  click = null;
  pressed = { x, y, cursor, startedAt: now, dragging: false, secondClick };
  motion = null;
  win.webContents.send('pet:freeze');
  refreshIgnore();
}

function movePointer(cursor) {
  const dx = cursor.x - pressed.cursor.x;
  const dy = cursor.y - pressed.cursor.y;
  if (Math.hypot(dx, dy) >= 5) pressed.dragging = true;
  if (!pressed.dragging) return;
  const width = settings.size;
  const height = settings.size;
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const position = clamp({ width, height, x: pressed.x + dx, y: pressed.y + dy }, area);
  const bounds = win.getBounds();
  if (position.x !== bounds.x || position.y !== bounds.y) win.setPosition(position.x, position.y);
  // A DPI transition can resize the native window during a move.
  const moved = win.getBounds();
  if (moved.width !== width || moved.height !== height) {
    win.setBounds({ ...position, width, height });
  }
}

function scheduleClick() {
  click = setTimeout(() => { click = null; play('act-cute'); }, 275);
}

function endPointer(cancelled = false, now = Date.now()) {
  if (!desktopReady() || !pressed) return;
  const { dragging, startedAt, secondClick } = pressed;
  pressed = null;
  const pausedFor = Math.max(0, now - startedAt);
  if (endsAt !== null) endsAt += pausedFor;
  win.webContents.send('pet:resume', pausedFor);
  refreshIgnore();
  if (dragging || cancelled) {
    clearTimeout(click);
    click = null;
    if (dragging && !smokePath) remember();
    return;
  }
  if (secondClick) play('tantrum-roll');
  else scheduleClick();
}

function updateCursor(now) {
  if (!desktopReady() || !win.isVisible() || !activePack) return;
  const cursor = screen.getCursorScreenPoint();
  if (pressed) movePointer(cursor);
  const bounds = win.getBounds();
  const local = { x: (cursor.x - bounds.x) / bounds.width, y: (cursor.y - bounds.y) / bounds.height };
  if (!lastCursor || lastCursor.x !== local.x || lastCursor.y !== local.y) {
    lastCursor = local;
    win.webContents.send('pet:cursor', local);
    const nearby = local.x > -0.15 && local.x < 1.15 && local.y > -0.1 && local.y < 1.15;
    const cursorMoved = lastScreenCursor && (cursor.x !== lastScreenCursor.x || cursor.y !== lastScreenCursor.y);
    if (nearby && !nearbyBefore && cursorMoved && !pressed && !click && settings.roam &&
        current === 'idle' && now >= nextPeekAt && now - lastPeek > 18000) {
      lastPeek = now;
      play('sneaky-peek', { flip: local.x < 0.5, now });
    }
    nearbyBefore = nearby;
  }
  lastScreenCursor = cursor;
}

function play(id, { flip = false, now = Date.now() } = {}) {
  const item = activePack?.animations[id];
  if (!desktopReady() || !item) return;
  const { duration, repeatFrames } = planPlayback(id, item);
  motion = null;
  current = id;
  endsAt = duration === null ? null : now + duration;
  if (!pressed && (id === 'glide' || id === 'tiny-steps')) {
    const bounds = win.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const availableLeft = Math.max(0, bounds.x - area.x);
    const availableRight = Math.max(0, area.x + area.width - bounds.x - bounds.width);
    const sign = availableRight >= availableLeft ? 1 : -1;
    const distance = id === 'glide' ? 126 : 94;
    const facing = item.facing ?? (id === 'tiny-steps' ? 'left' : 'front');
    flip = facing !== 'front' && (facing === 'left' ? sign > 0 : sign < 0);
    motion = { id, bounds, area, endX: bounds.x + sign * Math.min(distance, Math.max(availableLeft, availableRight)),
      start: now, duration };
  }
  win.webContents.send('pet:animate', { id, flip, repeatFrames, duration, startedAt: now });
}

function advancePlayback(now) {
  if (pressed) return;
  if (motion) {
    const { id, bounds, area, endX, start, duration } = motion;
    let progress = Math.min(1, Math.max(0, (now - start) / duration));
    if (id === 'glide') {
      // The sprite already rises and lands on its own ground line. A native
      // vertical arc would apply the same movement twice.
      const delays = activePack.animations.glide.frameDurationsMs;
      const leadIn = delays[0];
      const leadOut = delays.at(-1);
      if (delays.length > 2 && duration > leadIn + leadOut) {
        progress = Math.min(1, Math.max(0, (now - start - leadIn) / (duration - leadIn - leadOut)));
      }
      progress = progress * progress * (3 - 2 * progress);
    }
    const b = win.getBounds();
    const next = clamp({ ...b, x: bounds.x + (endX - bounds.x) * progress, y: bounds.y }, area);
    if (next.x !== b.x || next.y !== b.y) win.setPosition(next.x, next.y);
  }
  if (endsAt !== null && now >= endsAt) {
    if (motion && !smokePath) remember();
    nextRoamAt = now + 30000;
    nextPeekAt = now + 2000;
    play('idle', { now });
  }
}

function activity() {
  lastInput = Date.now();
  nextRoamAt = lastInput + 30000;
  nextPeekAt = lastInput + 2000;
}

function setRoaming(value) {
  settings.roam = value;
  if (!value && ['tiny-steps', 'tail-nap', 'sneaky-peek'].includes(current)) play('idle');
  activity();
}

function behaviors(now) {
  if (pressed || click || importing || !settings.roam || !win.isVisible() || current !== 'idle') return;
  if (now - lastInput > 90000) play('tail-nap', { now });
  else if (now >= nextRoamAt) {
    nextRoamAt = now + 30000;
    play('tiny-steps', { now });
  }
}

function showPet() {
  if (desktopReady() && !win.isVisible()) win.showInactive();
}

function menuItems() {
  return [
    { label: win.isVisible() ? '隐藏桌宠' : '显示桌宠', click: () => win.isVisible() ? win.hide() : showPet() },
    { label: '播放动作', submenu: Object.entries(actions).map(([id, label]) =>
      ({ label, click: () => { activity(); showPet(); play(id); } })) },
    { type: 'separator' },
    { label: '总在最前', type: 'checkbox', checked: settings.top, click: item => {
      settings.top = item.checked;
      win.setAlwaysOnTop(settings.top);
      void save();
    } },
    { label: '自由活动', type: 'checkbox', checked: settings.roam, click: item => {
      setRoaming(item.checked);
      void save();
    } },
    { label: '大小', submenu: sizes.map((size, index) => ({
      label: ['小', '中', '大'][index], type: 'radio', checked: settings.size === size,
      click: () => {
        if (motion) play('idle');
        const b = win.getBounds();
        const next = { ...b, y: b.y + b.height - size, x: b.x + Math.round((b.width - size) / 2),
          width: size, height: size };
        win.setBounds({ ...next, ...clamp(next) });
        settings.size = size;
        remember();
      },
    })) },
    { label: '复位到屏幕右下角', click: () => { motion = null; play('idle'); placeDefault(); remember(); showPet(); } },
    { label: '导入角色包…', click: () => { void importPack(); } },
    { label: '恢复内置角色', enabled: Boolean(settings.customPack), click: () => { void restorePack(); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ];
}

function popup() {
  if (!desktopReady()) return;
  activity();
  Menu.buildFromTemplate(menuItems()).popup({ window: win });
}

function sendPack(pack) {
  if (!desktopReady()) return Promise.reject(Error('桌宠窗口已关闭'));
  const token = ++packToken;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { loading = null; reject(Error('角色素材读取超时')); }, 20000);
    loading = { token, done(error) {
      clearTimeout(timer);
      loading = null;
      if (error) reject(Error(error));
      else resolve();
    } };
    win.webContents.send('pet:pack', { ...pack, token });
  });
}

async function storePack(candidate) {
  const folder = await fs.mkdtemp(path.join(profile, 'pack-'));
  const manifest = { version: 1, animations: {} };
  for (const [id, { source, ...item }] of Object.entries(candidate.animations)) {
    const filename = id + path.extname(item.file);
    manifest.animations[id] = { ...item, file: filename };
    await fs.writeFile(path.join(folder, filename), Buffer.from(source.split(',')[1], 'base64'));
  }
  await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
  return path.basename(folder);
}

function packFingerprint(pack) {
  const hash = createHash('sha256');
  for (const id of packActions) {
    const bytes = Buffer.from(pack.animations[id].source.split(',')[1], 'base64');
    hash.update(id + ':');
    hash.update(createHash('sha256').update(bytes).digest('hex'));
    hash.update('\n');
  }
  return hash.digest('hex');
}

async function loadCustomPack() {
  const original = await readPack(path.join(profile, settings.customPack));
  const upgradeDir = path.join(process.resourcesPath, 'pet-upgrade');
  let upgraded;
  try {
    const { from } = JSON.parse(await fs.readFile(path.join(upgradeDir, 'upgrade.json'), 'utf8'));
    if (from === packFingerprint(original)) {
      const candidate = await readPack(upgradeDir);
      const folder = await storePack(candidate);
      await sendPack(candidate);
      const previous = settings.customPack;
      settings.customPack = folder;
      try {
        await save();
        upgraded = candidate;
      } catch (error) {
        settings.customPack = previous;
        throw error;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('角色升级失败，继续使用已有角色', error.message);
  }
  if (!upgraded) await sendPack(original);
  activePack = upgraded || original;
  activeCustomPack = settings.customPack;
}

async function importPack() {
  if (importing) return;
  importing = true;
  let oldPack = activePack;
  try {
    const result = await dialog.showOpenDialog({ title: '选择角色包的 manifest.json',
      properties: ['openFile'], filters: [{ name: '角色清单', extensions: ['json'] }] });
    if (result.canceled || !desktopReady()) return;
    if (path.basename(result.filePaths[0]) !== 'manifest.json') throw Error('请选择 manifest.json');
    const candidate = await readPack(path.dirname(result.filePaths[0]));
    const folder = await storePack(candidate);
    await sendPack(candidate);
    const previous = settings.customPack;
    settings.customPack = folder;
    try {
      await save();
    } catch (error) {
      settings.customPack = previous;
      throw error;
    }
    activePack = candidate;
    activeCustomPack = folder;
    oldPack = null;
    showPet();
    play('idle');
  } catch (error) {
    if (!desktopReady()) return;
    if (oldPack) await sendPack(oldPack).catch(console.error);
    if (desktopReady()) dialog.showErrorBox('无法导入角色包', error.message);
  } finally {
    importing = false;
  }
}

async function restorePack() {
  if (importing) return;
  importing = true;
  try {
    const candidate = await readPack(bundled);
    await sendPack(candidate);
    activePack = candidate;
    delete settings.customPack;
    activeCustomPack = null;
    await save();
    play('idle');
  } catch (error) {
    if (desktopReady()) dialog.showErrorBox('无法恢复内置角色', error.message);
  } finally { importing = false; }
}

function bind(name, handler) {
  ipcMain.on(`pet:${name}`, (event, payload) => {
    if (desktopReady() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame) handler(payload);
  });
}

function sample(now) {
  const token = ++sampleToken;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('等待动画回执超时')), 5000);
    sampleRequest = { token, done(value) { clearTimeout(timer); resolve(value); } };
    win.webContents.send('pet:sample', { now, token });
  });
}

async function checkPlayback() {
  const originalBounds = win.getBounds();
  const start = Date.now();
  if (!win.isVisible()) throw Error('悬浮窗未正常显示');
  setRoaming(false);
  behaviors(start + 30001);
  if ((await sample(start)).id !== 'idle') throw Error('关闭自由活动后仍自动散步');
  setRoaming(true);
  const scheduled = nextRoamAt;
  behaviors(scheduled);
  if ((await sample(scheduled)).id !== 'tiny-steps') throw Error('自由活动未播放散步');
  setRoaming(false);
  if ((await sample(Date.now())).id !== 'idle') throw Error('关闭自由活动后未恢复待机');

  for (const id of Object.keys(actions)) {
    play(id, { now: start });
    const initial = await sample(start);
    if (initial.id !== id || !initial.square || !initial.aspectRatioPreserved) throw Error(`动作启动或比例错误：${id}`);
    const end = endsAt;
    const travel = motion;
    if (end !== null) {
      advancePlayback(end - 1);
      const last = await sample(end - 1);
      if (last.id !== id || last.frame !== activePack.animations[id].frameDurationsMs.length - 1) throw Error(`动作提前结束：${id}`);
      advancePlayback(end);
      const after = await sample(end);
      if (after.id !== 'idle') throw Error(`动作未恢复待机：${id}`);
    } else play('idle', { now: start });
    const { width, height, x, y } = win.getBounds();
    if (width !== originalBounds.width || height !== originalBounds.height || width !== height) throw Error('动作改变了窗口尺寸');
    if (travel && (x !== Math.round(travel.endX) || y !== travel.bounds.y)) throw Error(`移动未在原高度完成：${id}`);
  }

  play('glide');
  const cursor = screen.getCursorScreenPoint();
  const before = win.getBounds();
  const area = screen.getDisplayMatching(before).workArea;
  const direction = before.x - area.x > 24 ? -1 : 1;
  const hold = Date.now();
  scheduleClick();
  beginPointer(cursor, hold);
  if (click) throw Error('拖动时仍存在待处理的单击');
  const frozen = await sample(hold);
  if (frozen.id !== 'glide') throw Error('按住时切换了动作');
  movePointer({ x: cursor.x + 24 * direction, y: cursor.y });
  advancePlayback(hold + 5000);
  const dragged = await sample(hold + 5000);
  const moved = win.getBounds();
  if (moved.x === before.x || moved.width !== before.width || moved.height !== before.height ||
      dragged.id !== frozen.id || dragged.frame !== frozen.frame || !dragged.square) throw Error('拖动改变了画面或尺寸');
  endPointer(false, hold + 5000);
  play('idle');

  win.hide();
  if (win.isVisible()) throw Error('无法隐藏桌宠');
  showPet();
  if (!win.isVisible()) throw Error('无法恢复桌宠');
}

async function finishSmoke(error, hashes = {}) {
  const checks = [];
  trace('smoke finish: ' + (error || 'renderer succeeded'));
  const originalPosition = settings.position;
  const originalRoaming = settings.roam;
  try {
    if (!error) {
      await checkPlayback();
      checks.push('offline-pack-decode', 'alpha-in-every-frame', 'distinct-animation-frames',
        'all-menu-actions', 'window-show-hide', 'fixed-aspect-and-canvas', 'motion-lands-before-idle',
        'all-actions-return-to-idle', 'run-cycle-completes', 'roaming-toggle', 'drag-keeps-pose-and-size');
    }
  } catch (failure) {
    error = failure.message;
  }
  settings.position = originalPosition;
  settings.roam = originalRoaming;
  smokeResult = { ok: !error, error, pack: localBrand ? 'local' : 'demo',
    customPack: activeCustomPack, size: desktopReady() ? win.getBounds().width : null,
    animations: Object.keys(hashes), checks };
  if (error) {
    await fs.writeFile(smokePath, JSON.stringify(smokeResult, null, 2));
    stopDesktop();
    app.exit(1);
    return;
  }

  // Run real polling and queue a real menu interaction before testing Exit.
  startDesktopTimer();
  play('glide');
  await delay(85);
  scheduleClick();
  if (!desktopTimer || !click || !motion) throw Error('未能准备退出回归测试');
  menuItems().at(-1).click();

}

async function launch() {
  trace('app ready');
  await fs.mkdir(profile, { recursive: true });
  try {
    const raw = JSON.parse(await fs.readFile(path.join(profile, 'settings.json'), 'utf8'));
    settings = { ...defaults, ...raw };
    if (!sizes.includes(settings.size)) settings.size = defaults.size;
    settings.top = settings.top !== false;
    settings.roam = settings.roam !== false;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(error.message);
  }
  trace('create window');
  win = new BrowserWindow({
    width: settings.size, height: settings.size, show: false, transparent: true,
    frame: false, hasShadow: false, resizable: false, movable: false,
    focusable: false, skipTaskbar: true, alwaysOnTop: settings.top,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false,
    },
  });
  win.once('closed', () => {
    stopDesktop();
    win = null;
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.setIgnoreMouseEvents(true, { forward: true });
  placeDefault();
  if (Number.isFinite(settings.position?.x) && Number.isFinite(settings.position?.y)) {
    const b = { ...win.getBounds(), ...settings.position };
    win.setBounds({ ...b, ...clamp(b) });
  }

  bind('loaded', ({ token, error }) => { if (loading?.token === token) loading.done(error); });
  bind('hit', value => { hit = value === true; refreshIgnore(); });
  bind('pointer-down', () => { if (hit) beginPointer(screen.getCursorScreenPoint()); });
  bind('pointer-up', () => {
    if (pressed) movePointer(screen.getCursorScreenPoint());
    endPointer();
  });
  bind('pointer-cancel', () => endPointer(true));
  bind('menu', popup);
  if (smokePath) {
    bind('sampled', result => {
      if (sampleRequest?.token === result.token) sampleRequest.done(result);
    });
    bind('verified', ({ hashes, error }) => {
      void finishSmoke(error, hashes).catch(async failure => {
        trace(failure.stack);
        stopDesktop();
        app.exit(1);
      });
    });
  }

  trace('load window');
  win.webContents.on('render-process-gone', (_event, details) => trace('renderer gone ' + details.reason));
  await win.loadFile(path.join(__dirname, 'index.html'));
  trace('window loaded');
  if (typeof settings.customPack === 'string' && /^pack-[A-Za-z0-9]+$/.test(settings.customPack)) {
    try {
      await loadCustomPack();
    } catch (error) {
      delete settings.customPack;
      await save();
      if (!smokePath) dialog.showErrorBox('自定义角色读取失败，已使用内置角色', error.message);
    }
  }
  if (!activePack) {
    activePack = await readPack(bundled);
    await sendPack(activePack);
  }
  trace('pack loaded');
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png')).resize({ width: 16, height: 16 });
  trace('create tray');
  tray = new Tray(icon);
  trace('tray created');
  tray.setToolTip(app.getName());
  const refreshTray = () => {
    if (desktopReady() && tray) tray.setContextMenu(Menu.buildFromTemplate(menuItems()));
  };
  tray.on('click', () => {
    if (!desktopReady()) return;
    if (process.platform === 'darwin') popup();
    else {
      if (win.isVisible()) win.hide();
      else showPet();
    }
  });
  tray.on('right-click', refreshTray);
  win.on('show', refreshTray);
  win.on('hide', () => {
    endPointer(true);
    clearTimeout(click);
    click = null;
    refreshTray();
  });
  refreshTray();
  showPet();
  play('idle');
  constrainDisplay = () => {
    if (!desktopReady()) return;
    if (pressed) {
      movePointer(screen.getCursorScreenPoint());
      return;
    }
    if (motion) play('idle');
    const b = { ...win.getBounds(), width: settings.size, height: settings.size };
    win.setBounds({ ...b, ...clamp(b) });
    remember();
  };
  screen.on('display-removed', constrainDisplay);
  screen.on('display-metrics-changed', constrainDisplay);
  if (!smokePath) startDesktopTimer();
  if (smokePath) {
    trace('verify renderer');
    win.webContents.send('pet:verify');
  }
}

if (!smokePath && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('before-quit', event => {
    if (quitReady) return;
    event.preventDefault();
    if (quitRequested) return;
    quitRequested = true;
    const hadPendingWork = Boolean(desktopTimer && click && constrainDisplay);
    stopDesktop();
    void writeQueue.catch(console.error).then(async () => {
      if (smokeResult) {
        const cleanedUp = hadPendingWork && !desktopTimer && !click && !constrainDisplay && !tray;
        if (cleanedUp) smokeResult.checks.push('tray-quit-stops-callbacks');
        else {
          smokeResult.ok = false;
          smokeResult.error = '退出时没有正确结束桌面任务';
        }
        await fs.writeFile(smokePath, JSON.stringify(smokeResult, null, 2));
      }
    }).catch(console.error).finally(() => {
      quitReady = true;
      app.quit();
    });
  });
  app.on('second-instance', showPet);
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(launch).catch(async error => {
    trace('launch error ' + error.stack);
    if (stopping) return;
    if (smokePath) await finishSmoke(error.message);
    else {
      dialog.showErrorBox('桌宠启动失败', error.message);
      app.exit(1);
    }
  });
}
