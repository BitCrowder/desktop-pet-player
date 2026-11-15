import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, cp, copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'win32', 'The installer check must run on Windows.');
const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const personal = process.argv.includes('--private');
const upgrade = process.argv.includes('--upgrade-from-v1');
assert.ok(!upgrade || (!personal && version !== '1.0.0'), 'Upgrade verification requires a newer public build.');
const mode = personal ? 'private' : 'public';
const appId = personal ? 'MomongaDesktopPet' : 'DesktopPetPlayer';
const outputDir = path.join(root, 'dist', 'windows', mode);
const filename = `${appId}-Setup-${version}-x64.exe`;
const installer = path.join(outputDir, filename);
const installedDir = path.join(process.env.LOCALAPPDATA, 'Programs', appId);
const installedExe = path.join(installedDir, `${appId}.exe`);
const uninstaller = path.join(installedDir, 'Uninstall.exe');
const profile = path.join(process.env.APPDATA, appId);
const previousInstallerUrl = 'https://github.com/BitCrowder/desktop-pet-player/releases/download/v1.0.0/DesktopPetPlayer-Setup-1.0.0-x64.exe';
const previousInstallerSha = '109992949986a1eab2f2ba6e79e1c49c4bcabbd4b0d116bd729b6dbfc44625db';
let ownsTestProfile = false;

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

async function sha256(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}

async function installedVersion() {
  return JSON.parse(await readFile(path.join(installedDir, 'resources', 'app', 'package.json'), 'utf8')).version;
}

async function setUpPreviousVersion(fixtures) {
  assert.equal(await exists(profile), false, 'The upgrade check requires a clean Windows user profile.');
  console.log('Downloading and installing the released v1.0.0 package.');
  const previousInstaller = path.join(fixtures, 'previous-setup.exe');
  const response = await fetch(previousInstallerUrl, { signal: AbortSignal.timeout(180_000) });
  assert.ok(response.ok && response.body, `Could not download the public v1.0.0 installer: HTTP ${response.status}.`);
  await pipeline(response.body, createWriteStream(previousInstaller));
  assert.equal(await sha256(previousInstaller), previousInstallerSha, 'The downloaded v1.0.0 installer checksum does not match.');
  await run(previousInstaller, ['/S']);
  assert.equal(await installedVersion(), '1.0.0');

  // Recreate the files written by v1.0.0 character import. The fixture is the
  // previous public release's own demo pack. It contains only public artwork.
  const customPack = 'pack-ciUpgrade';
  const installedPack = path.join(installedDir, 'resources', 'pet-pack');
  const fixturePack = path.join(profile, customPack);
  const settings = { size: 224, top: true, roam: false, position: { x: 64, y: 64 }, customPack };
  await mkdir(profile);
  ownsTestProfile = true;
  await cp(installedPack, fixturePack, { recursive: true });
  const settingBytes = JSON.stringify(settings);
  await writeFile(path.join(profile, 'settings.json'), settingBytes);
  const manifest = JSON.parse(await readFile(path.join(fixturePack, 'manifest.json'), 'utf8'));
  const tracks = ['manifest.json', ...new Set(Object.values(manifest.animations).map(({ file }) => file))];
  const before = await Promise.all(tracks.map(file => sha256(path.join(fixturePack, file))));

  return {
    settings,
    async assertPreserved() {
      assert.equal(await readFile(path.join(profile, 'settings.json'), 'utf8'), settingBytes,
        'Windows upgrade changed the saved settings.');
      const after = await Promise.all(tracks.map(file => sha256(path.join(fixturePack, file))));
      assert.deepEqual(after, before, 'Windows upgrade changed the imported animation pack.');
    },
  };
}

const expectedHash = (await readFile(`${installer}.sha256`, 'utf8')).split(/\s+/u)[0];
assert.equal(await sha256(installer), expectedHash, 'Installer checksum does not match the built installer.');
assert.equal(await exists(installedDir), false, 'The test requires a clean Windows installation of this app.');

const fixtures = await mkdtemp(path.join(tmpdir(), 'desktop-pet-smoke-'));
try {
  const prior = upgrade ? await setUpPreviousVersion(fixtures) : null;
  console.log(prior ? 'Installing the new version over v1.0.0.' : 'Installing the new version.');
  await run(installer, ['/S']);
  assert.equal(await exists(installedExe), true, 'NSIS did not install the Windows executable.');
  assert.equal(await exists(uninstaller), true, 'NSIS did not install the uninstaller.');
  assert.equal(await installedVersion(), version, 'The new version was not installed.');
  await assertWindowsX64(installedExe);
  if (prior) await prior.assertPreserved();

  const sourcePack = path.join(root, personal ? 'private-assets/pet-pack' : 'demo-pack');
  const installedPack = path.join(installedDir, 'resources', 'pet-pack');
  const manifest = await readFile(path.join(sourcePack, 'manifest.json'), 'utf8');
  assert.equal(await readFile(path.join(installedPack, 'manifest.json'), 'utf8'), manifest);
  for (const { file } of Object.values(JSON.parse(manifest).animations)) {
    assert.deepEqual(await readFile(path.join(installedPack, file)), await readFile(path.join(sourcePack, file)),
      `The installed animation ${file} does not match the selected asset pack.`);
  }
  const resultFile = path.join(fixtures, 'renderer-result.json');
  const chromiumLog = path.join(fixtures, 'chromium.log');
  try {
    console.log('Launching the installed Windows x64 app with the verified animation pack.');
    const smokeArgs = [`--smoke-file=${resultFile}`, '--enable-logging=file', `--log-file=${chromiumLog}`];
    if (prior) smokeArgs.push(`--smoke-profile=${profile}`);
    await run(installedExe, smokeArgs);
  } catch (error) {
    for (const diagnostic of [resultFile, `${resultFile}.trace`, chromiumLog]) {
      if (await exists(diagnostic)) {
        const log = await readFile(diagnostic, 'utf8');
        console.error(`--- ${path.basename(diagnostic)} ---\n${log.slice(-30_000)}`);
      }
    }
    throw error;
  }
  const result = JSON.parse(await readFile(resultFile, 'utf8'));
  assert.equal(result.ok, true, 'The installed renderer did not complete its checks.');
  if (prior) {
    assert.equal(result.customPack, prior.settings.customPack, 'The upgraded app did not load the saved custom pack.');
    assert.equal(result.size, prior.settings.size, 'The upgraded app did not restore the saved pet size.');
  } else {
    assert.equal(result.pack, personal ? 'local' : 'demo', 'The installed app loaded the wrong animation pack.');
  }
  assert.deepEqual(result.animations.slice().sort(), Object.keys(JSON.parse(manifest).animations).sort(),
    'The installed renderer did not load all animations.');
  const requiredChecks = ['offline-pack-decode', 'alpha-in-every-frame', 'distinct-animation-frames',
    'all-menu-actions', 'window-show-hide', 'fixed-aspect-and-canvas', 'motion-lands-before-idle',
    'all-actions-return-to-idle', 'run-cycle-completes', 'roaming-toggle'];
  for (const check of requiredChecks) {
    assert.ok(result.checks.includes(check), `The installed renderer did not confirm ${check}.`);
  }

  // Run a copy so the uninstaller can remove its original executable synchronously.
  const testUninstaller = path.join(fixtures, 'Uninstall.exe');
  await copyFile(uninstaller, testUninstaller);
  await run(testUninstaller, ['/S', `_?=${installedDir}`], { windowsVerbatimArguments: true });
  assert.equal(await exists(installedExe), false, 'The uninstaller left the app executable installed.');
  assert.equal(await exists(uninstaller), false, 'The uninstaller left its installed executable behind.');
  const evidence = { installer: filename, sha256: expectedHash, windowsRelease: release(), architecture: process.arch,
    ...(prior && { upgradedFrom: '1.0.0', existingSettingsAndPackPreserved: true }), result };
  await writeFile(path.join(outputDir, 'smoke-results.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(evidence);
} finally {
  if (ownsTestProfile) await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  await rm(fixtures, { recursive: true, force: true, maxRetries: 3 });
}
