'use strict';
/*
 * Headless browser tests (requires Playwright: `npm install --no-save playwright`
 * and `npx playwright install chromium`).
 *   1. tests/browser.html — the in-page regression suite with virtual devices
 *   2. The editor with a real PSD: anchor keyboard / mouse editing, undo
 *   3. Real face tracking with a fake webcam (tests/fixtures/face.y4m)
 */
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
const net = require('node:net');

function loadPlaywright() {
  for (const name of ['playwright', '@playwright/test']) {
    try { return require(name); } catch (err) {}
  }
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(globalRoot, 'playwright'));
  } catch (err) {}
  console.error('Playwright is not installed. Run: npm install --no-save playwright && npx playwright install chromium');
  process.exit(2);
}
const { chromium } = loadPlaywright();
const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'face.y4m');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}
async function startServer() {
  const port = await freePort(), nothing = await freePort();   // no conversion server there (a real one may run on 7860)
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const proc = spawn(python, ['serve.py', '--port', String(port), '--no-seethrough', '--seethrough-port', String(nothing)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', () => {});
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.ok) return { proc, base: `http://127.0.0.1:${port}` }; } catch (err) {}
    await new Promise(r => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('serve.py did not start');
}

let failures = 0;
function report(ok, label) { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failures++; }
function watch(page, errors) {
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/GL Driver|swiftshader|favicon/i.test(m.text())) errors.push(m.text()); });
}
const state = page => page.evaluate(() => window.Anime25D && window.Anime25D.state());

async function suite(browser, base) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(base + '/tests/browser.html');
  await page.click('#run');
  await page.waitForFunction(() => /ALL PASSED|FAIL /.test(document.getElementById('result').textContent), null, { timeout: 240000 });
  const text = await page.textContent('#result');
  console.log(text.split('\n').map(l => '  ' + l).join('\n'));
  report(/ALL PASSED/.test(text), 'in-page regression suite (tests/browser.html)');
  await page.close();
}

async function editorLive(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['camera'] });
  const errors = [];
  const editor = await context.newPage(); watch(editor, errors);
  await editor.goto(base + '/');
  await editor.click('#drop [data-sample="A"]');
  await editor.waitForFunction(() => window.Anime25D && window.Anime25D.state().layers > 0, null, { timeout: 120000 });
  report(true, 'sample A opens and rigs');
  report(await editor.evaluate(() => [...document.querySelectorAll('#diagnostics li')].some(li => li.textContent.startsWith('팔 관절') && li.classList.contains('ok'))), 'the check tab reports the arm joints');

  // keyboard nudge, then a mouse drag that follows the whole distance and is one undo step
  await editor.keyboard.press('e');
  await editor.locator('#overlay .handle[data-key="mouth"]').press('ArrowUp');
  report(((await state(editor)).anchors.mouth || {}).dy === -1, 'arrow keys move an anchor');
  await editor.keyboard.press('Escape');
  await editor.keyboard.press('Control+z');
  await editor.keyboard.press('e');
  const handle = await editor.locator('#overlay .handle[data-key="neck"] circle').boundingBox();
  const scale = await editor.evaluate(() => { const r = document.getElementById('overlay').getBoundingClientRect(); return document.getElementById('cv').width / r.width; });
  await editor.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await editor.mouse.down();
  for (let i = 1; i <= 10; i++) await editor.mouse.move(handle.x + handle.width / 2 + 6 * i, handle.y + handle.height / 2 + 3 * i);
  await editor.mouse.up();
  const dragged = (await state(editor)).anchors.neck || {};
  report(Math.abs(dragged.dx - 60 * scale) < 3 * scale && Math.abs(dragged.dy - 30 * scale) < 3 * scale, 'mouse drag moves an anchor the full distance (' + JSON.stringify(dragged) + ')');
  await editor.keyboard.press('Escape');
  await editor.keyboard.press('Control+z');
  report(!(await state(editor)).anchors.neck, 'the drag is one undo step');
  // arm joint handles exist for a rigged arm
  await editor.keyboard.press('e');
  report(await editor.locator('#overlay .handle[data-key="armLElbow"]').count() === 1, 'arm joints have anchor handles');
  await editor.keyboard.press('Escape');

  // Real face tracking with a fake webcam.
  await editor.click('.tab[data-tab="play"]');
  await editor.click('#tgCam');
  await editor.waitForFunction(() => window.Anime25D.state().camLive, null, { timeout: 90000 })
    .then(() => report(true, 'face tracking detects a face from the (fake) webcam with the bundled MediaPipe'), () => report(false, 'face tracking detects a face from the (fake) webcam with the bundled MediaPipe'));
  await editor.waitForFunction(() => window.Anime25D.state().hands === 'on', null, { timeout: 90000 })
    .then(() => report(true, 'hand tracking (bundled MediaPipe Hands) starts next to face tracking'), async () => report(false, 'hand tracking starts: ' + (await state(editor)).hands));
  // the first hands inference stalls the camera loop briefly (warm-up); face tracking then continues
  await editor.waitForTimeout(2500);
  await editor.waitForFunction(() => window.Anime25D.state().camLive, null, { timeout: 20000 }).catch(() => {});
  const live = await state(editor);
  report(live.camLive && live.cam.arms && live.cam.arms.L.presence === 0 && live.cam.arms.R.presence === 0, 'face keeps tracking with hands on; no hands in the video means arms at rest ' + JSON.stringify({ live: live.camLive, arms: live.cam.arms, status: await editor.textContent('#appStatus'), chip: await editor.textContent('#tgCam'), auto: live.auto.cam }));
  const cam = (await state(editor)).cam;
  report(['ax', 'ay', 'az', 'eL', 'eR', 'mo', 'ex', 'ey', 'br', 'mf'].every(k => Number.isFinite(cam[k])) && cam.eL > 0.8, 'tracking values are finite and the eyes read as open');
  await editor.evaluate(() => document.getElementById('btnCalibrate').click());
  await editor.waitForFunction(() => { const s = window.Anime25D.state(); return s.calibrated && Math.abs(s.cam.ax) < 0.2 && Math.abs(s.cam.mf) < 0.3; }, null, { timeout: 15000 })
    .then(() => report(true, 'calibration makes the current face the neutral pose'), async () => report(false, 'calibration makes the current face the neutral pose ' + JSON.stringify((await state(editor)).cam) + ' / ' + await editor.textContent('#appStatus')));
  await editor.click('#tgCam');
  await editor.waitForFunction(() => !window.Anime25D.state().camLive, null, { timeout: 5000 })
    .then(() => report(true, 'turning the camera off returns to idle motion'), () => report(false, 'turning the camera off returns to idle motion'));
  report(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await context.close();
}

(async () => {
  const { proc, base } = await startServer();
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || undefined, args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + fixture,
    '--autoplay-policy=no-user-gesture-required'] });
  try {
    if (!process.argv.includes('--live-only')) await suite(browser, base);
    if (!process.argv.includes('--suite-only')) await editorLive(browser, base);
  } catch (err) {
    failures++; console.error(err);
  } finally {
    await browser.close();
    proc.kill();
  }
  console.log(failures ? failures + ' FAILED' : 'ALL BROWSER TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
