const fs = require('node:fs/promises');
const path = require('node:path');

const actions = ['idle', 'act-cute', 'glide', 'tail-nap', 'snack', 'tantrum-roll', 'sneaky-peek', 'tiny-steps'];

async function readPack(dir) {
  const manifestText = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
  if (manifestText.length > 65536) throw Error('角色清单过大');
  const manifest = JSON.parse(manifestText);
  if (manifest.version !== 1) throw Error('角色包版本不受支持');
  const entries = await Promise.all(actions.map(async (id) => {
    const item = manifest.animations?.[id];
    if (!item || typeof item.file !== 'string' || !/^[a-zA-Z0-9_-]+\.(webp|png)$/.test(item.file)) {
      throw Error(`缺少动作素材：${id}`);
    }
    const { frameWidth, frameHeight, columns, frameDurationsMs, loop, facing, unflippedFrames } = item;
    if (![frameWidth, frameHeight].every(v => Number.isInteger(v) && v >= 32 && v <= 768) ||
        !Number.isInteger(columns) || columns < 1 || columns > 16 ||
        !Array.isArray(frameDurationsMs) || frameDurationsMs.length < 1 ||
        frameDurationsMs.length > 90 ||
        frameDurationsMs.some(v => !Number.isInteger(v) || v < 16 || v > 10000) ||
        typeof loop !== 'boolean' ||
        (facing !== undefined && !['left', 'right', 'front'].includes(facing)) ||
        (unflippedFrames !== undefined && (!Array.isArray(unflippedFrames) ||
          unflippedFrames.length > frameDurationsMs.length ||
          unflippedFrames.some(v => !Number.isInteger(v) || v < 0 || v >= frameDurationsMs.length)))) throw Error(`动作参数有误：${id}`);
    const file = path.join(dir, item.file);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw Error(`素材文件不可用：${id}`);
    const bytes = await fs.readFile(file);
    const isPng = item.file.endsWith('.png') && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const isWebp = item.file.endsWith('.webp') && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!isPng && !isWebp) throw Error(`图像格式错误：${id}`);
    return [id, { file: item.file, frameWidth, frameHeight, columns, frameDurationsMs, loop, facing, unflippedFrames,
      source: `data:image/${isPng ? 'png' : 'webp'};base64,${bytes.toString('base64')}` }];
  }));
  return { version: 1, animations: Object.fromEntries(entries) };
}

module.exports = { actions, readPack };
