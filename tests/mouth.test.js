'use strict';
/**
 * Rigged mouth: Rigger splits the see-through mouth into cavity / teeth / tongue / lip lines,
 * the engine opens them continuously (mouthRig 1) and hides the drawn mouths.
 *   node tests/mouth.test.js [sample2.psd]
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Core = require('../engine/core.js');
const Rigger = require('../lib/rigger.js');

function layer(name, left, top, width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const c = paint(x, y); if (!c) continue;
    data.set(c, (y * width + x) * 4);
  }
  return { name, left, top, imageData: { width, height, data } };
}
const skin = () => [250, 220, 205, 255];
const face = () => layer('face', 80, 30, 140, 160, skin);
// a slightly smiling closed mouth line, 3 px thick
const line = () => layer('mouth', 130, 140, 40, 12, (x, y) => {
  const q = (x - 20) / 20, yc = 3 + 3 * (1 - q * q);   // middle lower than the corners: ∪
  return Math.abs(y - yc) <= 1.5 ? [120, 50, 50, 255] : null;
});
// an open mouth: dark outline around a red cavity
const open = () => layer('mouth', 130, 135, 40, 26, (x, y) => {
  const k = Math.hypot((x - 20) / 19, (y - 13) / 12);
  return k > 1 ? null : k > 0.85 ? [60, 20, 25, 255] : [170, 60, 70, 255];
});
const pose = (p) => Object.assign({}, Core.DEFAULTS, { breath: 0, breathHead: 0, mouthRig: 1 }, p || {});
const byName = (M, n) => M.layers.find(L => L.name === n);
const centre = (L) => { let sy = 0; for (let k = 1; k < L.cur.length; k += 2) sy += L.cur[k]; return sy / (L.cur.length / 2); };

// ---------- closed line ----------
{
  const rig = Rigger.buildRig({ width: 300, height: 300, children: [face(), line()] });
  const names = rig.layers.map(L => L.name);
  for (const n of ['mouth_inner', 'mouth_teeth', 'mouth_tongue', 'mouth_lip_lower', 'mouth_lip_upper']) assert.ok(names.includes(n), n + ' synthesized');
  const MR = rig.anchors.mouthRig;
  assert.strictEqual(MR.mode, 'line');
  assert.ok(Math.abs(MR.cx - 150) < 1.5 && MR.hw > 15 && MR.hw < 25, 'mouth centre / half width from the line');
  assert.ok(MR.s < 0, 'a smiling line (corners up) fits a negative curvature');
  assert.ok(MR.D > 5, 'open height');
  // painter order: cavity under teeth / tongue, lip lines on top
  assert.ok(names.indexOf('mouth_inner') < names.indexOf('mouth_teeth') && names.indexOf('mouth_tongue') < names.indexOf('mouth_lip_upper'));
  assert.ok(rig.layers.filter(L => L.fade === 'mouthRig').every(L => L.img && L.img.width > 0));

  const M = Core.createModel(rig);
  assert.ok(M.hasMouthRig);
  const closed = pose(), wide = pose({ mouthOpen: 1 });
  // drawn mouth hidden with the rig on, back with it off; rig parts the other way round
  const drawn = M.layers.find(L => L.fade === 'mouthOpen');
  assert.strictEqual(Core.fadeAlpha(M, drawn, closed, {}), 0);
  assert.strictEqual(Core.fadeAlpha(M, drawn, pose({ mouthRig: 0, mouthOpen: 1 }), {}), 1);
  assert.strictEqual(Core.fadeAlpha(M, byName(M, 'mouth_lip_upper'), pose({ mouthRig: 0 }), {}), 0);
  assert.strictEqual(Core.fadeAlpha(M, byName(M, 'mouth_lip_upper'), closed, {}), 1);
  assert.strictEqual(Core.fadeAlpha(M, byName(M, 'mouth_inner'), closed, {}), 0, 'closed: no cavity');
  assert.strictEqual(Core.fadeAlpha(M, byName(M, 'mouth_lip_lower'), closed, {}), 0, 'closed: one line');
  assert.strictEqual(Core.fadeAlpha(M, byName(M, 'mouth_inner'), wide, {}), 1);
  assert.strictEqual(Core.fadeAlpha(M, byName(M, 'mouth_lip_lower'), wide, {}), 1);

  // closed: the character's own line stays exactly where it was drawn
  const up = byName(M, 'mouth_lip_upper');
  Core.deform(M, up, closed);
  for (let k = 0; k < up.cur.length; k++) assert.ok(Math.abs(up.cur[k] - up.base[k]) < 1e-9, 'upper lip unmoved when closed');
  // open: the lower lip / tongue drop by about the open height, the teeth stay with the upper lip
  const drop = (n) => { const L = byName(M, n); Core.deform(M, L, closed); const a = centre(L); Core.deform(M, L, wide); return centre(L) - a; };
  assert.ok(drop('mouth_lip_lower') > MR.D * 0.7, 'lower lip drops: ' + drop('mouth_lip_lower'));
  assert.ok(drop('mouth_tongue') > MR.D * 0.5, 'tongue drops');
  assert.ok(Math.abs(drop('mouth_teeth')) < MR.D * 0.15, 'teeth ride on the upper lip');
  // halfway open is in between (continuous, not a picture swap)
  const L = byName(M, 'mouth_lip_lower'); Core.deform(M, L, closed); const a0 = centre(L);
  Core.deform(M, L, pose({ mouthOpen: 0.5 })); const a5 = centre(L); Core.deform(M, L, wide); const a1 = centre(L);
  assert.ok(a0 < a5 && a5 < a1, 'lower lip moves continuously');
  // smiling bends the corners up
  Core.deform(M, up, pose({ mouthCForm: 1 }));
  const nx = up.cur.length / 2;
  let corner = 0, mid = 0, nc = 0, nm = 0;
  for (let v = 0; v < nx; v++) { const x = up.base[v * 2], d = up.cur[v * 2 + 1] - up.base[v * 2 + 1]; if (Math.abs(x - MR.cx) > MR.hw * 0.8) { corner += d; nc++; } else if (Math.abs(x - MR.cx) < MR.hw * 0.2) { mid += d; nm++; } }
  assert.ok(corner / nc < mid / nm, 'corners rise relative to the middle in a smile');

  // teeth / tongue are clipped by the cavity (mask channel 'M')
  const frame = Core.buildFrame(M, wide);
  assert.ok(frame.masks.some(m => m.side === 'M' && m.L.name === 'mouth_inner'));
  assert.ok(frame.items.filter(it => it.L.name === 'mouth_teeth' || it.L.name === 'mouth_tongue').every(it => it.clip === 'M'));
  // rig off: nothing of the rigged mouth is drawn
  assert.ok(!Core.buildFrame(M, pose({ mouthRig: 0, mouthOpen: 1 })).items.some(it => it.L.fade === 'mouthRig'));
}

// ---------- open drawing: kept as the cavity ----------
{
  const rig = Rigger.buildRig({ width: 300, height: 300, children: [face(), open()] });
  const MR = rig.anchors.mouthRig;
  assert.strictEqual(MR.mode, 'art');
  const names = rig.layers.filter(L => L.fade === 'mouthRig').map(L => L.name);
  assert.deepStrictEqual(names, ['mouth_inner', 'mouth_lip_upper'], 'open art: the drawing is the cavity, plus a closing line');
  assert.ok(Math.abs(MR.cy - 136) < 3, 'upper lip on the top edge of the open mouth: ' + MR.cy);
  const M = Core.createModel(rig), inner = byName(M, 'mouth_inner');
  Core.deform(M, inner, pose({ mouthOpen: 1 }));
  let ymax = -1e9, ymax0 = -1e9;
  for (let k = 1; k < inner.cur.length; k += 2) { ymax = Math.max(ymax, inner.cur[k]); ymax0 = Math.max(ymax0, inner.base[k]); }
  assert.ok(Math.abs(ymax - ymax0) < MR.D * 0.15, 'fully open = the drawing as painted');
  Core.deform(M, inner, pose({ mouthOpen: 0.03 }));
  let h = 0, top = 1e9; for (let k = 1; k < inner.cur.length; k += 2) { h = Math.max(h, inner.cur[k]); top = Math.min(top, inner.cur[k]); }
  assert.ok(h - top < MR.D * 0.4, 'nearly closed = squashed to the lip line');
  const lip = byName(M, 'mouth_lip_upper');
  assert.ok(Core.fadeAlpha(M, lip, pose(), {}) === 1 && Core.fadeAlpha(M, lip, pose({ mouthOpen: 1 }), {}) < 0.05, 'painted line gives way to the drawing\'s outline');
}

// ---------- opt out ----------
{
  const rig = Rigger.buildRig({ width: 300, height: 300, children: [face(), line()] }, { mouthRig: false });
  assert.ok(!rig.anchors.mouthRig && !rig.layers.some(L => L.fade === 'mouthRig'));
  assert.ok(!Core.createModel(rig).hasMouthRig);
}

// ---------- real PSD ----------
const file = process.argv[2] || path.join(__dirname, '..', 'sample2.psd');
if (fs.existsSync(file)) {
  const { rigFromPsd } = require('./helpers/sample-rig.js');
  const rig = rigFromPsd(file), MR = rig.anchors.mouthRig;
  assert.ok(MR && Number.isFinite(MR.cx) && Number.isFinite(MR.cy) && MR.D > 0, path.basename(file) + ': mouth rig anchors');
  const M = Core.createModel(rig);
  for (const o of [0, 0.4, 1]) {
    const f = Core.buildFrame(M, pose({ mouthOpen: o, mouthForm: 0.6, mouthWide: -0.3 }));
    for (const it of f.items) if (it.L.fade === 'mouthRig') for (const v of it.L.cur) assert.ok(Number.isFinite(v));
  }
  console.log('ok mouth: line + open art split, continuous opening, clip mask, ' + path.basename(file) + ' (' + MR.mode + ')');
} else console.log('ok mouth: line + open art split, continuous opening, clip mask (no sample PSD)');
