'use strict';
/**
 * Start screen: picture -> see-through (fake server found automatically, no code) -> PSD -> rigged model.
 * Starts its own editor server (serve.py --no-seethrough --seethrough-port) and a fake conversion
 * server, so it does not need npm start. Needs playwright and sample2.psd.
 *   CHROME_CHANNEL=chrome npm run test:seethrough
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PSD = path.join(ROOT, 'sample2.psd');
const PY = process.env.PYTHON || 'python';
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); s.on('error', rej); });
async function waitUrl(url) {
  for (let i = 0; i < 150; i++) { try { if ((await fetch(url)).ok) return; } catch (err) {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('not up: ' + url);
}

(async () => {
  if (!fs.existsSync(PSD)) { console.log('skip: no sample2.psd'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'st-smoke-'));
  const [EP, SP] = [await freePort(), await freePort()];
  const editorUrl = `http://127.0.0.1:${EP}/`;
  const fake = spawn(PY, [path.join(ROOT, 'seethrough/server.py'), '--mode', 'fake', '--fake-psd', PSD, '--fake-seconds', '1.5', '--port', String(SP),
    '--token', '', '--allow-origin', `http://127.0.0.1:${EP}`, '--workdir', work], { stdio: 'ignore' });
  const editor = spawn(PY, [path.join(ROOT, 'serve.py'), '--port', String(EP), '--no-seethrough', '--seethrough-port', String(SP)], { cwd: ROOT, stdio: 'ignore' });
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || undefined });
  try {
    await waitUrl(`http://127.0.0.1:${SP}/health`);
    await waitUrl(editorUrl);
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(editorUrl);
    await page.waitForFunction(() => document.getElementById('upload').dataset.mode === 'ready', null, { timeout: 10000 });
    assert.ok(await page.isVisible('#btnImage'), 'the upload button is the main action');
    assert.match(await page.textContent('#stLocal'), /GPU/);
    assert.strictEqual(await page.$('#stCode'), null, 'no connection code field any more');

    const png = path.join(work, 'character.png');
    fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    await page.setInputFiles('#fileInput', png);
    await page.waitForSelector('#stJob:not([hidden])');
    assert.ok(await page.evaluate(() => document.getElementById('stPicOrig').src.startsWith('blob:')), 'the uploaded picture is previewed');
    await page.waitForFunction(() => document.querySelector('#stSteps li.now, #stSteps li.done'), null, { timeout: 10000 });
    await page.waitForFunction(() => window.Anime25D.state().layers > 0, null, { timeout: 60000 });
    const st = await page.evaluate(() => window.Anime25D.state());
    assert.strictEqual(st.modelName, 'character.psd');
    assert.ok(st.layers >= 14, 'rigged layers: ' + st.layers);
    assert.ok(await page.evaluate(() => !document.body.classList.contains('welcome') && document.getElementById('stJob').hidden), 'the editor opens on the model');
    assert.strictEqual(await page.evaluate(() => !!document.getElementById('btnSaveConverted').hidden), false, 'PSD can be saved');

    // 「AI로 자세 바로잡기」 with a mocked OpenAI (no key, no cost): redraw -> choose -> convert
    await page.route('**/local-config.json', async route => { const r = await route.fetch(); const j = await r.json(); j.redraw = { ready: true, hint: '…test' }; route.fulfill({ json: j }); });
    let redraws = 0;
    await page.route('**/api/redraw', route => { redraws++; route.fulfill({ status: 200, contentType: 'image/png', body: fs.readFileSync(png) }); });
    await page.click('#btnOpen');
    await page.check('#optRedraw');
    await page.waitForFunction(() => !document.getElementById('keySaved').hidden);
    await page.setInputFiles('#fileInput', png);
    await page.waitForSelector('#stSteps li[data-phase="redraw"]:not([hidden])');
    assert.ok(await page.isVisible('#stSteps li[data-phase="redraw"]'), 'the redraw step is listed');
    await page.waitForFunction(() => window.Anime25D.state().modelName === 'character_redrawn.psd', null, { timeout: 60000 });
    assert.strictEqual(redraws, 1, 'redrawn once and carried on without asking');

    // 「새 캐릭터」 -> upload again -> cancel; ✕ goes back to the model
    await page.click('#btnOpen');
    await page.uncheck('#optRedraw');
    assert.ok(await page.isVisible('#dropClose'));
    await page.setInputFiles('#fileInput', png);
    await page.waitForSelector('#stJob:not([hidden])');
    await page.click('#stCancel');   // first click only arms it
    await page.click('#stCancel');
    await page.waitForFunction(() => /중지/.test(document.getElementById('dropStatus').textContent), null, { timeout: 10000 });
    await page.click('#dropClose');
    assert.ok(await page.evaluate(() => document.getElementById('drop').classList.contains('hidden')));

    assert.deepStrictEqual(errors, []);
    console.log('ok see-through smoke: picture -> auto-found server -> ' + st.layers + ' layers, preview, AI redraw without questions, cancel');
  } finally {
    await browser.close();
    fake.kill(); editor.kill();
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch(err => { console.error(err); process.exit(1); });
