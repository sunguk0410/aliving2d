/*
 * CapsuleV2Player — a v2 model, playing by itself, for the CAPSULE front end (no UI).
 *
 *   <script src=".../engine/engine.js"></script>
 *   <script src=".../engine/player.js"></script>
 *   const p = await CapsuleV2Player.create(canvas, modelJsonUrl, { reactions: tableOrUrl });
 *   p.react('GREETING');                 // live2d_reaction_maps trigger (+ intensity 1..3)
 *   p.setExpression('smile'); p.playMotion('nod'); p.talk(1500);
 *   p.track({ ParamAngleX: 12, ParamEyeLOpen: 0.8, ... })   // camera values, Live2D IDs or v2 IDs, every frame
 *   p.trackArms({ armLX, armLY, armRX, armRY })              // engine/tracking.js armParams(p.model, rel)
 *   p.lookAt(x, y)                        // -1..1, when there is no camera (mouse, idle wandering)
 *   p.destroy();
 *
 * Layers each frame, later ones win: tracking / lookAt → breathing → expression (eased 0.3 s; blink multiplies the
 * expression's eye openness) → idle motion (added on top) → the playing motion (faded in / out 0.3 s) → physics.
 * Same rules as viewer/index.html.
 */
(function (root) {
  'use strict';
  const ease = t => t * t * (3 - 2 * t);
  const curveAt = (keys, t) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
      return v0 + (v1 - v0) * (t - t0) / Math.max(1e-6, t1 - t0);
    }
    return keys[keys.length - 1][1];
  };

  function pickReaction(table, trigger, intensity, rnd = Math.random) {
    let cands = (table && table.reactions && table.reactions[trigger]) || [];
    const byInt = cands.filter(c => c.intensity === intensity);
    cands = byInt.length ? byInt : cands.filter(c => c.intensity == null);
    if (!cands.length) return null;
    let r = rnd() * cands.reduce((a, c) => a + (c.weight || 1), 0);
    for (const c of cands) { r -= c.weight || 1; if (r <= 0) return c; }
    return cands[cands.length - 1];
  }

  class Player {
    constructor(model, opts) {
      this.model = model;
      this.opts = Object.assign({ blink: true, breath: true, idle: true, autoLook: true }, opts);
      this.table = null;
      const json = model.json;
      this.defaults = Object.fromEntries(json.params.map(p => [p.id, p.default ?? 0]));
      this.exprIds = new Set((json.expressions || []).flatMap(e => Object.keys(e.params)));
      this.expr = {}; this.exprFrom = {}; this.exprStart = -1;
      this.motion = null; this.queue = [];
      this.idleMo = (json.motions || []).find(x => x.group === 'Idle') || null;
      this.idleW = 0; this.idleLast = {};
      this.tracked = null; this.trackedAt = -1e9; this.arms = null;
      this.look = { x: 0, y: 0 }; this.lookSet = -1e9; this.wander = { x: 0, y: 0, next: 0 };
      this.nextBlink = 0; this.blinkStart = -1;
      this.timers = []; this.t0 = performance.now(); this.last = this.t0;
      this.running = true;
      this.onReaction = null;
      const tick = now => { if (!this.running) return; this.frame(now); this.raf = requestAnimationFrame(tick); };
      this.raf = requestAnimationFrame(tick);
    }

    has(id) { return id in this.model.params || !!(root.CapsuleV2 && root.CapsuleV2.LIVE2D[id]); }
    get expressions() { return (this.model.json.expressions || []).map(e => e.name); }
    get motions() { return (this.model.json.motions || []).map(m => m.name); }

    setExpression(name) {
      const e = (this.model.json.expressions || []).find(x => x.name === name);
      if (!e && name && name !== 'neutral') return false;
      const m = this.model;
      this.exprFrom = Object.fromEntries([...this.exprIds].map(id => [id, id.startsWith('eyeOpen') ? (this.expr[id] ?? 1) : m.params[id]]));
      this.expr = e ? e.params : {};
      this.exprStart = performance.now();
      return true;
    }

    playMotion(name, { queue = false } = {}) {
      const mo = typeof name === 'object' ? name : (this.model.json.motions || []).find(x => x.name === name);
      if (!mo) return false;
      if (queue && this.motion) { this.queue.push(mo); return true; }
      const m = this.model, prev = this.motion;
      const base = Object.fromEntries(Object.keys(mo.curves).map(id => [id, prev && prev.base && id in prev.base ? prev.base[id] : m.params[id]]));
      this.motion = { mo, start: performance.now(), stopAt: null, base, wrote: {} };
      return true;
    }

    stopMotion() { if (this.motion) this.motion.stopAt = performance.now(); this.queue = []; }

    /** talk for ms: the 'talk' motion (mouth) looped, then faded out */
    talk(ms) {
      const mo = (this.model.json.motions || []).find(x => x.name === 'talk');
      if (!mo || !(ms > 0)) return false;
      const loops = Math.max(1, Math.round(ms / 1000 / mo.duration));
      const curves = {};
      for (const [id, keys] of Object.entries(mo.curves)) {
        curves[id] = [];
        for (let i = 0; i < loops; i++) for (const [t, v] of keys) if (!(i && t === 0)) curves[id].push([t + i * mo.duration, v]);
      }
      return this.playMotion({ name: 'talk*', group: 'Tap', duration: loops * mo.duration, loop: false, curves }, { queue: !!this.motion });
    }

    /** the reaction table: object (engine/reactions.default.json v2) or URL */
    async setReactions(tableOrUrl) {
      const t = typeof tableOrUrl === 'string' ? await (await fetch(tableOrUrl)).json() : tableOrUrl;
      if (!t || t.version !== 2) throw new Error('reaction table version 2 expected');
      this.table = t;
      return t;
    }

    /** CAPSULE trigger_type (+ intensity 1 눈치 / 2 말 걸기 / 3 서운함) → motion, expression, talk, then back */
    react(trigger, intensity) {
      const c = pickReaction(this.table, trigger, intensity);
      if (!c) return null;
      this.timers.forEach(clearTimeout); this.timers = [];
      if (c.expression) this.setExpression(c.expression);
      const mo = c.motion && (this.model.json.motions || []).find(x => x.name === c.motion);
      if (mo) this.playMotion(mo.name);
      const after = mo ? mo.duration * 1000 : 0;
      if (c.talk) this.timers.push(setTimeout(() => this.talk(c.talk), after));
      this.timers.push(setTimeout(() => this.setExpression(c.then || 'neutral'), Math.max(c.hold || 0, after + (c.talk || 0))));
      if (this.onReaction) this.onReaction(trigger, c);
      return c;
    }

    /** camera values for this frame: { id: value } in Live2D IDs/units (ParamAngleX …) or v2 IDs */
    track(values) { this.tracked = values; this.trackedAt = performance.now(); }
    trackArms(values) { this.arms = values; this.armsAt = performance.now(); }
    lookAt(x, y) { this.look = { x, y }; this.lookSet = performance.now(); }

    put(id, v) { if (this.has(id)) this.model.set(id, v); }
    approach(id, goal, k) { if (id in this.model.params) this.model.set(id, this.model.params[id] + (goal - this.model.params[id]) * k); }

    frame(now) {
      const m = this.model, P = m.params, o = this.opts;
      const camOn = now - this.trackedAt < 500;
      // 1. tracking, or looking somewhere by itself
      if (camOn) {
        for (const [id, v] of Object.entries(this.tracked)) this.put(id, v);
      } else {
        let gx = this.look.x, gy = this.look.y;
        if (o.autoLook && now - this.lookSet > 3000) {
          // nobody steers: glance around now and then, mostly ahead
          if (now > this.wander.next) {
            const away = Math.random() < 0.35;
            this.wander = { x: away ? (Math.random() * 2 - 1) * 0.5 : 0, y: away ? (Math.random() * 2 - 1) * 0.2 : 0, next: now + 2000 + Math.random() * 4000 };
          }
          gx = this.wander.x; gy = this.wander.y;
        }
        this.approach('angleX', gx, 0.06); this.approach('angleY', gy, 0.06);
        this.approach('eyeX', gx, 0.25); this.approach('eyeY', gy, 0.25);
        this.approach('bodyX', 0.35 * (P.angleX ?? 0), 0.04);
        this.approach('bodyZ', -0.2 * (P.angleX ?? 0), 0.04);
        this.approach('bodyY', 0.25 * (P.angleY ?? 0), 0.04);
      }
      if (this.arms && now - this.armsAt < 500) for (const [id, v] of Object.entries(this.arms)) this.put(id, v);
      else for (const id of ['armLX', 'armLY', 'armRX', 'armRY']) if (!this.motion || !(id in this.motion.mo.curves)) this.approach(id, 0, 0.08);
      // 2. breathing
      if (o.breath && 'breath' in P) m.set('breath', 0.5 - 0.5 * Math.cos((now - this.t0) / 1000 * 2 * Math.PI / 3.6));
      // 3. expression, eased; its eye openness is what the blink closes from
      const et = this.exprStart < 0 ? 1 : Math.min(1, (now - this.exprStart) / 300), ez = ease(et);
      const eyeBase = {};
      for (const id of this.exprIds) {
        if (!(id in P)) continue;
        const goal = this.expr[id] ?? this.defaults[id], from = this.exprFrom[id] ?? goal, v = from + (goal - from) * ez;
        if (id.startsWith('eyeOpen')) { eyeBase[id] = v; continue; }
        if (camOn && id in this.tracked) continue;            // the user's own face wins
        if (!camOn && (id === 'eyeX' || id === 'eyeY')) continue;
        if (et < 1 || id in this.expr) m.set(id, v);
      }
      const camEyes = camOn && ('eyeOpenL' in this.tracked || 'ParamEyeLOpen' in this.tracked);
      if (!camEyes) {
        let open = 1;
        if (o.blink && 'eyeOpenL' in P) {
          if (!this.nextBlink) this.nextBlink = now + 2000;
          if (this.blinkStart < 0 && now > this.nextBlink) this.blinkStart = now;
          if (this.blinkStart >= 0) {
            const u = (now - this.blinkStart) / 320;          // close 35 %, shut 12 %, open 53 %
            open = u < 0.35 ? 1 - ease(u / 0.35) : u < 0.47 ? 0 : u < 1 ? ease((u - 0.47) / 0.53) : 1;
            if (u >= 1) { this.blinkStart = -1; this.nextBlink = now + 2500 + Math.random() * 3000; }
          }
        }
        for (const id of ['eyeOpenL', 'eyeOpenR']) if (id in P) m.set(id, (eyeBase[id] ?? 1) * open);
      }
      // 4. idle motion, added on top (fades out while another motion plays)
      if (this.idleMo) {
        this.idleW += (((o.idle && !this.motion) ? 1 : 0) - this.idleW) * 0.05;
        const t = ((now - this.t0) / 1000) % this.idleMo.duration;
        for (const [id, keys] of Object.entries(this.idleMo.curves)) {
          if (!(id in P)) continue;
          const prev = this.idleLast[id], base = prev && P[id] === prev.v ? prev.base : P[id];
          const v = base + curveAt(keys, t) * this.idleW;
          m.set(id, v); this.idleLast[id] = { v, base };
        }
      }
      // 5. the playing motion
      const mot = this.motion;
      if (mot) {
        const { mo } = mot, el = (now - mot.start) / 1000;
        let t = mo.loop ? el % mo.duration : el, w = Math.min(1, el / 0.3);
        if (!mo.loop && el > mo.duration) w = Math.max(0, 1 - (el - mo.duration) / 0.3);
        if (mot.stopAt) w = Math.min(w, Math.max(0, 1 - (now - mot.stopAt) / 300));
        if (w <= 0 || (this.queue.length && !mo.loop && el > mo.duration)) {
          for (const id of Object.keys(mo.curves)) if (id in P && P[id] === mot.wrote[id]) m.set(id, mot.base[id]);
          this.motion = null;
          if (this.queue.length) this.playMotion(this.queue.shift());
        } else {
          t = Math.min(t, mo.duration);
          for (const [id, keys] of Object.entries(mo.curves)) {
            if (!(id in P)) continue;
            const fresh = mot.wrote[id] !== undefined && P[id] !== mot.wrote[id];
            const b = fresh ? P[id] : mot.base[id];
            const v = b * (1 - w) + curveAt(keys, t) * w;
            m.set(id, v); mot.wrote[id] = v;
          }
        }
      }
      // 6. physics, draw
      m.step(Math.min(0.05, (now - this.last) / 1000)); this.last = now;
      if (this.view) m.setView(...this.view);
      m.draw();
    }

    setView(zoom, cx, cy) { this.view = [zoom, cx, cy]; }
    destroy() { this.running = false; cancelAnimationFrame(this.raf); this.timers.forEach(clearTimeout); }
  }

  async function create(canvas, url, opts = {}) {
    if (!root.CapsuleV2) throw new Error('load engine/engine.js first');
    const model = await root.CapsuleV2.load(canvas, url);
    const p = new Player(model, opts);
    const [W, H] = model.json.canvas;
    p.setView(opts.zoom ?? 1, opts.cx ?? W / 2, opts.cy ?? H / 2);
    if (opts.reactions) await p.setReactions(opts.reactions);
    return p;
  }

  root.CapsuleV2Player = { create, Player, pickReaction, curveAt };
})(typeof window !== 'undefined' ? window : globalThis);
