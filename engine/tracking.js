/*!
 * capsule-rig — tracking.js
 * Camera hands -> avatar arm parameters. No DOM; works with any detector that
 * gives a face box and wrist points in the same image coordinates (MediaPipe
 * Hands / Pose / Holistic in the editor or the Capsule front end).
 *
 *   const arms = CapsuleTracking.createArmTracker();
 *   // every camera frame (t in seconds; x already multiplied by the video aspect so x and y share a unit)
 *   const rel = arms.update({ face: { cx, cy, w, h }, hands: [{ x, y, label: 'Left' | 'Right', score }] }, t);
 *   // every render frame
 *   Object.assign(pose, CapsuleTracking.armParams(model, rel));   // -> armLX, armLY, armRX, armRY
 *
 * Mirror rule (same as face tracking): the camera image is NOT flipped, so the
 * user's right hand is on the image left and drives the avatar's screen-left
 * arm "L". The user's body size comes from the face: shoulders ~1.4 face widths
 * from the face centre, one face height below it; reach ~4 face widths.
 *
 * `rel` is each wrist relative to its shoulder in arm lengths (x outward, y up)
 * plus `presence` 0..1 (fades in when a hand appears, out after it is lost),
 * so arms ease back to rest instead of snapping when a hand leaves the frame.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CapsuleTracking = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  // One Euro filter (Casiez et al. 2012)
  function OneEuro(minCutoff, beta) { this.minCutoff = minCutoff; this.beta = beta; this.x = null; this.dx = 0; this.t = null; }
  const alpha = (cutoff, dt) => { const r = 2 * Math.PI * cutoff * dt; return r / (r + 1); };
  OneEuro.prototype.filter = function (v, t) {
    if (this.x === null || !(t > this.t)) { this.x = v; this.t = t; this.dx = 0; return v; }
    const dt = Math.min(1, t - this.t); this.t = t;
    this.dx += alpha(1, dt) * ((v - this.x) / dt - this.dx);
    this.x += alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt) * (v - this.x);
    return this.x;
  };
  OneEuro.prototype.reset = function () { this.x = null; this.t = null; this.dx = 0; };

  const BODY = { shoulderOut: 1.4, shoulderDown: 1.0, reach: 4.0 };

  /** User's shoulders and reach estimated from the face box. */
  function bodyFromFace(face) {
    const w = Math.max(1e-4, face.w), h = Math.max(1e-4, face.h || face.w * 1.2);
    return { L: { x: face.cx - w * BODY.shoulderOut, y: face.cy + h * BODY.shoulderDown },
             R: { x: face.cx + w * BODY.shoulderOut, y: face.cy + h * BODY.shoulderDown }, reach: w * BODY.reach };
  }

  /**
   * Which hand drives which avatar arm. MediaPipe labels assume a mirrored
   * (selfie) image; on the raw image "Left" is the user's right hand = avatar L.
   * Labels decide when they agree; otherwise the image x position does.
   */
  function assignHands(hands, face) {
    const out = { L: null, R: null }, list = (hands || []).filter(h => h && Number.isFinite(h.x) && Number.isFinite(h.y));
    if (!list.length) return out;
    if (list.length >= 2) {
      const [a, b] = list.slice().sort((p, q) => (q.score || 0) - (p.score || 0)).slice(0, 2);
      const la = a.label === 'Left' ? 'L' : a.label === 'Right' ? 'R' : null, lb = b.label === 'Left' ? 'L' : b.label === 'Right' ? 'R' : null;
      if (la && lb && la !== lb) { out[la] = a; out[lb] = b; }
      else if (a.x <= b.x) { out.L = a; out.R = b; } else { out.L = b; out.R = a; }
      return out;
    }
    const h = list[0], side = h.label === 'Left' ? 'L' : h.label === 'Right' ? 'R' : (h.x < face.cx ? 'L' : 'R');
    out[side] = h;
    return out;
  }

  function createArmTracker(opts) {
    const o = Object.assign({ minCutoff: 1.2, beta: 0.6, fadeIn: 0.2, fadeOut: 0.6, hold: 0.25 }, opts || {});
    const st = {};
    for (const s of ['L', 'R']) st[s] = { fx: new OneEuro(o.minCutoff, o.beta), fy: new OneEuro(o.minCutoff, o.beta), x: 0, y: -1, presence: 0, seen: -Infinity, t: null };
    let last = { L: { x: 0, y: -1, presence: 0 }, R: { x: 0, y: -1, presence: 0 } };

    function update(input, t) {
      const face = input && input.face;
      const sides = face ? assignHands(input.hands, face) : { L: null, R: null };
      const body = face ? bodyFromFace(face) : null;
      for (const s of ['L', 'R']) {
        const S = st[s], h = sides[s], dt = S.t == null ? 0 : clamp(t - S.t, 0, 1); S.t = t;
        if (h && body) {
          const out = s === 'L' ? -1 : 1, sh = body[s];
          const rx = clamp((h.x - sh.x) * out / body.reach, -1.5, 1.5), ry = clamp((sh.y - h.y) / body.reach, -1.5, 1.5);
          if (S.presence <= 0.01) { S.fx.reset(); S.fy.reset(); }
          S.x = S.fx.filter(rx, t); S.y = S.fy.filter(ry, t); S.seen = t;
          S.presence = Math.min(1, S.presence + (o.fadeIn > 0 ? dt / o.fadeIn : 1));
        } else if (t - S.seen > o.hold) {
          S.presence = Math.max(0, S.presence - (o.fadeOut > 0 ? dt / o.fadeOut : 1));
        }
      }
      last = { L: { x: st.L.x, y: st.L.y, presence: st.L.presence }, R: { x: st.R.x, y: st.R.y, presence: st.R.presence } };
      return last;
    }
    function reset() { for (const s of ['L', 'R']) { st[s].fx.reset(); st[s].fy.reset(); st[s].presence = 0; st[s].seen = -Infinity; st[s].t = null; } last = { L: { x: 0, y: -1, presence: 0 }, R: { x: 0, y: -1, presence: 0 } }; }
    return { update, reset, get last() { return last; } };
  }

  /**
   * Arm parameters for a model (Core.createModel) from `rel`: the avatar's
   * wrist goes to the same place relative to its shoulder, in its own arm
   * lengths, blended toward rest by presence. Arms without joints are skipped.
   */
  function armParams(model, rel) {
    const out = {};
    for (const s of ['L', 'R']) {
      const R = model && model.ARMS && model.ARMS[s], r = rel && rel[s];
      if (!R || !r || !(r.presence > 0)) continue;
      const reach = R.L1 + R.L2;
      const restX = (R.W.x - R.S.x) * R.out / reach, restY = (R.S.y - R.W.y) / reach;
      out['arm' + s + 'X'] = clamp((r.x - restX) * r.presence, -1.5, 1.5);
      out['arm' + s + 'Y'] = clamp((r.y - restY) * r.presence, -1.5, 1.5);
    }
    return out;
  }

  /** Face box {cx, cy, w, h} from MediaPipe FaceMesh landmarks (x scaled by aspect). */
  function faceBoxFromMesh(lm, aspect) {
    if (!lm || lm.length < 468) return null;
    const ar = aspect > 0 ? aspect : 4 / 3, P = i => ({ x: lm[i].x * ar, y: lm[i].y });
    const l = P(454), r = P(234), top = P(10), chin = P(152);
    return { cx: (l.x + r.x) / 2, cy: (top.y + chin.y) / 2, w: Math.hypot(l.x - r.x, l.y - r.y), h: Math.hypot(top.x - chin.x, top.y - chin.y) };
  }

  /** Wrists from MediaPipe Hands results (landmark 0), x scaled by aspect. */
  function wristsFromHands(res, aspect) {
    const ar = aspect > 0 ? aspect : 4 / 3, lms = (res && res.multiHandLandmarks) || [], hd = (res && res.multiHandedness) || [];
    return lms.map((lm, i) => lm && lm[0] ? { x: lm[0].x * ar, y: lm[0].y, label: hd[i] && hd[i].label, score: hd[i] ? hd[i].score : 0 } : null).filter(Boolean);
  }

  return { createArmTracker, armParams, assignHands, bodyFromFace, faceBoxFromMesh, wristsFromHands, OneEuro, BODY };
});
