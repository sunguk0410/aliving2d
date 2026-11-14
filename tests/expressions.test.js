'use strict';
// reactions.json helpers used by the editor's 「표정·모션」 tab.
const assert = require('assert');
const Core = require('../engine/core.js');
const Anim = require('../engine/animator.js');
const X = require('../lib/expressions.js');
const D = require('../engine/reactions.default.json');

// the default file is already clean, and every name it refers to exists
const n = X.normalize(D, Core.RANGES);
assert.deepStrictEqual(JSON.parse(JSON.stringify(n.expressions)), D.expressions, 'default expressions survive normalize unchanged');
assert.deepStrictEqual(JSON.parse(JSON.stringify(n.motions)), D.motions, 'default motions survive normalize unchanged');
for (const list of Object.values(n.reactions)) for (const c of list) {
  if (c.motion) assert.ok(n.motions[c.motion], 'motion ' + c.motion);
  for (const k of ['expression', 'then']) if (c[k]) assert.ok(n.expressions[c[k]], 'expression ' + c[k]);
}
for (const [name, e] of Object.entries(n.expressions)) for (const k in e.params) assert.ok(k in Core.DEFAULTS, name + ': ' + k);
assert.deepStrictEqual(JSON.parse(X.stringify(n)), JSON.parse(JSON.stringify(n)), 'stringify is plain JSON');

// hostile / sloppy input is cleaned, not trusted
const bad = X.normalize({ expressions: { 'a b': { params: {} }, ok: { label: '<b>x</b>', params: { eyeSmile: 9, nope: 1, brow: 'x' } } },
  motions: { m: { mode: 'weird', duration: -5, tracks: { angleX: [[500, 9], [0, 0, 'bogus']], evil: [[0, 1]] } } },
  reactions: { lower: [{}], OK: [{ expression: 'ok', hold: 1e9, weight: -1 }] } }, Core.RANGES);
assert.deepStrictEqual(Object.keys(bad.expressions), ['neutral', 'ok'], 'neutral is always there; invalid names dropped');
assert.deepStrictEqual(bad.expressions.ok, { params: { eyeSmile: 1 }, label: 'bx/b' });
assert.strictEqual(bad.motions.m.mode, 'add');
assert.deepStrictEqual(bad.motions.m.tracks, { angleX: [[0, 0], [500, 2]] }, 'keys sorted, unknown ease dropped, add offsets limited to the range span');
assert.strictEqual(bad.motions.m.duration, 100);
assert.deepStrictEqual(Object.keys(bad.reactions), ['OK']);
assert.deepStrictEqual(bad.reactions.OK[0], { expression: 'ok', hold: 60000, weight: 0 });
assert.throws(() => X.normalize([], Core.RANGES));

// key poses <-> tracks
const nod = n.motions.nod, keys = X.motionKeys(nod);
assert.deepStrictEqual(keys.map(k => k.t), [0, 220, 300, 480, 900]);
const back = X.motionFromKeys(nod, keys, Core.DEFAULTS);
for (const p in nod.tracks) for (const [t, v] of nod.tracks[p]) assert.ok(Math.abs(Anim.sampleTrack(back.tracks[p], t) - v) < 1e-3, 'round trip keeps every key value');
const made = X.motionFromKeys({ mode: 'override', duration: 0 }, [{ t: 800, params: { angleX: 0.5 } }, { t: 0, params: { eyeOpenL: 0 } }], Core.DEFAULTS);
assert.deepStrictEqual(made.tracks, { eyeOpenL: [[0, 0], [800, 1]], angleX: [[0, 0], [800, 0.5]] }, 'override fills missing values with defaults');
assert.strictEqual(made.duration, 800);

assert.deepStrictEqual(X.poseParams(Object.assign({}, Core.DEFAULTS, { brow: 0.5, eyeSmile: 1e-5 }), Core.DEFAULTS, ['brow', 'eyeSmile', 'angleX']), { brow: 0.5 });
assert.strictEqual(X.freshName('custom', { custom1: 1, custom2: 1 }), 'custom3');
console.log('ok expressions: normalize, key poses, stringify');
