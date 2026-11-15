/*
 * Capsule v2 engine: keyform model player (WebGL2). Reads bundle v2 (v2/py/export_bundle.py).
 *
 *   const m = await CapsuleV2.load(canvas, 'bundles/x/model.json');
 *   m.set('angleX', 0.5); m.draw();
 *
 * Model: parts in draw order; each part is a texture on a mesh, the mesh moved by a warp grid whose control
 * points carry displacement keyforms per parameter (linear between keys, parameters add). Opacity keyforms
 * multiply. Parts sharing a `group` are two drawings of one thing (e.g. front / three-quarter): they are
 * summed premultiplied with their opacities into an offscreen buffer, then composited, so a cross-fade
 * between drawings never shows the background through.
 */
(function (global) {
  'use strict';

  const VS = `#version 300 es
in vec2 aPos; in vec2 aUv;
uniform vec2 uCanvas; uniform vec4 uView;   // view: scale x, scale y, offset x, offset y (clip space)
out vec2 vUv;
void main() {
  vec2 p = aPos / uCanvas * 2.0 - 1.0; p.y = -p.y;
  gl_Position = vec4(p * uView.xy + uView.zw, 0.0, 1.0);
  vUv = aUv;
}`;
  const FS = `#version 300 es
precision mediump float;
in vec2 vUv; uniform sampler2D uTex; uniform float uAlpha;
uniform sampler2D uMask; uniform bool uUseMask; uniform vec2 uScreen;
out vec4 o;
void main() {
  o = texture(uTex, vUv) * uAlpha;
  if (uUseMask) o *= texture(uMask, gl_FragCoord.xy / uScreen).a;
}`;
  const QVS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); vUv = aPos * 0.5 + 0.5; }`;
  const QFS = `#version 300 es
precision mediump float;
in vec2 vUv; uniform sampler2D uTex; out vec4 o;
void main() { o = texture(uTex, vUv); }`;

  function shader(gl, vs, fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.bindAttribLocation(p, 1, 'aUv');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  function loadImage(url) {
    return new Promise((ok, bad) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => bad(new Error('image ' + url));
      im.src = url;
    });
  }

  // value of a keyed track at v: linear between keys, clamped at the ends
  function track(values, get, v) {
    const n = values.length;
    if (v <= values[0]) return get(0, 1, 0);
    if (v >= values[n - 1]) return get(n - 1, n - 1, 0);
    for (let i = 0; i < n - 1; i++) {
      if (v <= values[i + 1]) {
        const t = (v - values[i]) / (values[i + 1] - values[i]);
        return get(i, i + 1, t);
      }
    }
    return get(n - 1, n - 1, 0);
  }

  class Part {
    constructor(gl, spec, img, step) {
      this.spec = spec;
      this.name = spec.name;
      this.group = spec.group || null;
      this.clip = spec.clip || null;
      this.maskOnly = !!spec.maskOnly;            // only a clip mask for other parts, never drawn              // drawn only inside this part (or group), e.g. iris in eye white
      const [rx, ry, rw, rh] = spec.rect;
      const g = spec.grid;
      this.nx = g.nx; this.ny = g.ny; this.box = g.box;
      this.ncp = (g.nx + 1) * (g.ny + 1);
      // mesh over the texture rect
      const cols = Math.max(1, Math.ceil(rw / step)), rows = Math.max(1, Math.ceil(rh / step));
      const nv = (cols + 1) * (rows + 1);
      this.rest = new Float32Array(nv * 2);
      const uv = new Float32Array(nv * 2);
      // bilinear weights of every vertex on the warp grid: 4 control indices + 4 weights
      this.wi = new Uint32Array(nv * 4);
      this.ww = new Float32Array(nv * 4);
      const [bx0, by0, bx1, by1] = g.box;
      let k = 0;
      for (let r = 0; r <= rows; r++) {
        for (let c = 0; c <= cols; c++, k++) {
          const x = rx + rw * c / cols, y = ry + rh * r / rows;
          this.rest[k * 2] = x; this.rest[k * 2 + 1] = y;
          uv[k * 2] = c / cols; uv[k * 2 + 1] = r / rows;
          const u = Math.min(Math.max((x - bx0) / (bx1 - bx0), 0), 1) * g.nx;
          const v = Math.min(Math.max((y - by0) / (by1 - by0), 0), 1) * g.ny;
          const i = Math.min(Math.floor(u), g.nx - 1), j = Math.min(Math.floor(v), g.ny - 1);
          const fu = u - i, fv = v - j, W = g.nx + 1;
          this.wi.set([j * W + i, j * W + i + 1, (j + 1) * W + i, (j + 1) * W + i + 1], k * 4);
          this.ww.set([(1 - fu) * (1 - fv), fu * (1 - fv), (1 - fu) * fv, fu * fv], k * 4);
        }
      }
      const idx = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const a = r * (cols + 1) + c, b = a + 1, d = a + cols + 1, e = d + 1;
          idx.push(a, b, d, b, e, d);
        }
      }
      this.count = idx.length;
      this.pos = new Float32Array(nv * 2);
      this.cp = new Float32Array(this.ncp * 2);
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      this.posBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.rest, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      const uvBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
      gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    // control displacements and opacity for the current parameters; moves the mesh
    update(gl, params) {
      const cp = this.cp;
      cp.fill(0);
      for (const [id, k] of Object.entries(this.spec.keys)) {
        const v = params[id] ?? 0;
        track(k.values, (a, b, t) => {
          const A = k.disp[a], B = k.disp[b];
          for (let i = 0; i < cp.length; i++) cp[i] += A[i] + (B[i] - A[i]) * t;
        }, v);
      }
      let alpha = 1;
      for (const [id, o] of Object.entries(this.spec.opacity || {})) {
        alpha *= track(o.values, (a, b, t) => o.alpha[a] + (o.alpha[b] - o.alpha[a]) * t, params[id] ?? 0);
      }
      this.alpha = alpha;
      if (alpha <= 0.001) return;
      const n = this.rest.length / 2, wi = this.wi, ww = this.ww, pos = this.pos, rest = this.rest;
      for (let v = 0; v < n; v++) {
        let dx = 0, dy = 0;
        for (let q = 0; q < 4; q++) {
          const c = wi[v * 4 + q], w = ww[v * 4 + q];
          dx += cp[c * 2] * w; dy += cp[c * 2 + 1] * w;
        }
        pos[v * 2] = rest[v * 2] + dx;
        pos[v * 2 + 1] = rest[v * 2 + 1] + dy;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
    }
  }

  class Model {
    constructor(gl, json, parts) {
      this.gl = gl;
      this.json = json;
      this.parts = parts;
      this.params = {};
      for (const p of json.params) this.params[p.id] = p.default ?? 0;
      this.prog = shader(gl, VS, FS);
      this.qprog = shader(gl, QVS, QFS);
      this.uCanvas = gl.getUniformLocation(this.prog, 'uCanvas');
      this.uView = gl.getUniformLocation(this.prog, 'uView');
      this.uAlpha = gl.getUniformLocation(this.prog, 'uAlpha');
      this.uTex = gl.getUniformLocation(this.prog, 'uTex');
      this.uMask = gl.getUniformLocation(this.prog, 'uMask');
      this.uUseMask = gl.getUniformLocation(this.prog, 'uUseMask');
      this.uScreen = gl.getUniformLocation(this.prog, 'uScreen');
      this.masks = {};
      // bound to the mask unit whenever no mask is used, so a mask texture is never read while it is drawn
      this.noMask = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.noMask);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
      this.clipNames = [...new Set(parts.map(p => p.clip).filter(Boolean))];
      this.quad = gl.createVertexArray();
      gl.bindVertexArray(this.quad);
      const qb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, qb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      this.view = [1, 1, 0, 0];
      this.background = [1, 1, 1, 1];
    }

    set(id, v) { this.params[id] = v; }

    // view: zoom (1 = canvas fits), centre in model pixels
    setView(zoom, cx, cy) {
      const [W, H] = this.json.canvas;
      const c = this.gl.canvas;
      const fit = Math.min(c.width / W, c.height / H);
      const sx = W * fit / c.width * zoom, sy = H * fit / c.height * zoom;
      const ox = -((cx / W) * 2 - 1) * sx, oy = ((cy / H) * 2 - 1) * sy;
      this.view = [sx, sy, ox, oy];
    }

    ensureFbo() {
      const gl = this.gl, c = gl.canvas;
      if (this.fbo && this.fboW === c.width && this.fboH === c.height) return;
      this.fboW = c.width; this.fboH = c.height;
      this.fboTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, c.width, c.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    target(name) {
      // an offscreen RGBA texture the size of the canvas (one per name)
      const gl = this.gl, c = gl.canvas;
      let t = this.masks[name];
      if (t && t.w === c.width && t.h === c.height) return t;
      t = { w: c.width, h: c.height, tex: gl.createTexture(), fbo: gl.createFramebuffer() };
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, c.width, c.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return (this.masks[name] = t);
    }

    // masks for clipped parts: the mask part (and the other drawings in its group), composited offscreen
    drawMasks() {
      const gl = this.gl;
      for (const name of this.clipNames) {
        const t = this.target('mask:' + name);
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.blendFunc(gl.ONE, gl.ONE);       // drawings of one part sum to full opacity
        for (const p of this.parts) {
          if ((p.name === name || p.group === name) && p.alpha > 0.001) this.drawPart(p, true);
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    drawPart(p, noMask) {
      const gl = this.gl;
      gl.uniform1f(this.uAlpha, p.alpha);
      const m = !noMask && p.clip && this.masks['mask:' + p.clip];
      gl.uniform1i(this.uUseMask, m ? 1 : 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, m ? m.tex : this.noMask);
      gl.uniform1i(this.uMask, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, p.tex);
      gl.bindVertexArray(p.vao);
      gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_INT, 0);
    }

    draw() {
      const gl = this.gl, c = gl.canvas;
      for (const p of this.parts) p.update(gl, this.params);
      gl.viewport(0, 0, c.width, c.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.clearColor(...this.background);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      const setProg = () => {
        gl.useProgram(this.prog);
        gl.uniform2f(this.uCanvas, ...this.json.canvas);
        gl.uniform4f(this.uView, ...this.view);
        gl.uniform2f(this.uScreen, c.width, c.height);
        gl.uniform1i(this.uTex, 0);
        gl.activeTexture(gl.TEXTURE0);
      };
      setProg();
      if (this.clipNames.length) {
        this.drawMasks();
        gl.viewport(0, 0, c.width, c.height);
      }
      const parts = this.parts;
      for (let i = 0; i < parts.length;) {
        const p = parts[i];
        if (p.maskOnly) { i++; continue; }
        if (!p.group) {
          if (p.alpha > 0.001) {
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            this.drawPart(p);
          }
          i++;
          continue;
        }
        // a group: sum the members (premultiplied * opacity) offscreen, then composite once
        let j = i;
        while (j < parts.length && parts[j].group === p.group) j++;
        const members = parts.slice(i, j).filter(m => m.alpha > 0.001 && !m.maskOnly);
        if (members.length === 1 && members[0].alpha >= 0.999) {
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          this.drawPart(members[0]);
        } else if (members.length) {
          this.ensureFbo();
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.blendFunc(gl.ONE, gl.ONE);
          for (const m of members) this.drawPart(m);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(this.qprog);
          gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
          gl.bindVertexArray(this.quad);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          setProg();
        }
        i = j;
      }
      gl.bindVertexArray(null);
    }
  }

  async function load(canvas, url, opts = {}) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: true });
    if (!gl) throw new Error('WebGL2 not available');
    const json = await (await fetch(url)).json();
    const base = url.replace(/[^/]*$/, '');
    const imgs = await Promise.all(json.parts.map(p => loadImage(base + p.texture)));
    const parts = json.parts.map((p, i) => new Part(gl, p, imgs[i], opts.meshStep || 12));
    return new Model(gl, json, parts);
  }

  global.CapsuleV2 = { load };
})(typeof window !== 'undefined' ? window : globalThis);
