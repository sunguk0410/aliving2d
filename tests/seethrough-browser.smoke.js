'use strict';
/**
 * Editor start screen: image -> see-through (fake server) -> PSD -> rigged model.
 * Needs `npm start` running (EDITOR_URL, default http://127.0.0.1:8000/) and playwright.
 *   CHROME_CHANNEL=chrome npm run test:seethrough
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const EDITOR = process.env.EDITOR_URL || 'http://127.0.0.1:8000/';
const PSD = path.join(ROOT, 'sample2.psd');
const PORT = 7900 + Math.floor(Math.random() * 90);
const TOKEN = 'smoke' + Date.now().toString(36);

(async () => {
  if (!fs.existsSync(PSD)) { console.log('skip: sample2.psd がありません'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'st-smoke-'));
  const server = spawn(process.env.PYTHON || 'python', [path.join(ROOT, 'seethrough/server.py'), '--mode', 'fake', '--fake-psd', PSD,
    '--fake-seconds', '1.5', '--port', String(PORT), '--token', TOKEN, '--workdir', work], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (/연결 코드|see-through/.test(String(d))) resolve(); });
    server.on('exit', c => reject(new Error('server exited ' + c)));
    setTimeout(() => reject(new Error('server did not start')), 15000);
  });
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || undefined });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(EDITOR);
    // a PNG made from a PSD-free 1x1 image is enough: the fake server ignores it
    const png = path.join(work, 'character.png');
    fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

    // no connection code -> explains the Colab notebook flow, does not upload
    assert.strictEqual(await page.isVisible('#btnImage'), false, 'image button only with a server');
    await page.setInputFiles('#fileInput', png);
    await page.waitForFunction(() => /Colab/.test(document.getElementById('dropStatus').textContent));
    assert.strictEqual(await page.isVisible('#stJob'), false);
    await page.click('#stAuto summary');

    await page.fill('#stCode', `http://127.0.0.1:${PORT}#${TOKEN}`);
    await page.dispatchEvent('#stCode', 'change');
    await page.waitForFunction(() => document.getElementById('stState').dataset.state === 'ok', null, { timeout: 10000 });
    assert.match(await page.textContent('#stState'), /fake/);
    assert.strictEqual(await page.isVisible('#btnImage'), true, 'image button once connected');

    await page.setInputFiles('#fileInput', png);
    await page.waitForSelector('#stJob:not([hidden])');
    await page.waitForFunction(() => window.Anime25D.state().layers > 0, null, { timeout: 60000 });
    const st = await page.evaluate(() => window.Anime25D.state());
    assert.strictEqual(st.modelName, 'character.psd');
    assert.ok(st.layers >= 14, 'rigged layers: ' + st.layers);
    assert.strictEqual(await page.evaluate(() => !!document.getElementById('btnSaveConverted').hidden), false, 'PSD can be saved');
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('capsule.seeThrough')), `http://127.0.0.1:${PORT}#${TOKEN}`, 'code remembered');

    // cancel
    await page.evaluate(() => document.getElementById('drop').classList.remove('hidden'));
    await page.setInputFiles('#fileInput', png);
    await page.waitForSelector('#stJob:not([hidden])');
    await page.click('#stCancel');
    await page.waitForFunction(() => /중지/.test(document.getElementById('dropStatus').textContent), null, { timeout: 10000 });

    assert.deepStrictEqual(errors, []);
    console.log('ok see-through smoke: image -> fake server -> ' + st.layers + ' layers, cancel, remembered code');
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch(err => { console.error(err); process.exit(1); });
