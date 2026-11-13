/*!
 * capsule-rig — core.js
 * Pure deformation engine extracted from Anime2.5DRig (lib/app.js, MIT).
 * No DOM, no WebGL, no globals: one Model per character, so several
 * characters can run side by side. Runs in the browser and in Node.
 *
 * The math in fadeAlpha / deform / updateSprings is kept line-for-line
 * identical to upstream (tests/equivalence.test.js checks this).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../lib/runtime.js'));
  else root.CapsuleCore = factory(root.RigRuntime);
})(typeof self !== 'undefined' ? self : this, function (RT) {
  'use strict';

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function baseName(n) { return n === 'eye_close2' ? n : n.replace(/_\d+$/, ''); }
  const FRONTISH = { 'front hair': 1, 'side hair': 1, 'ahoge': 1 };

  // Parameter defaults and slider ranges (from upstream index.html / app.js).
  const DEFAULTS = {
    angleX: 0, angleY: 0, angleZ: 0, eyeOpenL: 1, eyeOpenR: 1, eyeX: 0, eyeY: 0, brow: 0,
    mouthOpen: 0, mouthForm: 0, mouthCY: 0, body: 0, physAmp: 2, soft: 2,
    browAngL: 0, browAngR: 0, browAngSym: 0, bangL: 0, bangC: 0, bangR: 0,
    armY: 0, armPos: 0, bust: 2.5, bustY: 1, irisScale: 1, mouthEase: 0.72, eyeEase: 0.3,
    fhAmp: 2, fhSoft: 0.4, eyeCY: 0, eyeCAng: 0, mouthCAng: 0, eyeScaleL: 1, eyeScaleR: 1, mouthScale: 1, accAmp: 1,
    // capsule extensions (0 = upstream behaviour)
    mouthCForm: 0,
    // arms: FK angles in degrees (shoulder + = raise outward, elbow + = bend inward)
    // and IK wrist target offsets in arm lengths (X + = outward, Y + = up)
    armLShoulder: 0, armLElbow: 0, armRShoulder: 0, armRElbow: 0, armLX: 0, armLY: 0, armRX: 0, armRY: 0
  };
  const ARM_KEYS = ['armLShoulder', 'armLElbow', 'armRShoulder', 'armRElbow', 'armLX', 'armLY', 'armRX', 'armRY'];
  const EXTENSIONS = ['mouthCForm'].concat(ARM_KEYS);
  const RANGES = {
    angleX: [-1, 1], angleY: [-1, 1], angleZ: [-1, 1], eyeOpenL: [0, 1], eyeOpenR: [0, 1], eyeX: [-1, 1], eyeY: [-1, 1],
    irisScale: [0.5, 1.3], eyeScaleL: [0.5, 1.5], eyeScaleR: [0.5, 1.5], eyeEase: [0, 1], eyeCY: [-1, 1], eyeCAng: [-1, 1],
    brow: [-1, 1], browAngSym: [-1, 1], browAngL: [-1, 1], browAngR: [-1, 1], mouthOpen: [0, 1], mouthForm: [-1, 1],
    mouthCY: [-1, 1], mouthEase: [0, 1], mouthCAng: [-1, 1], mouthScale: [0.5, 1.5], fhAmp: [0, 3], fhSoft: [0, 2],
    bangL: [-1, 1], bangC: [-1, 1], bangR: [-1, 1], body: [-1, 1], armY: [-1, 1], armPos: [-1, 1], bust: [0, 4],
    bustY: [-3, 3], physAmp: [0, 3], soft: [0, 3], accAmp: [0, 3],
    mouthCForm: [-1, 1],
    armLShoulder: [-90, 180], armRShoulder: [-90, 180], armLElbow: [-60, 160], armRElbow: [-60, 160],
    armLX: [-1.5, 1.5], armLY: [-1.5, 1.5], armRX: [-1.5, 1.5], armRY: [-1.5, 1.5]
  };

  /**
   * Build a model from a rig (bundle rig.json, or Rigger.buildRig output).
   * Mesh + strand weights are computed here (upstream prepareLayers, minus GL).
   */
  function createModel(rig, opts) {
    opts = opts || {};
    const W = rig.canvas.w;
    const layers = [];
    for (const Lr of rig.layers) {
      const L = Object.assign({ visible: true, opacity: 1 }, Lr, { id: String(Lr.z) + ':' + Lr.name });
      delete L.img;
      L.defaultDepth = L.depth; L.defaultOpacity = L.opacity;
      L.bn = baseName(L.name.replace(/_(l|r)$/, ''));
      const cell = (L.phys ? 30 : 42) * Math.max(0.6, W / 768);
      let { nx, ny } = RT.meshSize(L.w, L.h, cell);
      // capsule: mouths are tiny, so give them enough columns to bend smoothly
      if (L.bn === 'mouth_open' || L.bn === 'mouth_close') { nx = Math.max(nx, 12); ny = Math.max(ny, 4); }
      // capsule: rigged arms bend at the elbow, so they need rows along their length
      if (L.bn === 'handwear' && L.side && rig.anchors && rig.anchors['arm' + L.side]) {
        const long = Math.max(L.w, L.h), short = Math.min(L.w, L.h);
        const nl = Math.max(24, Math.round(long / 24)), ns = Math.max(6, Math.round(short / 24));
        if (L.h >= L.w) { nx = Math.max(nx, ns); ny = Math.max(ny, nl); } else { nx = Math.max(nx, nl); ny = Math.max(ny, ns); }
      }
      const nv = (nx + 1) * (ny + 1);
      const base = new Float32Array(nv * 2), uv = new Float32Array(nv * 2);
      let k = 0;
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) { base[k] = L.x + L.w * i / nx; base[k + 1] = L.y + L.h * j / ny; uv[k] = i / nx; uv[k + 1] = j / ny; k += 2; }
      const idx = new Uint16Array(nx * ny * 6); let q = 0;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1; idx[q++] = a; idx[q++] = b; idx[q++] = c; idx[q++] = b; idx[q++] = d; idx[q++] = c; }
      L.base = base; L.cur = new Float32Array(base); L.uv = uv; L.indices = idx;
      if (L.strands && L.strands.length) {
        const S = L.strands, nS = S.length;
        let spacing = 120;
        if (nS > 1) { const ds = []; for (let s = 1; s < nS; s++) ds.push(S[s].x - S[s - 1].x); ds.sort((a, b) => a - b); spacing = ds[ds.length >> 1]; }
        const sig = Math.max(1, spacing * 0.6);
        L.sw = new Float32Array(nv * nS); L.su = new Float32Array(nv);
        L.spr = S.map((s, i) => ({ stiff: { x: 0, v: 0, dx: 0 }, soft: { x: 0, v: 0, dx: 0 }, phase: i * 1.37 + L.z }));
        for (let v = 0; v < nv; v++) {
          const x = base[v * 2], y = base[v * 2 + 1]; let tot = 0;
          for (let s = 0; s < nS; s++) { const w = Math.exp(-Math.pow((x - S[s].x) / sig, 2)); L.sw[v * nS + s] = w; tot += w; }
          let rY = 0, tY = 0;
          if (tot > 1e-6) { for (let s = 0; s < nS; s++) { L.sw[v * nS + s] /= tot; rY += L.sw[v * nS + s] * S[s].rootY; tY += L.sw[v * nS + s] * S[s].tipY; } }
          else { L.sw[v * nS] = 1; rY = S[0].rootY; tY = S[0].tipY; }
          L.su[v] = clamp((y - rY) / Math.max(1, tY - rY), 0, 1);
        }
      }
      layers.push(L);
    }
    const M = {
      canvas: { w: rig.canvas.w, h: rig.canvas.h },
      layers,
      baseAnchors: JSON.parse(JSON.stringify(rig.anchors)),
      anchorOffsets: Object.assign({}, opts.anchorOffsets || rig.anchorOffsets || {}),
      A: null, FS: 1, NP: null, BP: null, FC: null, CHEST: null,
      bounce: { x: 0, v: 0, dy: 0 },
      hasEyeClose2: layers.some(L => L.bn === 'eye_close2'),
      blinkVariant: 1,
      physics: true
    };
    applyAnchors(M);
    return M;
  }

  function buildBangWeights(M, L) {
    const A = M.A;
    if (L.bn !== 'front hair' || !L.su) { L.bw = null; return; }
    const fw = A.face.x1 - A.face.x0, fcx = A.face.cx, f = 36, b1 = fcx - fw * 0.22, b2 = fcx + fw * 0.22, nv = L.base.length / 2;
    L.bw = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) { const x = L.base[v * 2], s1 = smooth((x - b1) / f + 0.5), s2 = smooth((x - b2) / f + 0.5); L.bw[v * 3] = 1 - s1; L.bw[v * 3 + 1] = s1 * (1 - s2); L.bw[v * 3 + 2] = s2; }
  }

  function applyAnchors(M) {
    const a = JSON.parse(JSON.stringify(M.baseAnchors)), o = M.anchorOffsets, off = k => o[k] || {};
    a.face.cx += off('face').dx || 0; a.face.cy += off('face').dy || 0;
    for (const s of ['L', 'R']) { const e = a['eye' + s]; if (!e) continue; e.icx += off('eye' + s).dx || 0; e.icy += off('eye' + s).dy || 0; e.closeY += off('eye' + s + 'Close').dy || 0; }
    const m = off('mouth'); for (const k of ['cx', 'x0', 'x1']) a.mouth[k] += m.dx || 0; for (const k of ['cy', 'y0', 'y1']) a.mouth[k] += m.dy || 0;
    a.neckPivot.cx += off('neck').dx || 0; a.neckPivot.cy += off('neck').dy || 0;
    M.A = a; M.FS = a.faceScale; M.NP = a.neckPivot; M.BP = a.bodyPivot; M.FC = { x: a.face.cx, y: a.face.cy };
    const ch = off('chest'), fh = a.face.y1 - a.face.y0;
    M.CHEST = { cx: M.NP.cx + (ch.dx || 0), cy: a.neckBottom + fh * 0.60 + (ch.dy || 0), rx: Math.max(1, (a.face.x1 - a.face.x0) * 0.60), ry: Math.max(1, fh * 0.45) };
    M.ARMS = {};
    for (const s of ['L', 'R']) {
      const r = a['arm' + s]; if (!r) continue;
      for (const [k, j] of [['shoulder', 'Shoulder'], ['elbow', 'Elbow'], ['wrist', 'Wrist']]) {
        const d = off('arm' + s + j); r[k].x += d.dx || 0; r[k].y += d.dy || 0;
      }
      const S = r.shoulder, E = r.elbow, Wr = r.wrist;
      const L1 = Math.max(1, Math.hypot(E.x - S.x, E.y - S.y)), L2 = Math.max(1, Math.hypot(Wr.x - E.x, Wr.y - E.y));
      M.ARMS[s] = { S, E, W: Wr, L1, L2, width: r.width || L1 * 0.3, out: s === 'L' ? -1 : 1,
        rest1: Math.atan2(E.y - S.y, E.x - S.x), rest2: Math.atan2(Wr.y - E.y, Wr.x - E.x) };
    }
    for (const L of M.layers) { buildBangWeights(M, L); buildArmWeights(M, L); }
  }

  // ---------- arms (capsule extension) ----------
  // Each arm layer is a two-bone chain: the upper arm turns around the
  // shoulder, the forearm also around the elbow. L.aw = how much of the elbow
  // turn a vertex takes (0 upper arm .. 1 forearm), blended across the joint
  // so the elbow bends as a curve instead of a crease.
  const DEG = Math.PI / 180;
  function wrapAngle(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
  function buildArmWeights(M, L) {
    const R = L.bn === 'handwear' && L.side ? M.ARMS[L.side] : null;
    if (!R) { L.aw = null; return; }
    let nx = Math.cos(R.rest1) + Math.cos(R.rest2), ny = Math.sin(R.rest1) + Math.sin(R.rest2);
    const nl = Math.hypot(nx, ny);
    if (nl < 1e-3) { nx = Math.cos(R.rest1); ny = Math.sin(R.rest1); } else { nx /= nl; ny /= nl; }
    const blend = Math.max(8, R.width * 0.6), nv = L.base.length / 2;
    L.aw = new Float32Array(nv);
    for (let v = 0; v < nv; v++) {
      const t = (L.base[v * 2] - R.E.x) * nx + (L.base[v * 2 + 1] - R.E.y) * ny;
      L.aw[v] = smooth(t / (2 * blend) + 0.5);
    }
  }

  /**
   * Two-bone IK with foreshortening. Target T = rest wrist + (tx outward,
   * ty up) in arm lengths, pulled in to the arm's reach.
   *
   * The elbow is the point closest to a "natural elbow" N that both bones can
   * still reach: inside the disk of radius L1 around the shoulder and the disk
   * of radius L2 around T. A bone shorter than its rest length on screen is a
   * bone pointing toward the camera, so it is drawn foreshortened (k1, k2).
   * The region is convex, so the elbow moves continuously with the target -
   * no flipping between the two textbook solutions. N is the rest elbow,
   * swung outward as the hand rises above the shoulder (elbow out for "hand
   * on head", elbow down for "hand to chest").
   */
  function solveArmIK(M, side, tx, ty) {
    const R = M.ARMS && M.ARMS[side]; if (!R) return null;
    const { S, L1, L2, out } = R, reach = L1 + L2;
    let Tx = R.W.x + tx * out * reach, Ty = R.W.y - ty * reach;
    const target = { x: Tx, y: Ty };
    let dx = Tx - S.x, dy = Ty - S.y, d = Math.hypot(dx, dy);
    if (d > reach) { Tx = S.x + dx / d * reach; Ty = S.y + dy / d * reach; dx = Tx - S.x; dy = Ty - S.y; d = reach; }
    // natural elbow
    const lift = smooth((S.y - Ty) / reach * 1.6), sw = R.rest1 - out * lift * 70 * DEG;
    const Nx = S.x + Math.cos(sw) * L1, Ny = S.y + Math.sin(sw) * L1;
    const inA = (x, y) => Math.hypot(x - S.x, y - S.y) <= L1 + 1e-6, inB = (x, y) => Math.hypot(x - Tx, y - Ty) <= L2 + 1e-6;
    let Ex, Ey;
    if (inA(Nx, Ny) && inB(Nx, Ny)) { Ex = Nx; Ey = Ny; }
    else {
      const cands = [];
      const pa = Math.max(1e-9, Math.hypot(Nx - S.x, Ny - S.y)), Ax = S.x + (Nx - S.x) / pa * L1, Ay = S.y + (Ny - S.y) / pa * L1;
      if (inB(Ax, Ay)) cands.push([Ax, Ay]);
      const pb = Math.max(1e-9, Math.hypot(Nx - Tx, Ny - Ty)), Bx = Tx + (Nx - Tx) / pb * L2, By = Ty + (Ny - Ty) / pb * L2;
      if (inA(Bx, By)) cands.push([Bx, By]);
      if (!cands.length && d > 1e-9) {   // corners of the lens (circle intersections)
        const aa = (L1 * L1 - L2 * L2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, L1 * L1 - aa * aa));
        const mx = S.x + dx / d * aa, my = S.y + dy / d * aa;
        cands.push([mx - dy / d * h, my + dx / d * h], [mx + dy / d * h, my - dx / d * h]);
      }
      if (!cands.length) cands.push([S.x + Math.cos(R.rest1) * L1, S.y + Math.sin(R.rest1) * L1]);
      let best = Infinity;
      for (const c of cands) { const q = Math.hypot(c[0] - Nx, c[1] - Ny); if (q < best) { best = q; Ex = c[0]; Ey = c[1]; } }
    }
    const l1 = Math.hypot(Ex - S.x, Ey - S.y), l2 = Math.hypot(Tx - Ex, Ty - Ey);
    const up = l1 > 1e-6 ? Math.atan2(Ey - S.y, Ex - S.x) : R.rest1;
    const fore = l2 > 1e-6 ? Math.atan2(Ty - Ey, Tx - Ex) : up + (R.rest2 - R.rest1);
    return { t1: wrapAngle(up - R.rest1), t2: wrapAngle((fore - up) - (R.rest2 - R.rest1)), k1: l1 / L1, k2: l2 / L2, reach, target, elbow: { x: Ex, y: Ey } };
  }

  /**
   * Current arm pose for side 'L' | 'R' (null at rest or when the arm is not
   * rigged). FK angles (degrees) add to the IK result.
   */
  function armPose(M, side, e) {
    const R = M.ARMS && M.ARMS[side]; if (!R) return null;
    const fs = e['arm' + side + 'Shoulder'] || 0, fe = e['arm' + side + 'Elbow'] || 0;
    const tx = e['arm' + side + 'X'] || 0, ty = e['arm' + side + 'Y'] || 0;
    if (!fs && !fe && !tx && !ty) return null;
    let t1 = -R.out * fs * DEG, t2 = R.out * fe * DEG, k1 = 1, k2 = 1, target = null;
    if (tx || ty) { const ik = solveArmIK(M, side, tx, ty); t1 += ik.t1; t2 += ik.t2; k1 = ik.k1; k2 = ik.k2; target = ik.target; }
    const S = R.S, a1 = R.rest1 + t1, a2 = R.rest2 + t1 + t2;
    const ax = Math.cos(a1), ay = Math.sin(a1), fx = Math.cos(a2), fy = Math.sin(a2);
    const E2 = { x: S.x + ax * R.L1 * k1, y: S.y + ay * R.L1 * k1 };
    const W2 = { x: E2.x + fx * R.L2 * k2, y: E2.y + fy * R.L2 * k2 };
    return { S, E2, W2, t1, t2, k1, k2, c1: Math.cos(t1), s1: Math.sin(t1), ax, ay, fx, fy, L1: R.L1, target };
  }

  /**
   * How much of the forearm is in front of the body, 0..1. The arm layer sits
   * behind topwear/face (as painted), so a hand brought to the chest or face
   * would vanish; buildFrame draws the forearm once more on top with this
   * strength. Two cues: the hand moved inward past the shoulder line, or the
   * upper arm is foreshortened (pointing at the camera).
   */
  function armFront(M, side, e, P) {
    const R = M.ARMS && M.ARMS[side];
    P = P || (R ? armPose(M, side, e) : null);
    if (!P) return 0;
    const o = M.ARMS[side === 'L' ? 'R' : 'L'];
    const sw = o ? Math.abs(o.S.x - R.S.x) : (M.A.face.x1 - M.A.face.x0) * 1.3;
    const inward = R.out * (R.S.x - P.W2.x);
    const f1 = smooth((inward - sw * 0.05) / (sw * 0.25));
    const f2 = smooth((0.92 - P.k1) / 0.25);
    return Math.max(f1, f2);
  }

  // ---------- upstream math (do not edit without re-running the equivalence test) ----------
  function fadeAlpha(M, L, e, alt) {
    const blinkVariant = M.blinkVariant;
    if (!L.fade) return 1;
    if (L.fade === 'eyeOpen') { const v = L.side === 'L' ? e.eyeOpenL : e.eyeOpenR; return smooth((v - (0.10 + e.eyeEase * 0.45)) / 0.15); }
    if (L.fade === 'eyeClose' || L.fade === 'eyeClose2') {
      const alternate = blinkVariant === 2 && alt[L.side];
      if ((L.fade === 'eyeClose2') !== alternate) return 0;
      const v = L.side === 'L' ? e.eyeOpenL : e.eyeOpenR; return 1 - smooth((v - (0.10 + e.eyeEase * 0.45)) / 0.15);
    }
    if (L.fade === 'mouthOpen') return smooth((e.mouthOpen - (0.05 + e.mouthEase * 0.35)) / 0.12);
    if (L.fade === 'mouthClose') return 1 - smooth((e.mouthOpen - (0.05 + e.mouthEase * 0.35)) / 0.12);
    return 1;
  }

  function deform(M, L, e) {
    const { A, FS, NP, BP, FC, CHEST, bounce } = M;
    const b = L.base, o = L.cur, n = b.length;
    const isHead = L.group === 'head';
    const az = e.angleZ * 0.07, cz = Math.cos(az), sz = Math.sin(az);
    const ab = e.body * 0.028, cb = Math.cos(ab), sb = Math.sin(ab);
    const bn = L.bn, eyeSide = L.side, EA = eyeSide === 'L' ? A.eyeL : (eyeSide === 'R' ? A.eyeR : null);
    const vOpen = eyeSide === 'L' ? e.eyeOpenL : e.eyeOpenR;
    const mo = e.mouthOpen, mHalfW = (A.mouth.x1 - A.mouth.x0) / 2;
    const nS = L.strands ? L.strands.length : 0;
    const AP = L.aw ? armPose(M, L.side, e) : null;   // capsule arm rig (null at rest)
    const bcx = L.x + L.w / 2, bcy = L.y + L.h / 2;
    const kind = L.phys === 'sway' ? 'acc' : FRONTISH[bn] ? 'fh' : 'bh';
    const physOn = nS && M.physics && L.su;
    const ampK = kind === 'acc' ? e.accAmp * 1.4 : kind === 'fh' ? e.fhAmp : e.physAmp;
    const softK = kind === 'acc' ? 0.8 : kind === 'fh' ? e.fhSoft : e.soft;
    const powA = kind === 'acc' ? 1.2 : kind === 'fh' ? 1.8 : 2.1;
    for (let k = 0; k < n; k += 2) {
      let x = b[k], y = b[k + 1];
      const vi = k >> 1;
      if (AP) {
        // 1) turn around the shoulder  2) slide along the upper arm (foreshortening; the
        // forearm moves with the elbow)  3) turn around the elbow, blended by L.aw
        // 4) foreshorten the forearm along its axis
        let rx = x - AP.S.x, ry = y - AP.S.y;
        x = AP.S.x + rx * AP.c1 - ry * AP.s1; y = AP.S.y + rx * AP.s1 + ry * AP.c1;
        if (AP.k1 !== 1) { const al = clamp((x - AP.S.x) * AP.ax + (y - AP.S.y) * AP.ay, 0, AP.L1) * (AP.k1 - 1); x += AP.ax * al; y += AP.ay * al; }
        const wa = L.aw[vi], ta = AP.t2 * wa;
        if (ta) { const ca = Math.cos(ta), sa = Math.sin(ta); rx = x - AP.E2.x; ry = y - AP.E2.y; x = AP.E2.x + rx * ca - ry * sa; y = AP.E2.y + rx * sa + ry * ca; }
        if (AP.k2 !== 1 && wa) {
          const along = (x - AP.E2.x) * AP.fx + (y - AP.E2.y) * AP.fy;
          if (along > 0) { const f = along * (AP.k2 - 1) * wa; x += AP.fx * f; y += AP.fy * f; }
        }
      }
      // --- closed-eye / mouth scale ---
      if (EA && (bn === 'eye_close' || bn === 'eye_close2')) {
        const sE = eyeSide === 'L' ? e.eyeScaleL : e.eyeScaleR;
        if (sE !== 1) { const cxE = (EA.x0 + EA.x1) / 2, cyE = (EA.y0 + EA.y1) / 2; x = cxE + (x - cxE) * sE; y = cyE + (y - cyE) * sE; }
      }
      if (bn === 'mouth_open' || bn === 'mouth_close') {
        const sM = e.mouthScale;
        if (sM !== 1) { x = A.mouth.cx + (x - A.mouth.cx) * sM; y = A.mouth.cy + (y - A.mouth.cy) * sM; }
      }
      // --- local features ---
      if (L.fade === 'eyeOpen' && EA) {
        if (bn === 'irides') {
          const isc = e.irisScale, ibx = e.irisBounceX || 1, iby = e.irisBounceY || 1;
          x = EA.icx + (x - EA.icx) * isc * ibx; y = EA.icy + (y - EA.icy) * isc * iby;
          x += e.eyeX * 11 * FS; y += e.eyeY * 6 * FS;
          const tl = smooth((0.32 - vOpen) / 0.32);   // iris stays round until nearly closed
          y = EA.closeY + (y - EA.closeY) * (1 - 0.80 * tl);
        } else {
          y = EA.closeY + (y - EA.closeY) * (1 - 0.85 * (1 - vOpen));   // lid compression
        }
      }
      if ((L.fade === 'eyeClose' || L.fade === 'eyeClose2') && EA) {
        y -= vOpen * 3; y += e.eyeCY * 14 * FS;
        const thE = e.eyeCAng * 0.3 * (eyeSide === 'L' ? 1 : -1);
        if (thE) { const ct = Math.cos(thE), st = Math.sin(thE), rx = x - bcx, ry = y - bcy; x = bcx + rx * ct - ry * st; y = bcy + rx * st + ry * ct; }
      }
      if (bn === 'eyebrow') {
        y += (-e.brow * 9 + (1 - vOpen) * 3.5) * FS;
        const th = (eyeSide === 'L' ? (e.browAngL + e.browAngSym) : (e.browAngR - e.browAngSym)) * 0.30;
        if (th) { const ct = Math.cos(th), st = Math.sin(th), rx = x - bcx, ry = y - bcy; x = bcx + rx * ct - ry * st; y = bcy + rx * st + ry * ct; }
      }
      if (L.fade === 'mouthOpen') {
        y = A.mouth.y0 + (y - A.mouth.y0) * (0.5 + 0.5 * mo);
        const q = Math.pow(Math.abs(x - A.mouth.cx) / (mHalfW + 4), 1.5);
        y -= e.mouthForm * 6 * FS * (q - 0.35);
      }
      if (L.fade === 'mouthClose') {
        // capsule extension: bend the closed mouth (smile > 0, frown < 0). 0 = upstream behaviour.
        if (e.mouthCForm) { const q = Math.pow(Math.abs(x - A.mouth.cx) / (mHalfW + 4), 1.5); y -= e.mouthCForm * 7 * FS * (q - 0.35); }
        y += e.mouthCY * 14 * FS;
        const thM = e.mouthCAng * 0.35;
        if (thM) { const ct = Math.cos(thM), st = Math.sin(thM), rx = x - A.mouth.cx, ry = y - A.mouth.cy; x = A.mouth.cx + rx * ct - ry * st; y = A.mouth.cy + rx * st + ry * ct; }
      }
      if (bn === 'face' && y > A.mouth.cy) y += mo * 6 * FS * smooth((y - A.mouth.cy) / Math.max(1, A.face.y1 - A.mouth.cy));
      // --- head transform ---
      let hw = isHead ? 1 : (L.group === 'body' ? 0.16 : 0);   // body subtly follows head XYZ
      if (bn === 'neck') hw = 0.55 * smooth((A.neckBottom - y) / Math.max(1, A.neckBottom - A.neckTop));
      if (hw > 0) {
        const rx = x - NP.cx, ry = y - NP.cy, rx2 = rx * cz - ry * sz, ry2 = rx * sz + ry * cz;
        x += (rx2 - rx) * hw; y += (ry2 - ry) * hw;
        const dd = L.depth;
        x += hw * FS * (e.angleX * (14 + 40 * (dd - 1)) + e.angleX * (NP.cy - y) * 0.028);
        y += hw * FS * (-e.angleY * (9 + 30 * (dd - 1)) - e.angleY * (dd - 1) * (y - FC.y) * 0.05);
      }
      // --- breathing ---
      y -= (L.group === 'body' ? e.breath * 2.0 : e.breathHead * 1.6) * FS;
      if (bn === 'topwear' && y < CHEST.cy) y -= e.breath * 2.2 * FS * smooth((CHEST.cy - y) / (CHEST.ry * 2));   // shoulders rise
      if (bn === 'topwear') x = NP.cx + (x - NP.cx) * (1 + e.breath * 0.003);
      // --- bust jiggle ---
      if (bn === 'topwear') {
        const gx = (x - CHEST.cx) / CHEST.rx, gy = (y - (CHEST.cy + e.bustY * 70 * FS)) / CHEST.ry;
        y += bounce.dy * e.bust * Math.exp(-gx * gx - gy * gy);
      }
      // --- arms ---
      if (bn === 'handwear') {
        const w = smooth((y - L.y) / L.h * 1.15);
        y -= e.armY * 30 * FS * w; y += e.armPos * 40 * FS; x += e.armY * 6 * FS * w * (x < NP.cx ? 1 : -1);
      }
      // --- bang blocks ---
      if (L.bw) { const m = Math.pow(L.su[vi], 1.4) * 22 * FS; x += (e.bangL * L.bw[vi * 3] + e.bangC * L.bw[vi * 3 + 1] + e.bangR * L.bw[vi * 3 + 2]) * m; }
      // --- strand physics: stiff root, fluffy tips ---
      if (physOn) {
        const u = kind === 'fh' ? Math.min(1, L.su[vi] * 1.6) : L.su[vi];
        const amp = Math.pow(u, powA) * ampK, softMix = Math.min(1, Math.pow(u, 1.2) * softK);
        let dx = 0;
        for (let s = 0; s < nS; s++) { const w = L.sw[vi * nS + s]; if (w < 0.001) continue; const sp = L.spr[s]; dx += w * (sp.stiff.dx * (1 - softMix) + sp.soft.dx * softMix); }
        x += dx * amp; y += Math.abs(dx) * amp * 0.12;
      }
      o[k] = x; o[k + 1] = y;
    }
    // --- body rotation (around bottom center) ---
    if (Math.abs(ab) > 1e-4) {
      for (let k = 0; k < n; k += 2) { const rx = o[k] - BP.cx, ry = o[k + 1] - BP.cy; o[k] = BP.cx + rx * cb - ry * sb; o[k + 1] = BP.cy + rx * sb + ry * cb; }
    }
  }

  function updateSprings(M, e, t, dt, wind) {
    const { FS, NP, BP, FC, bounce } = M;
    const headDX = (e.angleX * 14 + e.angleZ * 0.07 * (NP.cy - FC.y)) * FS;
    const bodyDX = e.body * 0.028 * (BP.cy - NP.cy) * 0.35 + e.angleX * 14 * 0.16 * FS;
    for (const L of M.layers) {
      if (!L.spr) continue;
      const base = L.group === 'head' ? headDX : bodyDX, windScale = L.phys === 'sway' && L.group !== 'head' ? 2.5 : 1;
      for (const sp of L.spr) {
        const w = wind ? (1.8 * Math.sin(t * 0.8 + sp.phase) + 1.0 * Math.sin(t * 1.9 + sp.phase * 2.3)) * windScale : 0;
        const txv = base + w * FS;
        RT.spring(sp.stiff, txv, 70, 9, dt); sp.stiff.dx = -(sp.stiff.x - txv) * 2.2;
        RT.spring(sp.soft, txv, 16, 1.3, dt); sp.soft.dx = -(sp.soft.x - txv) * 3.0;
      }
    }
    const bustTgt = (e.breath * 3.0 - e.angleY * 6.0 + e.body * 4.0) * FS;
    RT.spring(bounce, bustTgt, 140, 4.2, dt); bounce.dy = -(bounce.x - bustTgt) * 3.0;
  }
  // ---------- end of upstream math ----------

  /**
   * Deform every layer for pose `e` and return the draw list (upstream render(),
   * minus GL). `extraAlpha(L)` lets the animator fade toggle layers in/out.
   */
  function buildFrame(M, e, extraAlpha) {
    const alt = { L: false, R: false };
    for (const L of M.layers) if (L.fade === 'eyeClose2' && L.side && L.visible && L.opacity > 0) alt[L.side] = true;
    const items = [], masks = [], front = [];
    for (const L of M.layers) {
      const isMask = L.bn === 'eyewhite' && !!L.side;
      const xa = extraAlpha ? extraAlpha(L) : 1;
      const alpha = L.visible ? fadeAlpha(M, L, e, alt) * L.opacity * xa : 0;
      if (alpha < 0.004 && !isMask) continue;
      deform(M, L, e);
      if (isMask) masks.push({ L, side: L.side });
      if (alpha >= 0.004) items.push({ L, alpha, clip: L.bn === 'irides' && L.side ? L.side : null });
      // capsule: forearm in front of the body (same mesh, drawn again on top, fading in past the elbow)
      if (L.aw && alpha >= 0.004) { const f = armFront(M, L.side, e); if (f > 0.004) front.push({ L, alpha: alpha * f, clip: null, valpha: L.aw, front: true }); }
    }
    for (const it of front) items.push(it);
    return { masks, items };
  }

  return { DEFAULTS, RANGES, EXTENSIONS, ARM_KEYS, clamp, smooth, createModel, applyAnchors, fadeAlpha, deform, updateSprings, buildFrame, armPose, solveArmIK, armFront };
});
