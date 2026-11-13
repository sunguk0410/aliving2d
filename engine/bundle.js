/*!
 * capsule-rig — bundle.js
 * Writes the deployable character bundle. Shared by the editor (browser) and
 * tools/build-bundle.js (Node), so both produce the same files:
 *
 *   rig.json        format "capsule-rig": canvas, anchors, anchorOffsets, settings, layers[]
 *   parts/*.png     one PNG per part (straight alpha, cropped to its bounding box)
 *   reactions.json  expressions / motions / reaction table
 *
 * No DOM. PNG compression takes a deflate function (zlib in Node,
 * CompressionStream in the browser) so pixels are stored losslessly. A canvas
 * would premultiply alpha and lose colour on soft edges.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CapsuleBundle = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FORMAT = 'capsule-rig', VERSION = 1;

  // Pose / expression parameters change every frame (animator, expressions,
  // tracking). Everything else is per-character tuning that the bundle keeps.
  const POSE_KEYS = ['angleX', 'angleY', 'angleZ', 'body', 'eyeOpenL', 'eyeOpenR', 'eyeX', 'eyeY',
    'brow', 'browAngL', 'browAngR', 'browAngSym', 'mouthOpen', 'mouthForm', 'mouthCForm',
    'bangL', 'bangC', 'bangR', 'armY', 'armPos'];

  /** Tuning values that differ from the engine defaults (rig.json "settings"). */
  function tuningSettings(params, defaults) {
    const out = {};
    for (const k in defaults) {
      if (POSE_KEYS.includes(k) || !(k in params)) continue;
      const v = params[k];
      if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v - defaults[k]) > 1e-9) out[k] = Math.round(v * 1000) / 1000;
    }
    return out;
  }

  function safeName(name) { return String(name).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'part'; }
  function partPath(L) { return 'parts/' + String(L.z).padStart(3, '0') + '_' + safeName(L.name) + '.png'; }

  /**
   * rig: Rigger.buildRig output (layers keep `img`).
   * opts.layerState: optional draw order [{z, visible, opacity, depth}] from the editor.
   * opts.settings, opts.anchorOffsets, opts.source: stored as-is.
   */
  function buildManifest(rig, opts) {
    opts = opts || {};
    const byZ = new Map(rig.layers.map(L => [L.z, L]));
    const order = opts.layerState && opts.layerState.length
      ? opts.layerState.filter(s => byZ.has(s.z))
      : rig.layers.map(L => ({ z: L.z }));
    const layers = order.map(s => {
      const L = byZ.get(s.z);
      const out = {
        name: L.name, source: L.source, z: L.z,
        x: L.x, y: L.y, w: L.w, h: L.h,
        depth: s.depth != null ? s.depth : L.depth,
        group: L.group, phys: L.phys, fade: L.fade, side: L.side,
        opacity: s.opacity != null ? s.opacity : L.opacity,
        strands: L.strands, image: partPath(L)
      };
      if (s.visible === false) out.visible = false;
      if (L.unknown) out.unknown = true;
      if (L.synthetic) out.synthetic = true;
      return out;
    });
    return {
      format: FORMAT, version: VERSION,
      source: Object.assign({ builtAt: new Date().toISOString() }, opts.source || {}),
      canvas: { w: rig.canvas.w, h: rig.canvas.h },
      anchors: rig.anchors,
      anchorOffsets: opts.anchorOffsets || {},
      settings: opts.settings || {},
      layers,
      warnings: rig.warnings || [],
      synth: rig.synth || null,
      cleanup: opts.cleanup || null
    };
  }

  // ---------- CRC / PNG / ZIP ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(buf, start) {
    let c = start === undefined ? 0xffffffff : start;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return c;
  }
  const crcDone = c => (c ^ 0xffffffff) >>> 0;
  const ascii = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };
  function concat(parts) {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function be32(v) { return new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]); }

  function pngChunk(type, data) {
    const t = ascii(type);
    return concat([be32(data.length), t, data, be32(crcDone(crc32(data, crc32(t))))]);
  }
  // Rows use the "Sub" filter: much smaller files than no filter, still lossless.
  function pngRaw(img) {
    const w = img.width, h = img.height, d = img.data, stride = w * 4 + 1;
    const raw = new Uint8Array(stride * h);
    for (let y = 0; y < h; y++) {
      const o = y * stride, s = y * w * 4;
      raw[o] = 1;
      for (let x = 0; x < w * 4; x++) raw[o + 1 + x] = (d[s + x] - (x >= 4 ? d[s + x - 4] : 0)) & 255;
    }
    return raw;
  }
  function pngAssemble(img, idat) {
    const ihdr = concat([be32(img.width), be32(img.height), new Uint8Array([8, 6, 0, 0, 0])]);
    return concat([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))]);
  }
  /** img = {width, height, data: RGBA straight alpha}. deflate: zlib-format compressor (sync). */
  function encodePNG(img, deflateSync) { return pngAssemble(img, new Uint8Array(deflateSync(pngRaw(img)))); }
  async function encodePNGAsync(img, deflate) { return pngAssemble(img, new Uint8Array(await deflate(pngRaw(img)))); }

  /** Browser deflate (zlib format) via CompressionStream. */
  async function browserDeflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Store-only ZIP. files = [{name, data: Uint8Array}] -> Uint8Array. */
  function zip(files) {
    const le16 = v => new Uint8Array([v & 255, (v >>> 8) & 255]);
    const le32 = v => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
    const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const local = [], central = []; let offset = 0;
    for (const f of files) {
      const name = enc ? enc.encode(f.name) : ascii(f.name), data = f.data, crc = crcDone(crc32(data));
      const common = [le16(20), le16(0x0800), le16(0), le16(0), le16(0x21), le32(crc), le32(data.length), le32(data.length), le16(name.length), le16(0)];
      const head = concat([le32(0x04034b50)].concat(common, [name]));
      local.push(head, data);
      central.push(concat([le32(0x02014b50), le16(20)].concat(common, [le16(0), le16(0), le16(0), le32(0), le32(offset), name])));
      offset += head.length + data.length;
    }
    const cd = concat(central);
    const end = concat([le32(0x06054b50), le16(0), le16(0), le16(files.length), le16(files.length), le32(cd.length), le32(offset), le16(0)]);
    return concat(local.concat([cd, end]));
  }

  return { FORMAT, VERSION, POSE_KEYS, tuningSettings, partPath, buildManifest, crc32: b => crcDone(crc32(b)), encodePNG, encodePNGAsync, browserDeflate, zip };
});
