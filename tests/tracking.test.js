'use strict';
// Camera hands -> arm parameters (engine/tracking.js).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Core = require('../engine/core.js');
const TR = require('../engine/tracking.js');

const face = { cx: 0.66, cy: 0.3, w: 0.2, h: 0.24 };   // x already in aspect units (0..1.33)
const body = TR.bodyFromFace(face);
assert.ok(body.L.x < face.cx && body.R.x > face.cx && body.L.y > face.cy, 'shoulders below and beside the face');

// labels: on the raw (unmirrored) image MediaPipe's "Left" is the user's right hand = avatar L
let a = TR.assignHands([{ x: 0.3, y: 0.5, label: 'Left', score: 0.9 }, { x: 1.0, y: 0.5, label: 'Right', score: 0.9 }], face);
assert.ok(a.L.x === 0.3 && a.R.x === 1.0);
a = TR.assignHands([{ x: 1.0, y: 0.5, label: 'Left', score: 0.9 }, { x: 0.3, y: 0.5, label: 'Left', score: 0.8 }], face);
assert.ok(a.L.x === 0.3 && a.R.x === 1.0, 'conflicting labels fall back to image position');
a = TR.assignHands([{ x: 1.0, y: 0.5, score: 0.9 }], face);
assert.ok(!a.L && a.R, 'one unlabeled hand goes to the nearer side');

// a hand hanging straight down reads as rest; a raised hand as up
const tr = TR.createArmTracker({ fadeIn: 0.1, fadeOut: 0.3, hold: 0.1 });
let t = 0, rel;
const hang = { x: body.L.x, y: body.L.y + body.reach, label: 'Left', score: 1 };
for (let i = 0; i < 20; i++) rel = tr.update({ face, hands: [hang] }, t += 1 / 30);
assert.ok(Math.abs(rel.L.x) < 1e-6 && Math.abs(rel.L.y + 1) < 1e-6 && rel.L.presence === 1 && rel.R.presence === 0, JSON.stringify(rel));
const up = { x: body.L.x - body.reach * 0.2, y: body.L.y - body.reach * 0.7, label: 'Left', score: 1 };
for (let i = 0; i < 40; i++) rel = tr.update({ face, hands: [up] }, t += 1 / 30);
assert.ok(rel.L.y > 0.6 && rel.L.x > 0.15, 'raised outward: ' + JSON.stringify(rel.L));
// lost: holds briefly, then fades back to rest
rel = tr.update({ face, hands: [] }, t += 0.05);
assert.strictEqual(rel.L.presence, 1, 'a short dropout keeps the arm');
for (let i = 0; i < 30; i++) rel = tr.update({ face, hands: [] }, t += 1 / 30);
assert.strictEqual(rel.L.presence, 0, 'a lost hand fades out');
assert.deepStrictEqual(TR.armParams({ ARMS: {} }, rel), {});

// on a real rig: rest pose for a hanging hand, the IK target follows a raised hand
const file = path.join(__dirname, '..', 'sample2.psd');
if (fs.existsSync(file)) {
  const { rigFromPsd } = require('./helpers/sample-rig.js');
  const M = Core.createModel(rigFromPsd(file));
  const R = M.ARMS.L, reach = R.L1 + R.L2;
  const rest = { L: { x: (R.W.x - R.S.x) * R.out / reach, y: (R.S.y - R.W.y) / reach, presence: 1 } };
  const p0 = TR.armParams(M, rest);
  assert.ok(Math.abs(p0.armLX) < 1e-9 && Math.abs(p0.armLY) < 1e-9, 'the avatar rest wrist maps to zero');
  const p1 = TR.armParams(M, { L: { x: 0.2, y: 0.5, presence: 1 } });
  const ik = Core.solveArmIK(M, 'L', p1.armLX, p1.armLY);
  const want = { x: R.S.x + 0.2 * R.out * reach, y: R.S.y - 0.5 * reach };
  assert.ok(Math.hypot(ik.target.x - want.x, ik.target.y - want.y) < 1e-6, 'wrist target = shoulder + rel * reach');
  const half = TR.armParams(M, { L: { x: 0.2, y: 0.5, presence: 0.5 } });
  assert.ok(Math.abs(half.armLY - p1.armLY / 2) < 1e-9, 'presence blends toward rest');
  console.log('ok tracking: hands, presence, sample2 IK target');
} else console.log('ok tracking: hands, presence (no sample2.psd)');

const box = TR.faceBoxFromMesh(Array.from({ length: 478 }, (_, i) => ({ x: i === 454 ? 0.6 : i === 234 ? 0.4 : 0.5, y: i === 10 ? 0.2 : i === 152 ? 0.4 : 0.3 })), 1);
assert.ok(Math.abs(box.w - 0.2) < 1e-9 && Math.abs(box.h - 0.2) < 1e-9 && Math.abs(box.cy - 0.3) < 1e-9);
const w = TR.wristsFromHands({ multiHandLandmarks: [[{ x: 0.5, y: 0.6 }]], multiHandedness: [{ label: 'Right', score: 0.7 }] }, 2);
assert.deepStrictEqual(w, [{ x: 1, y: 0.6, label: 'Right', score: 0.7 }]);
