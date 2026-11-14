'use strict';
/**
 * Arm rig: rigger split + anchors, FK sign conventions, two-bone IK.
 *   node tests/arms.test.js [sample2.psd]
 * Needs a PSD whose handwear layer holds only the arms (sample2.psd).
 * sample.psd puts the whole torso in handwear: the arms are carved out of it.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Core = require('../engine/core.js');
const Rigger = require('../lib/rigger.js');
const { rigFromPsd } = require('./helpers/sample-rig.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, msg + ': ' + a + ' vs ' + b);
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

// ---------- synthetic: two hanging arms, no PSD needed ----------
{
  const W = 400, H = 400, alpha = new Uint8Array(W * H);
  const FACE = { cx: 200, cy: 80, x0: 160, x1: 240, y0: 40, y1: 120 };
  for (let y = 150; y < 380; y++) for (let x = 0; x < W; x++) if ((x > 100 && x < 130) || (x > 270 && x < 300)) alpha[y * W + x] = 255;
  const m = Rigger._internals.splitArms(alpha, W, H, FACE);
  assert.ok(m.l && m.r && !m.torso, 'two separate arms split into l / r');
  const torso = new Uint8Array(W * H);
  for (let y = 150; y < 380; y++) for (let x = 100; x < 300; x++) torso[y * W + x] = 255;
  assert.ok(Rigger._internals.splitArms(torso, W, H, FACE).torso, 'a torso-like layer is refused');
  const la = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) la[i] = m.l[i] ? alpha[i] : 0;
  const arm = Rigger._internals.detectArm(la, W, H, FACE, { cx: 200, cy: 130 });
  assert.ok(arm.shoulder.y < arm.elbow.y && arm.elbow.y < arm.wrist.y, 'shoulder above elbow above wrist');
  near(arm.shoulder.x, 115, 3, 'shoulder on the arm axis');
  assert.strictEqual(arm.cut, false);
  assert.strictEqual(arm.elbowBy, 'ratio');
  console.log('ok synthetic split + anchors');
}

const file = process.argv[2] || path.join(__dirname, '..', 'sample2.psd');
if (!fs.existsSync(file)) { console.log('skip arms PSD checks (no ' + path.basename(file) + ')'); process.exit(0); }

const rig = rigFromPsd(file);
const arms = rig.layers.filter(L => /^handwear/.test(L.name));
assert.deepStrictEqual(arms.map(L => L.side).sort(), ['L', 'R'], 'handwear split into L / R');
for (const s of ['L', 'R']) {
  const a = rig.anchors['arm' + s];
  assert.ok(a, 'anchors.arm' + s);
  assert.ok(a.shoulder.y < a.elbow.y, s + ' shoulder above elbow');
  const L = arms.find(x => x.side === s);
  assert.ok(a.shoulder.x > L.x && a.shoulder.x < L.x + L.w, s + ' shoulder inside the arm part');
}
assert.ok(rig.anchors.armL.shoulder.x < rig.anchors.face.cx && rig.anchors.armR.shoulder.x > rig.anchors.face.cx, 'L is image-left');

const M = Core.createModel(rig);
const pose = (p) => Object.assign({}, Core.DEFAULTS, p);

// rest: no arm pose, vertices untouched by the arm code
assert.strictEqual(Core.armPose(M, 'L', pose({})), null);

// FK: shoulder + raises the arm outward on both sides
for (const s of ['L', 'R']) {
  const R = M.ARMS[s];
  const P = Core.armPose(M, s, pose({ ['arm' + s + 'Shoulder']: 90 }));
  near(dist(P.E2, R.S), R.L1, 1e-6, 'upper arm keeps its length');
  assert.ok(P.E2.y < R.E.y - R.L1 * 0.7, s + ' elbow raised');
  assert.ok((P.E2.x - R.S.x) * R.out > R.L1 * 0.7, s + ' elbow goes outward');
  // elbow + bends the forearm toward the body midline
  const Q = Core.armPose(M, s, pose({ ['arm' + s + 'Elbow']: 90 }));
  assert.ok((Q.W2.x - R.E.x) * R.out < -R.L2 * 0.7, s + ' forearm turns inward');
}

// IK: targets from body landmarks; the hand always lands on reachable targets,
// bones never get longer than at rest, the elbow goes where people put it
const fw = M.A.face.x1 - M.A.face.x0, fh = M.A.face.y1 - M.A.face.y0;
function aim(R, x, y) { const reach = R.L1 + R.L2; return [(x - R.W.x) / (reach * R.out), (R.W.y - y) / reach]; }
for (const s of ['L', 'R']) {
  const R = M.ARMS[s], inward = -R.out;
  const cases = [
    { name: 'hand to chest', pt: [M.CHEST.cx + inward * fw * 0.1, M.CHEST.cy], check: P => P.E2.y > R.S.y + R.L1 * 0.3 },   // elbow stays low
    { name: 'hand to cheek', pt: [M.A.face.cx - inward * fw * 0.28, M.A.face.cy + fh * 0.18], check: P => P.E2.y > R.S.y && P.k1 < 0.9 },   // upper arm toward the camera
    { name: 'hand on head', pt: [M.A.face.cx - inward * fw * 0.1, M.A.face.y0], check: P => (P.E2.x - R.S.x) * R.out > 0 },   // elbow out
    { name: 'arm out', pt: [R.S.x + R.out * (R.L1 + R.L2) * 0.95, R.S.y], check: P => P.k1 > 0.9 && P.k2 > 0.9 },
    { name: 'wave', pt: [R.S.x + R.out * R.L1 * 0.9, R.S.y - R.L2 * 0.8], check: P => (P.E2.x - R.S.x) * R.out > R.L1 * 0.5 }
  ];
  for (const c of cases) {
    const [tx, ty] = aim(R, c.pt[0], c.pt[1]);
    const P = Core.armPose(M, s, pose({ ['arm' + s + 'X']: tx, ['arm' + s + 'Y']: ty }));
    near(dist(P.W2, P.target), 0, 0.5, s + ' ' + c.name + ' reaches target');
    assert.ok(P.k1 <= 1 + 1e-9 && P.k2 <= 1 + 1e-9 && P.k1 > 0.1 && P.k2 > 0.1, s + ' ' + c.name + ' foreshortening only (' + P.k1.toFixed(2) + ', ' + P.k2.toFixed(2) + ')');
    assert.ok(c.check(P), s + ' ' + c.name + ' natural elbow (elbow ' + Math.round(P.E2.x) + ',' + Math.round(P.E2.y) + ' k1 ' + P.k1.toFixed(2) + ')');
  }
  // a tiny IK offset leaves the arm at rest (no jump when tracking starts)
  const P0 = Core.armPose(M, s, pose({ ['arm' + s + 'X']: 1e-4 }));
  near(dist(P0.E2, R.E), 0, 1, s + ' IK starts from the rest pose');
}

// IK continuity: sweeping the target anywhere (also past the shoulder) never jumps the elbow
for (const s of ['L', 'R']) {
  const R = M.ARMS[s];
  let prev = null, worst = 0;
  for (let i = 0; i <= 600; i++) {
    const a = i / 600 * Math.PI * 2;
    const e = pose({ ['arm' + s + 'X']: 0.5 * Math.cos(a) - 0.1, ['arm' + s + 'Y']: 0.7 + 0.6 * Math.sin(a) });
    const P = Core.armPose(M, s, e);
    if (dist(P.target, R.S) < R.L1 + R.L2 - 1) near(dist(P.W2, P.target), 0, 0.5, s + ' hand stays on target during the sweep');
    if (prev) worst = Math.max(worst, dist(P.E2, prev));
    prev = P.E2;
  }
  assert.ok(worst < R.L1 * 0.05, s + ' elbow moves smoothly (max step ' + worst.toFixed(1) + ')');
}

// deform: forearm vertices follow the elbow turn, upper-arm vertices near the shoulder only the shoulder turn
{
  const L = M.layers.find(x => x.bn === 'handwear' && x.side === 'L');
  const e = pose({ armLElbow: 90, breath: 0, breathHead: 0 });
  Core.deform(M, L, e);
  let moved = 0, still = 0;
  for (let v = 0; v < L.aw.length; v++) {
    const d = Math.hypot(L.cur[v * 2] - L.base[v * 2], L.cur[v * 2 + 1] - L.base[v * 2 + 1]);
    if (L.aw[v] > 0.99 && d > 5) moved++;
    if (L.aw[v] < 0.01 && L.base[v * 2 + 1] < M.ARMS.L.E.y - M.ARMS.L.L1 * 0.5 && d < 4) still++;
  }
  assert.ok(moved > 10 && still > 5, 'elbow bend moves the forearm only (' + moved + ' / ' + still + ')');
}

// front: the forearm is drawn again on top when the hand comes in front of the body
{
  const rest = pose({ breath: 0, breathHead: 0 });
  assert.strictEqual(Core.armFront(M, 'R', rest), 0, 'rest arm stays behind');
  assert.ok(!Core.buildFrame(M, rest).items.some(it => it.front), 'no front item at rest');
  const R = M.ARMS.R, reach = R.L1 + R.L2;
  const chest = pose({ breath: 0, breathHead: 0, armRX: (M.CHEST.cx - R.W.x) / (reach * R.out), armRY: (R.W.y - M.CHEST.cy) / reach });
  near(Core.armFront(M, 'R', chest), 1, 1e-6, 'hand on the chest is in front');
  assert.strictEqual(Core.armFront(M, 'L', chest), 0, 'the other arm stays behind');
  const out = pose({ armRShoulder: 85 });
  assert.strictEqual(Core.armFront(M, 'R', out), 0, 'arm out to the side stays behind');
  const fr = Core.buildFrame(M, chest);
  const last = fr.items[fr.items.length - 1];
  assert.ok(last.front && last.L.side === 'R' && last.valpha === last.L.aw, 'front forearm drawn last with per-vertex alpha');
  assert.strictEqual(fr.items.filter(it => it.front).length, 1);
}

// anchor offsets move the joints
{
  const M2 = Core.createModel(rig, { anchorOffsets: { armLElbow: { dx: 5, dy: -20 } } });
  near(M2.ARMS.L.E.y, M.ARMS.L.E.y - 20, 1e-9, 'elbow offset applied');
}

// sample.psd: torso inside handwear -> arms are cut out, the rest becomes the upper body
const s1 = path.join(__dirname, '..', 'sample.psd');
if (fs.existsSync(s1) && !process.argv[2]) {
  const r1 = rigFromPsd(s1);
  assert.ok(r1.anchors.armL && r1.anchors.armR, 'arm anchors after carving');
  const carved = r1.layers.filter(L => L.carved);
  assert.deepStrictEqual(carved.map(L => L.name).sort(), ['handwear_l', 'handwear_r', 'topwear'], 'torso + two arms');
  const names = r1.layers.map(L => L.name);
  assert.ok(names.indexOf('topwear') < names.indexOf('handwear_l'), 'arms are drawn over the torso');
  for (const s of ['L', 'R']) {
    const a = r1.anchors['arm' + s], w = r1.anchors.face.x1 - r1.anchors.face.x0;
    assert.ok(a.width > w * 0.15 && a.width < w * 0.55, s + ' carved arm width is arm-like: ' + a.width);
  }
}
// synthetic: a torso with darker sleeves separated by a painted line
{
  const W = 400, H = 400, FACE = { cx: 200, cy: 80, x0: 160, x1: 240, y0: 40, y1: 120 };
  const data = new Uint8ClampedArray(W * H * 4), alpha = new Uint8Array(W * H);
  for (let y = 140; y < 390; y++) for (let x = 90; x < 310; x++) {
    const k = y * W + x, sleeve = x < 120 || x >= 280, line = x === 120 || x === 121 || x === 278 || x === 279;
    const v = line ? 20 : sleeve ? 90 : 140; data.set([v, v, v, 255], k * 4); alpha[k] = 255;
  }
  const cv = Rigger._internals.carveArms({ name: 'handwear', left: 0, top: 0, imageData: { width: W, height: H, data } }, alpha, W, H, FACE);
  assert.ok(cv, 'carves a torso-mixed layer');
  let edge = -1; for (let x = 0; x < W; x++) if (cv.l[300 * W + x]) edge = x;
  assert.ok(edge >= 118 && edge <= 122, 'the cut follows the painted line (' + edge + ')');
  assert.ok(cv.torsoAlpha[300 * W + 112] > 0 && cv.torsoAlpha[300 * W + 95] === 0, 'the torso is filled a little behind the arm, not all the way');
  const flat = new Uint8Array(W * H); for (let y = 140; y < 390; y++) for (let x = 170; x < 230; x++) flat[y * W + x] = 255;
  assert.strictEqual(Rigger._internals.carveArms({ left: 0, top: 0, imageData: { width: W, height: H, data } }, flat, W, H, FACE), null, 'a narrow layer is not a torso');
}
console.log('ok arms ' + path.basename(file) + ': split, anchors, FK, IK, continuity, deform');
