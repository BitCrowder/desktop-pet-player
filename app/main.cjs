const { app, BrowserWindow, Menu, Tray, screen, ipcMain, dialog, nativeImage, session } = require('electron');
const fs = require('node:fs/promises');
const { appendFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const { readPack } = require('./packs.cjs');

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
const profile = smokePath ? path.join(path.dirname(smokePath), 'smoke-profile') : path.join(app.getPath('appData'), appFolder);
app.setName(localBrand ? '飞鼠桌宠' : 'Desktop Pet Player');
mkdirSync(profile, { recursive: true });
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
let lastAuto = Date.now();
let current = 'idle';
let writeQueue = Promise.resolve();

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
  const next = !hit && !pressed;
  if (next === ignoring) return;
  ignoring = next;
  win.setIgnoreMouseEvents(ignoring, { forward: true });
}

function updateCursor(now) {
  if (!win.isVisible() || !activePack) return;
  const b = win.getBounds();
  const cursor = screen.getCursorScreenPoint();
  if (pressed) {
    const dx = cursor.x - pressed.cursor.x;
    const dy = cursor.y - pressed.cursor.y;
    if (Math.hypot(dx, dy) >= 5) pressed.dragging = true;
    if (pressed.dragging) {
      const target = clamp({ ...b, x: pressed.x + dx, y: pressed.y + dy },
        screen.getDisplayNearestPoint(cursor).workArea);
      if (target.x !== b.x || target.y !== b.y) win.setPosition(target.x, target.y);
    }
  } else if (motion) {
    const progress = Math.min(1, (now - motion.start) / motion.time);
    const eased = motion.id === 'glide' ? progress * (2 - progress) : progress;
    const next = clamp({ ...b, x: motion.x + motion.dx * eased,
      y: motion.y - (motion.id === 'glide' ? 50 * Math.sin(Math.PI * progress) : 0) });
    if (next.x !== b.x || next.y !== b.y) win.setPosition(next.x, next.y);
    if (progress === 1) {
      motion = null;
      remember();
    }
  }
  const bounds = win.getBounds();
  const local = { x: (cursor.x - bounds.x) / bounds.width, y: (cursor.y - bounds.y) / bounds.height };
  if (!lastCursor || lastCursor.x !== local.x || lastCursor.y !== local.y) {
    lastCursor = local;
    win.webContents.send('pet:cursor', local);
    const nearby = local.x > -0.15 && local.x < 1.15 && local.y > -0.1 && local.y < 1.15;
    if (nearby && !nearbyBefore) {
      if (!pressed && !click && settings.roam && current === 'idle' && now - lastPeek > 18000) {
        lastPeek = now;
        play('sneaky-peek', { flip: local.x < 0.5 });
      }
    }
    nearbyBefore = nearby;
  }
}

function play(id, { flip = false } = {}) {
  if (!activePack?.animations[id]) return;
  motion = null;
  current = id;
  const duration = activePack.animations[id].frameDurationsMs.reduce((a, b) => a + b, 0);
  const bounds = win.getBounds();
  if (!pressed && (id === 'glide' || id === 'tiny-steps')) {
    const area = screen.getDisplayMatching(bounds).workArea;
    const availableLeft = bounds.x - area.x;
    const availableRight = area.x + area.width - bounds.x - bounds.width;
    const sign = availableRight >= availableLeft ? 1 : -1;
    const distance = id === 'glide' ? 126 : 94;
    const dx = sign * Math.min(distance, Math.max(availableLeft, availableRight));
    const time = id === 'tiny-steps' ? Math.max(1900, duration * 3) : duration;
    flip = id === 'tiny-steps' ? sign > 0 : sign < 0;
    motion = { id, x: bounds.x, y: bounds.y, dx, start: Date.now(), time };
    win.webContents.send('pet:animate', { id, flip, repeat: id === 'tiny-steps' });
    return;
  }
  win.webContents.send('pet:animate', { id, flip });
}

function activity() {
  lastInput = Date.now();
}

function behaviors(now) {
  if (motion === null && current === 'tiny-steps') play('idle');
  if (pressed || click || !settings.roam || !win.isVisible()) return;
  if (current === 'idle' && now - lastInput > 90000) play('tail-nap');
  else if (current === 'idle' && now - lastAuto > 30000) {
    lastAuto = now;
    play('tiny-steps');
  }
}

function showPet() {
  if (!win.isVisible()) win.showInactive();
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
      settings.roam = item.checked;
      if (!settings.roam && ['tiny-steps', 'tail-nap'].includes(current)) play('idle');
      activity();
      void save();
    } },
    { label: '大小', submenu: sizes.map((size, index) => ({
      label: ['小', '中', '大'][index], type: 'radio', checked: settings.size === size,
      click: () => {
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
  activity();
  Menu.buildFromTemplate(menuItems()).popup({ window: win });
}

function sendPack(pack) {
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

async function importPack() {
  if (importing) return;
  importing = true;
  let oldPack = activePack;
  try {
    const result = await dialog.showOpenDialog({ title: '选择角色包的 manifest.json',
      properties: ['openFile'], filters: [{ name: '角色清单', extensions: ['json'] }] });
    if (result.canceled) return;
    if (path.basename(result.filePaths[0]) !== 'manifest.json') throw Error('请选择 manifest.json');
    const candidate = await readPack(path.dirname(result.filePaths[0]));
    const folder = await fs.mkdtemp(path.join(profile, 'pack-'));
    const manifest = { version: 1, animations: {} };
    await Promise.all(Object.entries(candidate.animations).map(async ([id, { source, ...item }]) => {
      const filename = id + path.extname(item.file);
      manifest.animations[id] = { ...item, file: filename };
      await fs.writeFile(path.join(folder, filename), Buffer.from(source.split(',')[1], 'base64'));
    }));
    await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
    await sendPack(candidate);
    settings.customPack = path.basename(folder);
    await save();
    activePack = candidate;
    oldPack = null;
    showPet();
    play('idle');
  } catch (error) {
    if (oldPack) await sendPack(oldPack).catch(console.error);
    dialog.showErrorBox('无法导入角色包', error.message);
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
    await save();
    play('idle');
  } catch (error) {
    dialog.showErrorBox('无法恢复内置角色', error.message);
  } finally { importing = false; }
}

function bind(name, handler) {
  ipcMain.on(`pet:${name}`, (event, payload) => {
    if (event.sender === win?.webContents && event.senderFrame === win.webContents.mainFrame) handler(payload);
  });
}

async function finishSmoke(error, hashes = {}) {
  const checks = [];
  trace('smoke finish: ' + (error || 'renderer succeeded'));
  try {
  if (!error) {
    for (const id of Object.keys(actions)) {
      play(id);
      if (current !== id) error = `未能切换动作 ${id}`;
    }
    play('idle');
    if (!win.isVisible() || !win.isAlwaysOnTop()) error = '悬浮窗未正常显示';
    else {
      win.hide();
      if (win.isVisible()) error = '无法隐藏桌宠';
      showPet();
      if (!win.isVisible()) error = '无法恢复桌宠';
    }
    checks.push('offline-pack-decode', 'alpha-in-every-frame', 'distinct-animation-frames', 'all-menu-actions', 'window-show-hide');
  }
  } catch (failure) { error = failure.message; }
  trace('write result: ' + (error || 'success'));
  await fs.writeFile(smokePath, JSON.stringify({ ok: !error, error, pack: localBrand ? 'local' : 'demo',
    animations: Object.keys(hashes), checks }, null, 2));
  app.exit(error ? 1 : 0);
}

async function launch() {
  trace('app ready');
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
  bind('ended', id => { if (current === id) { current = 'idle'; motion = null; } });
  bind('pointer-down', () => {
    if (!hit || pressed) return;
    activity();
    const { x, y } = win.getBounds();
    motion = null;
    play('idle');
    pressed = { x, y, cursor: screen.getCursorScreenPoint(), dragging: false };
    refreshIgnore();
  });
  bind('pointer-up', () => {
    if (!pressed) return;
    const { dragging } = pressed;
    pressed = null;
    refreshIgnore();
    if (dragging) {
      clearTimeout(click);
      click = null;
      remember();
      return;
    }
    if (click) {
      clearTimeout(click);
      click = null;
      play('tantrum-roll');
    } else {
      click = setTimeout(() => { click = null; play('act-cute'); }, 275);
    }
  });
  bind('pointer-cancel', () => { if (pressed?.dragging) remember(); pressed = null; refreshIgnore(); });
  bind('menu', popup);
  if (smokePath) bind('verified', ({ hashes, error }) => { void finishSmoke(error, hashes); });

  trace('load window');
  win.webContents.on('render-process-gone', (_event, details) => trace('renderer gone ' + details.reason));
  await win.loadFile(path.join(__dirname, 'index.html'));
  trace('window loaded');
  if (typeof settings.customPack === 'string' && /^pack-[A-Za-z0-9]+$/.test(settings.customPack)) {
    try {
      const candidate = await readPack(path.join(profile, settings.customPack));
      await sendPack(candidate);
      activePack = candidate;
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
  const refreshTray = () => tray.setContextMenu(Menu.buildFromTemplate(menuItems()));
  tray.on('click', () => {
    if (process.platform === 'darwin') popup();
    else {
      if (win.isVisible()) win.hide();
      else showPet();
    }
  });
  tray.on('right-click', refreshTray);
  win.on('show', refreshTray);
  win.on('hide', refreshTray);
  refreshTray();
  showPet();
  play('idle');
  const constrain = () => {
    const b = win.getBounds();
    win.setBounds({ ...b, ...clamp(b) });
    remember();
  };
  screen.on('display-removed', constrain);
  screen.on('display-metrics-changed', constrain);
  setInterval(() => {
    const now = Date.now();
    updateCursor(now);
    behaviors(now);
  }, 25).unref();
  if (smokePath) {
    trace('verify renderer');
    win.webContents.send('pet:verify');
  }
}

if (!smokePath && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win && !win.isDestroyed()) showPet(); });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(launch).catch(async error => {
    trace('launch error ' + error.stack);
    if (smokePath) await finishSmoke(error.message);
    else {
      dialog.showErrorBox('桌宠启动失败', error.message);
      app.exit(1);
    }
  });
}
