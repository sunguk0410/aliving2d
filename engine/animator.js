/*!
 * capsule-rig — animator.js
 * Parameter layering for one character. No DOM.
 *
 *   base        defaults + rig.json settings + setParams()
 *   expression  held pose (setExpression), absolute targets
 *   idle        upstream idle sway / random glances / blink / breath / talk
 *   motion      one-shot keyframe tracks (play), mode add | override
 *
 * The idle / blink / talk / iris-bounce timing is ported from upstream
 * animate() (Anime2.5DRig lib/app.js, MIT); camera / mouse / mic input removed.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.CapsuleAnimator = factory(root.CapsuleCore);
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';
  const { clamp, DEFAULTS, RANGES } = Core;

  const EASE = {
    linear: t => t,
    easeIn: t => t * t,
    easeOut: t => 1 - (1 - t) * (1 - t),
    easeInOut: t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
    step: t => t < 1 ? 0 : 1
  };

  /** Value of a track [[ms, value, ease?], ...] at time ms. Ease belongs to the segment ending at that key. */
  function sampleTrack(keys, ms) {
    if (!keys.length) return 0;
    if (ms <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      const k1 = keys[i];
      if (ms <= k1[0]) {
        const k0 = keys[i - 1], span = Math.max(1, k1[0] - k0[0]);
        const f = (EASE[k1[2]] || EASE.easeInOut)((ms - k0[0]) / span);
        return k0[1] + (k1[1] - k0[1]) * f;
      }
    }
    return keys[keys.length - 1][1];
  }

  function pickWeighted(list, rand) {
    let tot = 0; for (const c of list) tot += c.weight == null ? 1 : c.weight;
    let r = rand() * tot;
    for (const c of list) { r -= c.weight == null ? 1 : c.weight; if (r <= 0) return c; }
    return list[list.length - 1];
  }

  /**
   * Character style on top of an expression's params: with smileEyes < 1 a smiling expression
   * (eyeSmile > 0, both eyes alike - not a wink) narrows the eyes instead of closing them.
   * Same rule in the editor (lib/app.js applyExpression). Returns a new object.
   */
  function styleExpression(params, tuning) {
    const s = tuning && tuning.smileEyes != null ? tuning.smileEyes : 1, p = Object.assign({}, params);
    if (s >= 1 || !(p.eyeSmile > 0) || p.eyeOpenL == null || p.eyeOpenR == null || Math.abs(p.eyeOpenL - p.eyeOpenR) > 0.3) return p;
    const floor = 0.6 * (1 - s);
    p.eyeOpenL = Math.max(p.eyeOpenL, floor); p.eyeOpenR = Math.max(p.eyeOpenR, floor);
    return p;
  }

  function createAnimator(model, reactions, opts) {
    opts = opts || {};
    const rand = opts.random || Math.random;
    const R = reactions || { expressions: {}, motions: {}, reactions: {} };
    const toggles = new Set(R.toggles || []);
    const auto = Object.assign({ idle: true, blink: true, rand: true, phys: true }, opts.auto || {});
    const liveliness = opts.liveliness == null ? 1 : opts.liveliness;   // scales random glances

    const base = Object.assign({}, DEFAULTS, opts.settings || {});
    const cur = Object.assign({}, base);
    const listeners = {};

    // state ported from upstream
    let blinkT = -1, blinkBounceStarted = false, irisBounceT = -1, nextBlink = 1800;
    const rnd = { ax: 0, ay: 0, az: 0, bd: 0, ex: 0, ey: 0 }; let nextRnd = 0;
    let talkOn = false, talkV = 0, talkTgt = 0, nextTalkState = 0, nextSyl = 0;

    let now = 0;                 // animator clock, ms
    let talkUntil = 0, talkForever = false;
    let baseExpression = 'neutral', expression = null, expressionUntil = 0, thenExpression = null;
    const motions = [];          // active motion instances
    const toggleState = {};      // layer name -> {target, value}

    function emit(type, data) { (listeners[type] || []).forEach(fn => { try { fn(data); } catch (err) { /* ignore */ } }); }

    function exprParams(name) { const x = name && R.expressions && R.expressions[name]; return x ? (x.params || {}) : {}; }
    function exprLayers(name) { const x = name && R.expressions && R.expressions[name]; return x ? (x.layers || {}) : {}; }

    function setToggle(name, value) {
      const st = toggleState[name] || (toggleState[name] = { target: 0, value: 0 });
      st.target = clamp(value, 0, 1);
    }

    function setExpression(name, holdMs, then) {
      if (name && !(R.expressions || {})[name]) return false;
      if (holdMs > 0) { expression = name; expressionUntil = now + holdMs; thenExpression = then || null; }
      else { baseExpression = name || 'neutral'; expression = null; }
      return true;
    }

    function play(name, o) {
      o = o || {};
      const def = R.motions && R.motions[name];
      if (!def) return false;
      if (o.exclusive !== false) for (const m of motions) m.stopAt = Math.min(m.stopAt, now);
      motions.push({ name, def, start: now, stopAt: Infinity, fired: 0 });
      emit('motion', { name });
      return true;
    }

    function talk(ms) { if (ms === true) talkForever = true; else if (ms === false) { talkForever = false; talkUntil = 0; } else talkUntil = Math.max(talkUntil, now + ms); }

    /** Capsule reaction: trigger_type + intensity (1 눈치 / 2 말 걸기 / 3 서운함). */
    function react(trigger, intensity) {
      const list = (R.reactions || {})[trigger];
      if (!list || !list.length) return null;
      let cands = list;
      if (list.some(c => c.intensity != null)) {
        const want = intensity == null ? 1 : intensity;
        const exact = list.filter(c => c.intensity === want);
        if (exact.length) cands = exact;
        else {
          const lower = list.filter(c => c.intensity != null && c.intensity <= want);
          const best = lower.length ? Math.max(...lower.map(c => c.intensity)) : Math.min(...list.map(c => c.intensity));
          cands = list.filter(c => c.intensity === best);
        }
      }
      const c = pickWeighted(cands, rand);
      if (c.motion) play(c.motion);
      if (c.expression) setExpression(c.expression, c.hold || 1500, c.then);
      if (c.talk) talk(c.talk);
      emit('reaction', { trigger, intensity, choice: c });
      return c;
    }

    function setParams(p) { for (const k in p) if (k in base) base[k] = p[k]; }

    /** Advance by dt seconds and return the pose `e` for Core.buildFrame. */
    function update(dt) {
      now += dt * 1000;
      const t = now / 1000;

      if (expression && now >= expressionUntil) { expression = null; if (thenExpression) { const n = thenExpression; thenExpression = null; setExpression(n, 1500); } }
      const activeExpr = expression || baseExpression;
      const tgt = Object.assign({}, base, styleExpression(exprParams(activeExpr), base));

      // expression-driven toggle layers (e.g. "layers": {"blush": 1})
      const wantLayers = exprLayers(activeExpr);
      for (const name of toggles) {
        const fromExpr = name in wantLayers ? wantLayers[name] : 0;
        const st = toggleState[name] || (toggleState[name] = { target: 0, value: 0 });
        st.exprTarget = fromExpr;
      }

      // --- idle (upstream) ---
      if (auto.idle) {
        tgt.angleX += 0.13 * Math.sin(t * 0.42) + 0.05 * Math.sin(t * 1.13);
        tgt.angleY += 0.08 * Math.sin(t * 0.31 + 1.7);
        tgt.angleZ += 0.07 * Math.sin(t * 0.23 + 0.5);
        tgt.body += 0.10 * Math.sin(t * 0.19 + 2.1);
      }
      const motionActive = motions.length > 0;
      if (auto.rand && !motionActive) {
        if (now > nextRnd) {
          nextRnd = now + 1400 + rand() * 2600;
          const L = liveliness;
          rnd.ax = (rand() * 2 - 1) * 0.55 * L; rnd.ay = (rand() * 2 - 1) * 0.40 * L; rnd.az = (rand() * 2 - 1) * 0.35 * L;
          rnd.bd = (rand() * 2 - 1) * 0.30 * L; rnd.ex = (rand() * 2 - 1) * 0.60 * L; rnd.ey = (rand() * 2 - 1) * 0.35 * L;
        }
        tgt.angleX = clamp(tgt.angleX + rnd.ax, -1, 1); tgt.angleY = clamp(tgt.angleY + rnd.ay, -1, 1);
        tgt.angleZ = clamp(tgt.angleZ + rnd.az, -1, 1); tgt.body = clamp(tgt.body + rnd.bd, -1, 1);
        tgt.eyeX = clamp(tgt.eyeX + rnd.ex, -1, 1); tgt.eyeY = clamp(tgt.eyeY + rnd.ey, -1, 1);
      }

      // --- motions ---
      for (let i = motions.length - 1; i >= 0; i--) {
        const m = motions[i], d = m.def, local = now - m.start, dur = d.duration || 1000;
        const fi = d.fadeIn || 0, fo = d.fadeOut || 0;
        if (local >= dur || now >= m.stopAt + fo) { motions.splice(i, 1); emit('motionEnd', { name: m.name }); continue; }
        let w = 1;
        if (fi > 0 && local < fi) w = Math.min(w, local / fi);
        if (fo > 0 && local > dur - fo) w = Math.min(w, (dur - local) / fo);
        if (m.stopAt < Infinity && fo > 0) w = Math.min(w, Math.max(0, 1 - (now - m.stopAt) / fo));
        const mode = d.mode || 'add';
        for (const k in d.tracks || {}) {
          if (!(k in tgt)) continue;
          const v = sampleTrack(d.tracks[k], local);
          tgt[k] = mode === 'override' ? tgt[k] + (v - tgt[k]) * w : tgt[k] + v * w;
        }
        const ev = d.events || [];
        while (m.fired < ev.length && ev[m.fired].t <= local) {
          const x = ev[m.fired++];
          if (x.talk) talk(x.talk);
          if (x.layer) setToggle(x.layer, x.value == null ? 1 : x.value);
          if (x.expression) setExpression(x.expression, x.hold || 1500);
        }
      }

      // --- talk (upstream random syllables, gated by talk()) ---
      const talking = talkForever || now < talkUntil;
      if (talking || talkV > 0.01) {
        if (talking && now > nextTalkState) { talkOn = !talkOn; nextTalkState = now + (talkOn ? 1200 + rand() * 2200 : 250 + rand() * 500); }
        if (talking && talkOn && now > nextSyl) { nextSyl = now + 70 + rand() * 110; talkTgt = rand() < 0.25 ? 0.04 : 0.25 + rand() * 0.75; }
        if (!talking || !talkOn) talkTgt = 0;
        talkV += (talkTgt - talkV) * Math.min(1, dt * 22);
        tgt.mouthOpen = Math.max(tgt.mouthOpen, talkV);
      }

      // --- blink (upstream) ---
      if (auto.blink) {
        if (blinkT < 0 && now > nextBlink) { blinkT = 0; blinkBounceStarted = false; model.blinkVariant = model.hasEyeClose2 && rand() < 0.2 ? 2 : 1; nextBlink = now + 1600 + rand() * 3800; if (rand() < 0.18) nextBlink = now + 280; }
        if (blinkT >= 0) {
          blinkT += dt;
          const d = blinkT, hold = model.blinkVariant === 2 ? 3.4 : 0.34; let v;
          if (d < 0.08) v = 1 - d / 0.08; else if (d < 0.08 + hold) v = 0; else if (d < 0.24 + hold) {
            v = (d - 0.08 - hold) / 0.16;
            if (!blinkBounceStarted && v > 0.12) { blinkBounceStarted = true; irisBounceT = 0; }
          } else { v = 1; blinkT = -1; }
          tgt.eyeOpenL = Math.min(tgt.eyeOpenL, v); tgt.eyeOpenR = Math.min(tgt.eyeOpenR, v);
        }
      }
      if (irisBounceT >= 0) { irisBounceT += dt; if (irisBounceT > 0.52) irisBounceT = -1; }

      // --- smoothing (upstream) ---
      const kSmooth = 1 - Math.exp(-dt * 14);
      for (const k in cur) { const r = RANGES[k]; if (r) tgt[k] = clamp(tgt[k], r[0], r[1]); cur[k] += (tgt[k] - cur[k]) * kSmooth; }
      const e = Object.assign({}, cur);
      e.irisBounceX = 1; e.irisBounceY = 1;
      if (irisBounceT >= 0) {
        const p = irisBounceT / 0.52, damp = Math.exp(-2.2 * p);
        const scale = 1 + 0.18 * Math.sin(p * Math.PI * 4.0) * damp, squash = 0.10 * Math.sin(p * Math.PI * 4.0 + Math.PI / 2) * damp;
        e.irisBounceX = scale * (1 + squash); e.irisBounceY = scale * (1 - squash);
      }
      e.breath = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI / 3.4);
      e.breathHead = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI / 3.4 - 0.6);

      // toggle layers fade ~150 ms
      const kT = 1 - Math.exp(-dt * 12);
      for (const name in toggleState) {
        const st = toggleState[name];
        const target = Math.max(st.target, st.exprTarget || 0);
        st.value += (target - st.value) * kT;
      }

      model.physics = auto.phys;
      Core.updateSprings(model, e, t, dt, auto.idle);
      return e;
    }

    function extraAlpha(L) {
      if (!toggles.has(L.bn) && !toggles.has(L.name)) return 1;
      const st = toggleState[L.bn] || toggleState[L.name];
      return st ? st.value : 0;
    }

    return {
      update, extraAlpha, play, react, talk, setExpression, setParams, setToggle,
      setAuto(k, v) { if (k in auto) auto[k] = v; },
      on(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
      get state() { return { now, expression: expression || baseExpression, motions: motions.map(m => m.name), talking: talkForever || now < talkUntil }; },
      get params() { return Object.assign({}, cur); }
    };
  }

  return { createAnimator, styleExpression, sampleTrack, EASE };
});
