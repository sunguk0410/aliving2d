'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Core = require('../engine/core.js');
const { createAnimator, sampleTrack } = require('../engine/animator.js');

// --- sampleTrack ---
const keys = [[0, 0], [100, 1, 'linear'], [200, 0, 'linear']];
assert.strictEqual(sampleTrack(keys, -5), 0);
assert.strictEqual(sampleTrack(keys, 50), 0.5);
assert.strictEqual(sampleTrack(keys, 150), 0.5);
assert.strictEqual(sampleTrack(keys, 999), 0);

// --- a tiny synthetic rig so the test has no art dependency ---
function solid(name, x, y, w, h, extra) {
  return Object.assign({ name, x, y, w, h, z: 0, depth: 1, group: 'head', phys: null, fade: null, side: null, opacity: 1, strands: null }, extra || {});
}
const rig = {
  canvas: { w: 400, h: 400 },
  anchors: {
    face: { cx: 200, cy: 120, x0: 140, x1: 260, y0: 60, y1: 190 },
    eyeL: { x0: 160, x1: 190, y0: 110, y1: 125, icx: 175, icy: 118, closeY: 120 },
    eyeR: { x0: 210, x1: 240, y0: 110, y1: 125, icx: 225, icy: 118, closeY: 120 },
    mouth: { x0: 185, x1: 215, y0: 160, y1: 170, cx: 200, cy: 165 },
    neckPivot: { cx: 200, cy: 230 }, neckTop: 190, neckBottom: 240, bodyPivot: { cx: 200, cy: 400 },
    faceScale: 0.36, hairRootY: 120
  },
  layers: [
    solid('face', 140, 60, 120, 130, { z: 0 }),
    solid('mouth_close', 185, 160, 30, 10, { z: 1, fade: 'mouthClose' }),
    solid('sweat', 250, 80, 20, 30, { z: 2 })
  ]
};
const R = JSON.parse(fs.readFileSync(path.join(__dirname, '../engine/reactions.default.json'), 'utf8'));
R.toggles = ['sweat'];
R.motions.sweatDrop = { duration: 1000, tracks: {}, events: [{ t: 100, layer: 'sweat', value: 1 }, { t: 800, layer: 'sweat', value: 0 }] };

let s = 1;
const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
const model = Core.createModel(rig);
const an = createAnimator(model, R, { random: rand, auto: { rand: false, blink: false } });
const run = ms => { for (let t = 0; t < ms; t += 1000 / 60) an.update(1 / 60); };

// intensity picks the matching candidate
let c = an.react('GAZE_AWAY', 3);
assert.strictEqual(c.motion, 'lookDownSulk');
assert.strictEqual(an.state.expression, 'pout');
assert.deepStrictEqual(an.state.motions, ['lookDownSulk']);
run(300);
assert.ok(an.params.mouthCForm < -0.5, 'pout bends the closed mouth down');

// expression holds, then returns to the base expression
run(2600);
assert.strictEqual(an.state.expression, 'neutral');
assert.deepStrictEqual(an.state.motions, []);

// unknown intensity falls back to the nearest lower one
c = an.react('AWAY', 9);
assert.strictEqual(c.intensity, 3);
run(3000);

// "then" chains a follow-up expression (RETURN lv3: pout -> softSmile)
an.react('RETURN', 3);
assert.strictEqual(an.state.expression, 'pout');
run(2500);
assert.strictEqual(an.state.expression, 'softSmile');
run(1600);
assert.strictEqual(an.state.expression, 'neutral');

// triggers without intensity ignore it; unknown triggers return null
assert.ok(an.react('GREETING', 2));
assert.strictEqual(an.react('NOPE'), null);
run(2000);

// talk opens the mouth for a while, then stops
an.talk(1000);
let maxOpen = 0;
for (let t = 0; t < 1000; t += 1000 / 60) maxOpen = Math.max(maxOpen, an.update(1 / 60).mouthOpen);
assert.ok(maxOpen > 0.2, 'mouth moved while talking');
run(1200);
assert.ok(an.params.mouthOpen < 0.05, 'mouth closes after talking');

// toggle layers fade in via motion events, and out again
const sweat = model.layers.find(L => L.name === 'sweat');
assert.strictEqual(an.extraAlpha(sweat), 0);
an.play('sweatDrop');
run(500);
assert.ok(an.extraAlpha(sweat) > 0.9, 'sweat shown');
run(900);
assert.ok(an.extraAlpha(sweat) < 0.1, 'sweat hidden');
assert.strictEqual(an.extraAlpha(model.layers[0]), 1, 'normal layers unaffected');

// setExpression with unknown name is rejected
assert.strictEqual(an.setExpression('doesNotExist'), false);

// every reaction in the default file points at existing motions / expressions
for (const [trig, list] of Object.entries(R.reactions)) for (const x of list) {
  if (x.motion) assert.ok(R.motions[x.motion], trig + ' -> missing motion ' + x.motion);
  if (x.expression) assert.ok(R.expressions[x.expression], trig + ' -> missing expression ' + x.expression);
  if (x.then) assert.ok(R.expressions[x.then], trig + ' -> missing then ' + x.then);
}
for (const [name, x] of Object.entries(R.expressions)) for (const k in x.params) assert.ok(k in Core.DEFAULTS, name + ': unknown param ' + k);
for (const [name, m] of Object.entries(R.motions)) for (const k in m.tracks) assert.ok(k in Core.DEFAULTS, name + ': unknown track ' + k);

console.log('ok animator');
