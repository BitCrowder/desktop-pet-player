import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'win32', 'The installer check must run on Windows.');
const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const personal = process.argv.includes('--private');
const mode = personal ? 'private' : 'public';
const appId = personal ? 'MomongaDesktopPet' : 'DesktopPetPlayer';
const outputDir = path.join(root, 'dist', 'windows', mode);
const filename = `${appId}-Setup-${version}-x64.exe`;
const installer = path.join(outputDir, filename);
const installedDir = path.join(process.env.LOCALAPPDATA, 'Programs', appId);
const installedExe = path.join(installedDir, `${appId}.exe`);
const uninstaller = path.join(installedDir, 'Uninstall.exe');

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit', timeout: 90_000, ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(executable)} exited with code ${code ?? signal}.`));
    });
  });
}

async function assertWindowsX64(executable) {
  const file = await open(executable, 'r');
  try {
    const dosHeader = Buffer.alloc(64);
    assert.equal((await file.read(dosHeader, 0, dosHeader.length, 0)).bytesRead, dosHeader.length);
    assert.equal(dosHeader.toString('ascii', 0, 2), 'MZ', 'The installed program is missing its DOS header.');
    const peHeader = Buffer.alloc(6);
    const offset = dosHeader.readUInt32LE(0x3c);
    assert.equal((await file.read(peHeader, 0, peHeader.length, offset)).bytesRead, peHeader.length);
    assert.equal(peHeader.toString('ascii', 0, 4), 'PE\0\0', 'The installed program is missing its PE signature.');
    assert.equal(peHeader.readUInt16LE(4), 0x8664, 'The installed program is not a Windows x64 binary.');
  } finally {
    await file.close();
  }
}

const expectedHash = (await readFile(`${installer}.sha256`, 'utf8')).split(/\s+/u)[0];
const digest = createHash('sha256');
for await (const chunk of createReadStream(installer)) digest.update(chunk);
assert.equal(digest.digest('hex'), expectedHash, 'Installer checksum does not match the built installer.');
assert.equal(await exists(installedDir), false, 'The test requires a clean Windows installation of this app.');

const fixtures = await mkdtemp(path.join(tmpdir(), 'desktop-pet-smoke-'));
try {
  await run(installer, ['/S']);
  assert.equal(await exists(installedExe), true, 'NSIS did not install the Windows executable.');
  assert.equal(await exists(uninstaller), true, 'NSIS did not install the uninstaller.');
  await assertWindowsX64(installedExe);

  const sourcePack = path.join(root, personal ? 'private-assets/pet-pack' : 'demo-pack');
  const installedPack = path.join(installedDir, 'resources', 'pet-pack');
  const manifest = await readFile(path.join(sourcePack, 'manifest.json'), 'utf8');
  assert.equal(await readFile(path.join(installedPack, 'manifest.json'), 'utf8'), manifest);
  for (const { file } of Object.values(JSON.parse(manifest).animations)) {
    assert.deepEqual(await readFile(path.join(installedPack, file)), await readFile(path.join(sourcePack, file)),
      `The installed animation ${file} does not match the selected asset pack.`);
  }
  const resultFile = path.join(fixtures, 'renderer-result.json');
  await run(installedExe, [`--smoke-file=${resultFile}`]);
  const result = JSON.parse(await readFile(resultFile, 'utf8'));
  assert.equal(result.ok, true, 'The installed renderer did not complete its checks.');
  assert.equal(result.pack, personal ? 'local' : 'demo', 'The installed app loaded the wrong animation pack.');
  assert.deepEqual(result.animations.slice().sort(), Object.keys(JSON.parse(manifest).animations).sort(),
    'The installed renderer did not load all animations.');
  for (const check of ['offline-pack-decode', 'alpha-in-every-frame', 'distinct-animation-frames', 'all-menu-actions', 'window-show-hide']) {
    assert.ok(result.checks.includes(check), `The installed renderer did not confirm ${check}.`);
  }

  // Run a copy so the uninstaller can remove its original executable synchronously.
  const testUninstaller = path.join(fixtures, 'Uninstall.exe');
  await copyFile(uninstaller, testUninstaller);
  await run(testUninstaller, ['/S', `_?=${installedDir}`], { windowsVerbatimArguments: true });
  assert.equal(await exists(installedExe), false, 'The uninstaller left the app executable installed.');
  assert.equal(await exists(uninstaller), false, 'The uninstaller left its installed executable behind.');
  const evidence = { installer: filename, sha256: expectedHash, windowsRelease: release(), architecture: process.arch, result };
  await writeFile(path.join(outputDir, 'smoke-results.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(evidence);
} finally {
  await rm(fixtures, { recursive: true, force: true });
}
