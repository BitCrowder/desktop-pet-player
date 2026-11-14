import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const electronVersion = '44.11.3';
const electronZipHash = '97fca9b8e9b90cdc88c1efd44160ca4b89b15101721d93c8befcbeb35b93fb59';
const electronZipName = `electron-v${electronVersion}-win32-x64.zip`;
const electronUrl = `https://github.com/electron/electron/releases/download/v${electronVersion}/${electronZipName}`;

if (appPackage.devDependencies.electron !== electronVersion) {
  throw new Error('Update the pinned Windows Electron archive and its SHA256 alongside the Electron dependency.');
}
if (process.argv.slice(2).some((argument) => argument !== '--private')) {
  throw new Error('Usage: node scripts/build-windows.mjs [--private]');
}

const personal = process.argv.includes('--private');
if (personal && process.env.CI) {
  throw new Error('Personal artwork can only be packaged locally.');
}
const mode = personal ? 'private' : 'public';
const appId = personal ? 'MomongaDesktopPet' : 'DesktopPetPlayer';
const productName = personal ? 'Momonga Desktop Pet' : 'Desktop Pet Player';
const packSource = path.join(root, personal ? 'private-assets/pet-pack' : 'demo-pack');
const outputDir = path.join(root, 'dist', 'windows', mode);
const filename = `${appId}-Setup-${appPackage.version}-x64.exe`;
const cacheDir = process.env.DESKTOP_PET_CACHE || path.join(homedir(), '.cache', 'desktop-pet-player');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status ?? result.signal}.`);
}

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadZip(directory) {
  await mkdir(directory, { recursive: true });
  const cachedZip = path.join(directory, electronZipName);
  try {
    if (await sha256(cachedZip) === electronZipHash) return cachedZip;
    throw new Error(`Cached Electron archive has an unexpected SHA256: ${cachedZip}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const scratch = await mkdtemp(path.join(directory, 'download-'));
  try {
    const response = await fetch(electronUrl, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`Electron download returned HTTP ${response.status}.`);
    const downloaded = path.join(scratch, electronZipName);
    await pipeline(response.body, createWriteStream(downloaded));
    if (await sha256(downloaded) !== electronZipHash) {
      throw new Error('Downloaded Electron archive did not match the pinned SHA256.');
    }
    await rename(downloaded, cachedZip);
    return cachedZip;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function copyTree(source, target) {
  if (!(await stat(source)).isDirectory()) throw new Error(`Expected a directory at ${source}`);
  await cp(source, target, {
    recursive: true,
    filter: (filename) => !path.basename(filename).startsWith('.') && path.basename(filename) !== 'node_modules',
  });
  for (const entry of await readdir(target, { recursive: true, withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isFile()) throw new Error(`Unexpected packaged object: ${entry.name}`);
  }
}

function nsisPath(relative) {
  if (/[\r\n"]/u.test(relative)) throw new Error(`File name cannot be represented in the installer: ${relative}`);
  return relative.split(path.sep).join('\\').replaceAll('$', '$$$$');
}

async function createFileList(payload) {
  const entries = await readdir(payload, { recursive: true, withFileTypes: true });
  const files = [];
  const directories = [];
  for (const entry of entries) {
    const relative = path.relative(payload, path.join(entry.parentPath, entry.name));
    (entry.isDirectory() ? directories : files).push(relative);
  }
  directories.sort((left, right) => right.split(path.sep).length - left.split(path.sep).length);
  return [
    ...files.sort().map((file) => `Delete "$INSTDIR\\${nsisPath(file)}"`),
    ...directories.map((directory) => `RMDir "$INSTDIR\\${nsisPath(directory)}"`),
    '',
  ].join('\n');
}

await stat(path.join(root, 'app', 'main.cjs'));
await stat(packSource);
const archive = await downloadZip(cacheDir);
await mkdir(outputDir, { recursive: true });
const staging = await mkdtemp(path.join(outputDir, '.build-'));
try {
  const payload = path.join(staging, 'payload');
  const appDir = path.join(payload, 'resources', 'app');
  await mkdir(payload);
  if (process.platform === 'win32') run('tar.exe', ['-xf', archive, '-C', payload]);
  else run('unzip', ['-q', archive, '-d', payload]);

  await rename(path.join(payload, 'electron.exe'), path.join(payload, `${appId}.exe`));
  await rm(path.join(payload, 'resources', 'default_app.asar'), { force: true });
  await mkdir(appDir);
  await copyTree(path.join(root, 'app'), path.join(appDir, 'app'));
  await copyTree(packSource, path.join(payload, 'resources', 'pet-pack'));
  await cp(path.join(root, 'LICENSE'), path.join(appDir, 'LICENSE'));
  await cp(path.join(root, 'ASSET-NOTICE.md'), path.join(appDir, 'ASSET-NOTICE.md'));
  if (personal) {
    await cp(path.join(root, 'private-assets', 'INSTALL-ZH-CN.txt'), path.join(payload, 'INSTALL-ZH-CN.txt'));
  }
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify({
    name: appId,
    productName,
    version: appPackage.version,
    main: appPackage.main,
  }, null, 2) + '\n');

  const uninstallFiles = path.join(staging, 'uninstall-files.nsh');
  await writeFile(uninstallFiles, await createFileList(payload));
  const installer = path.join(staging, filename);
  const prefix = process.platform === 'win32' ? '/' : '-';
  const defines = {
    APP_ID: appId,
    APP_VERSION: appPackage.version,
    PRODUCT_NAME: productName,
    PAYLOAD_DIR: payload,
    INSTALLER_PATH: installer,
    UNINSTALL_FILES: uninstallFiles,
  };
  run(process.env.MAKENSIS_PATH || 'makensis', [
    `${prefix}V2`, `${prefix}WX`,
    ...Object.entries(defines).map(([name, value]) => `${prefix}D${name}=${value}`),
    path.join(root, 'installer', 'windows.nsi'),
  ]);
  const hash = await sha256(installer);
  await rename(installer, path.join(outputDir, filename));
  await writeFile(path.join(outputDir, `${filename}.sha256`), `${hash}  ${filename}\n`);
  console.log(`Packaged ${mode} Windows x64 installer at ${path.join(outputDir, filename)}`);
  console.log(`SHA256 ${hash}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
