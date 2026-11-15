'use strict';
/**
 * Runs the ORIGINAL fadeAlpha / deform / updateSprings (frozen in
 * tests/fixtures/upstream-deform.js) next to engine/core.js and checks that
 * every vertex matches over a few hundred random frames with physics running.
 * Engine extensions (Core.EXTENSIONS) stay at their defaults, so a new feature
 * must not change the original look when it is switched off.
 *
 *   node tests/equivalence.test.js [sample.psd ...]
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const RT = require('../lib/runtime.js');
const Core = require('../engine/core.js');
const { rigFromPsd } = require('./helpers/sample-rig.js');

const upstreamCode = fs.readFileSync(path.join(__dirname, 'fixtures/upstream-deform.js'), 'utf8');
const psdFiles = process.argv.slice(2).length ? process.argv.slice(2)
  : ['sample.psd', 'sample2.psd'].map(f => path.join(__dirname, '..', f));

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

for (const file of psdFiles) {
  const rig = rigFromPsd(file);
  const mine = Core.createModel(rig);
  const ref = Core.createModel(rig);   // same mesh prep; its state is driven by upstream code
  const ctx = {
    Math, RT, auto: { phys: true }, layers: ref.layers, blinkVariant: 1,
    A: ref.A, FS: ref.FS, NP: ref.NP, BP: ref.BP, FC: ref.FC, CHEST: ref.CHEST, bounce: ref.bounce,
    clamp: Core.clamp, smooth: Core.smooth
  };
  vm.createContext(ctx);
  vm.runInContext(upstreamCode + '\nthis.__f={fadeAlpha,deform,updateSprings};', ctx);
  const up = ctx.__f;

  let maxErr = 0, alphaErr = 0, frames = 0;
  let t = 0;
  for (let f = 0; f < 300; f++) {
    const e = Object.assign({}, Core.DEFAULTS);
    for (const k in Core.RANGES) {
      if (rnd() < 0.6 || Core.EXTENSIONS.includes(k)) continue;
      const [lo, hi] = Core.RANGES[k]; e[k] = lo + (hi - lo) * rnd();
    }
    e.breath = rnd(); e.breathHead = rnd(); e.irisBounceX = 0.9 + 0.2 * rnd(); e.irisBounceY = 0.9 + 0.2 * rnd();
    const dt = 0.005 + 0.04 * rnd(); t += dt;
    const variant = rnd() < 0.3 ? 2 : 1;
    mine.blinkVariant = variant; ctx.blinkVariant = variant;
    Core.updateSprings(mine, e, t, dt, true);
    up.updateSprings(e, t, dt, true);
    const alt = { L: rnd() < 0.5, R: rnd() < 0.5 };
    for (let i = 0; i < mine.layers.length; i++) {
      const a = mine.layers[i], b = ref.layers[i];
      if (a.fade === 'fx' || a.fade === 'eyeLid' || a.fade === 'mouthRig') continue;   // capsule-only layers (effects, skin eyelids, rigged mouth): hidden at defaults; upstream has none
      Core.deform(mine, a, e); up.deform(b, e);
      for (let k = 0; k < a.cur.length; k++) maxErr = Math.max(maxErr, Math.abs(a.cur[k] - b.cur[k]));
      alphaErr = Math.max(alphaErr, Math.abs(Core.fadeAlpha(mine, a, e, alt) - up.fadeAlpha(b, e, alt)));
    }
    frames++;
  }
  assert.strictEqual(maxErr, 0, path.basename(file) + ': vertex mismatch ' + maxErr);
  assert.strictEqual(alphaErr, 0, path.basename(file) + ': alpha mismatch ' + alphaErr);
  console.log('ok equivalence ' + path.basename(file) + ': ' + mine.layers.length + ' layers x ' + frames + ' frames, identical');
}
