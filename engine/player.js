/*!
 * capsule-rig — player.js
 * Browser player: one <canvas> = one character.
 *
 *   const p = await CapsulePlayer.load(canvas, 'bundles/chaerin/');
 *   p.react('RETURN', 2);          // Capsule trigger_type + intensity
 *   p.setExpression('pout');       // held expression
 *   p.play('nod');                 // one-shot motion
 *   p.talk(1500) / p.talk(true)    // lip flap while an LLM reply is shown
 *
 * Framing follows Capsule's live2d_models columns: scale, offsetX, offsetY.
 * Needs lib/runtime.js, lib/renderer.js, engine/core.js, engine/animator.js.
 */
(function (root) {
  'use strict';
  const Core = root.CapsuleCore, Anim = root.CapsuleAnimator, RR = root.RigRenderer;

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image load failed: ' + url));
      img.src = url;
    });
  }
  async function getJSON(url, optional) {
    const r = await fetch(url);
    if (!r.ok) { if (optional) return null; throw new Error(url + ' HTTP ' + r.status); }
    return r.json();
  }

  class CapsulePlayer {
    /**
     * opts: {scale=1, offsetX=0, offsetY=0 (CSS px), focus='upper'|'full'|'face',
     *        pixelRatio, maxPixels, auto:{idle,blink,rand,phys}, liveliness, reactions (object or url),
     *        autoplay=true}
     */
    static async load(canvas, bundleUrl, opts) {
      opts = opts || {};
      const baseUrl = bundleUrl.endsWith('/') ? bundleUrl : bundleUrl + '/';
      const rig = await getJSON(baseUrl + 'rig.json');
      if (rig.format !== 'capsule-rig') throw new Error('not a capsule-rig bundle');
      let reactions = opts.reactions;
      if (typeof reactions === 'string') reactions = await getJSON(reactions);
      if (!reactions) reactions = await getJSON(baseUrl + 'reactions.json', true);
      const images = await Promise.all(rig.layers.map(L => loadImage(baseUrl + L.image)));
      return new CapsulePlayer(canvas, rig, reactions, images, opts);
    }

    constructor(canvas, rig, reactions, images, opts) {
      this.canvas = canvas; this.rig = rig; this.opts = Object.assign({ scale: 1, offsetX: 0, offsetY: 0, focus: 'upper', autoplay: true }, opts);
      this.model = Core.createModel(rig);
      this.anim = Anim.createAnimator(this.model, reactions, { settings: rig.settings, auto: this.opts.auto, liveliness: this.opts.liveliness });
      this.images = images;
      this._raf = 0; this._last = 0; this.paused = false; this.lastPose = null;
      const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: !!this.opts.preserveDrawingBuffer });
      if (!gl) throw new Error('WebGL is not available');
      this.gl = gl;
      this._initGL();
      canvas.addEventListener('webglcontextlost', ev => { ev.preventDefault(); this._lost = true; });
      canvas.addEventListener('webglcontextrestored', () => { this._lost = false; this._initGL(); });
      if (typeof ResizeObserver !== 'undefined') { this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(canvas); }
      this.resize();
      if (this.opts.autoplay) this.start();
    }

    _initGL() {
      this.renderer = RR.create(this.gl);
      const M = this.model;
      M.layers.forEach((L, i) => {
        L.screen = new Float32Array(L.base.length);
        this.renderer.upload(L, { positions: L.screen, uvs: L.uv, indices: L.indices, image: this.images[i] });
      });
    }

    /** Fit the character into the canvas. focus picks which part fills the frame. */
    resize() {
      const c = this.canvas, dpr = this.opts.pixelRatio || (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1);
      const cssW = c.clientWidth || c.width, cssH = c.clientHeight || c.height;
      let w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
      const maxPx = this.opts.maxPixels || 1600 * 1600;
      if (w * h > maxPx) { const s = Math.sqrt(maxPx / (w * h)); w = Math.round(w * s); h = Math.round(h * s); }
      if (c.width !== w) c.width = w; if (c.height !== h) c.height = h;
      this._dpr = w / Math.max(1, cssW);
      // region of the PSD to show
      const A = this.model.A, CW = this.model.canvas.w, CH = this.model.canvas.h;
      const fh = A.face.y1 - A.face.y0;
      let box;
      if (this.opts.focus === 'face') box = { cx: A.face.cx, cy: A.face.cy, h: fh * 2.2, w: fh * 2.2 };
      else if (this.opts.focus === 'upper') box = { cx: A.face.cx, cy: A.face.y0 + fh * 1.45, h: fh * 3.4, w: fh * 2.9 };
      else box = { cx: CW / 2, cy: CH / 2, h: CH, w: CW };
      const s = Math.min(h / box.h, w / box.w) * this.opts.scale;
      this._view = { s, tx: w / 2 - box.cx * s + this.opts.offsetX * this._dpr, ty: h / 2 - box.cy * s + this.opts.offsetY * this._dpr };
      if (this.lastPose) this._draw(this.lastPose);
    }

    setFraming(o) { Object.assign(this.opts, o); this.resize(); }

    start() { if (this._raf) return; this._last = performance.now(); const loop = now => { this._raf = requestAnimationFrame(loop); this._tick(now); }; this._raf = requestAnimationFrame(loop); }
    stop() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0; }

    _tick(now) {
      const dt = Math.max(0, Math.min(0.05, (now - this._last) / 1000)); this._last = now;
      if (this._lost || this.paused) return;
      this.lastPose = this.anim.update(dt);
      this._draw(this.lastPose);
    }

    /** Advance manually (tests / offline rendering). */
    step(dt) { this.lastPose = this.anim.update(dt); this._draw(this.lastPose); return this.lastPose; }

    _draw(e) {
      const M = this.model, v = this._view, gl = this.gl;
      const frame = Core.buildFrame(M, e, L => this.anim.extraAlpha(L));
      const seen = new Set();
      const push = L => {
        if (seen.has(L)) return; seen.add(L);
        const src = L.cur, dst = L.screen;
        for (let k = 0; k < src.length; k += 2) { dst[k] = src[k] * v.s + v.tx; dst[k + 1] = src[k + 1] * v.s + v.ty; }
        this.renderer.positions(L, dst);
      };
      frame.masks.forEach(m => push(m.L)); frame.items.forEach(it => push(it.L));
      this.renderer.draw({ width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, background: this.opts.background || [0, 0, 0, 0], masks: frame.masks, items: frame.items });
    }

    // ---- Capsule-facing API ----
    react(trigger, intensity) { return this.anim.react(trigger, intensity); }
    play(motion, o) { return this.anim.play(motion, o); }
    setExpression(name, holdMs, then) { return this.anim.setExpression(name, holdMs, then); }
    talk(msOrBool) { this.anim.talk(msOrBool); }
    setParams(p) { this.anim.setParams(p); }
    setAuto(k, v) { this.anim.setAuto(k, v); }
    setLayer(name, value) { this.anim.setToggle(name, value); }
    on(type, fn) { this.anim.on(type, fn); }
    get state() { return this.anim.state; }

    destroy() {
      this.stop(); if (this._ro) this._ro.disconnect();
      this.model.layers.forEach(L => this.renderer.dispose(L));
      const ext = this.gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext();
    }
  }

  root.CapsulePlayer = CapsulePlayer;
})(typeof self !== 'undefined' ? self : this);
