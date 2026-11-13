'use strict';
/**
 * Loads demo/index.html in headless Chrome, sends reactions and checks there are
 * no page errors and the canvases are not blank.
 *   npm run serve   (in another terminal)
 *   PLAYWRIGHT=/path/to/playwright CHROME=/usr/bin/google-chrome npm run test:browser
 */
const assert = require('assert');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const URL = process.env.DEMO_URL || 'http://localhost:8000/engine/demo/index.html';

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    channel: process.env.CHROME ? undefined : (process.env.CHROME_CHANNEL || undefined),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
  page.on('requestfailed', r => errors.push('request failed: ' + r.url()));
  await page.goto(URL);
  const wanted = (new globalThis.URL(URL).searchParams.get('bundles') || '').split(',').filter(Boolean).slice(0, 3);
  const count = wanted.length || 3;
  await page.waitForFunction(n => window.__players && window.__players.length === n, count, { timeout: 30000 });
  if (wanted.length) {
    const names = await page.$$eval('.slot .name', els => els.map(e => e.textContent));
    assert.deepStrictEqual(names, wanted, 'demo must load the bundles from ?bundles=');
  }
  const triggers = ['GREETING', 'FOCUS_START', 'GAZE_AWAY', 'AWAY', 'RETURN', 'LONG_FOCUS', 'IDLE'];
  for (const t of triggers) for (const i of [1, 2, 3]) {
    const ok = await page.evaluate(([t, i]) => window.__players.every(p => !!p.react(t, i)), [t, i]);
    assert.ok(ok, t + ' ' + i);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(800);
  // draw a frame and read it back in the same task (the buffer is cleared after compositing)
  const painted = await page.evaluate(() => window.__players.map(p => {
    p.step(0); const g = p.gl, w = g.drawingBufferWidth, h = g.drawingBufferHeight;
    const px = new Uint8Array(4 * w * h); g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
    let n = 0; for (let k = 3; k < px.length; k += 4) if (px[k] > 0) n++; return n / (w * h);
  }));
  console.log('covered area per canvas:', painted.map(x => (x * 100).toFixed(1) + '%').join(', '));
  painted.forEach((x, i) => assert.ok(x > 0.15, 'canvas ' + i + ' looks blank'));
  assert.deepStrictEqual(errors, [], errors.join('\n'));
  console.log('ok browser smoke: ' + count + ' players, ' + triggers.length * 3 + ' reactions, no errors');
  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
