'use strict';
// engine/bundle.js: lossless PNG, valid ZIP, manifest from editor state.
const assert = require('assert');
const zlib = require('zlib');
const Bundle = require('../engine/bundle.js');
const Core = require('../engine/core.js');

// --- PNG round trip (decode IDAT, undo the Sub filter, compare every byte) ---
function decodePNG(buf) {
  assert.deepStrictEqual([...buf.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let o = 8, w = 0, h = 0; const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8), data = buf.slice(o + 8, o + 8 + len);
    assert.strictEqual(buf.readUInt32BE(o + 8 + len), Bundle.crc32(buf.slice(o + 4, o + 8 + len)), type + ' crc');
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); assert.strictEqual(data[8], 8); assert.strictEqual(data[9], 6); }
    if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), out = new Uint8Array(w * h * 4), stride = w * 4 + 1;
  for (let y = 0; y < h; y++) {
    assert.strictEqual(raw[y * stride], 1, 'Sub filter');
    for (let x = 0; x < w * 4; x++) out[y * w * 4 + x] = (raw[y * stride + 1 + x] + (x >= 4 ? out[y * w * 4 + x - 4] : 0)) & 255;
  }
  return { width: w, height: h, data: out };
}
const img = { width: 37, height: 11, data: new Uint8ClampedArray(37 * 11 * 4) };
let s = 7; for (let i = 0; i < img.data.length; i++) { s = (s * 16807) % 2147483647; img.data[i] = s & 255; }
const png = Buffer.from(Bundle.encodePNG(img, raw => zlib.deflateSync(raw)));
const back = decodePNG(png);
assert.strictEqual(back.width, 37); assert.strictEqual(back.height, 11);
assert.deepStrictEqual([...back.data], [...img.data], 'PNG must be lossless (straight alpha kept)');

// --- ZIP: local headers, central directory and CRCs agree ---
const files = [{ name: 'rig.json', data: new TextEncoder().encode('{"a":1}') }, { name: 'parts/000_face.png', data: new Uint8Array(png) }];
const z = Buffer.from(Bundle.zip(files));
const eocd = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
assert.ok(eocd > 0);
assert.strictEqual(z.readUInt16LE(eocd + 10), 2);
let cd = z.readUInt32LE(eocd + 16);
for (const f of files) {
  assert.strictEqual(z.readUInt32LE(cd), 0x02014b50);
  const nameLen = z.readUInt16LE(cd + 28), name = z.toString('utf8', cd + 46, cd + 46 + nameLen);
  const off = z.readUInt32LE(cd + 42), size = z.readUInt32LE(cd + 20), crc = z.readUInt32LE(cd + 16);
  assert.strictEqual(name, f.name);
  const dataAt = off + 30 + z.readUInt16LE(off + 26);
  const data = z.slice(dataAt, dataAt + size);
  assert.deepStrictEqual([...data], [...f.data]); assert.strictEqual(crc, Bundle.crc32(data));
  cd += 46 + nameLen;
}

// --- manifest: editor order / visibility / depth, tuning-only settings ---
const rig = {
  canvas: { w: 100, h: 100 }, warnings: [],
  anchors: {
    face: { cx: 50, cy: 30, x0: 35, x1: 65, y0: 15, y1: 48 }, mouth: { x0: 46, x1: 54, y0: 40, y1: 43, cx: 50, cy: 41 },
    neckPivot: { cx: 50, cy: 57 }, neckTop: 48, neckBottom: 60, bodyPivot: { cx: 50, cy: 100 }, faceScale: 0.1, hairRootY: 30
  },
  layers: [{ name: 'face', z: 0, x: 0, y: 0, w: 1, h: 1, depth: 1, opacity: 1 }, { name: 'front hair', z: 1, x: 0, y: 0, w: 1, h: 1, depth: 1.28, opacity: 1 }]
};
const m = Bundle.buildManifest(rig, {
  layerState: [{ z: 1, visible: true, opacity: 0.5, depth: 1.1 }, { z: 0, visible: false, opacity: 1, depth: 1 }],
  settings: Bundle.tuningSettings(Object.assign({}, Core.DEFAULTS, { physAmp: 1.25, angleX: 0.8, mouthCForm: -1 }), Core.DEFAULTS),
  anchorOffsets: { mouth: { dy: 3 } }
});
assert.deepStrictEqual(m.layers.map(L => L.z), [1, 0]);
assert.strictEqual(m.layers[0].depth, 1.1); assert.strictEqual(m.layers[0].opacity, 0.5);
assert.strictEqual(m.layers[1].visible, false);
assert.strictEqual(m.layers[0].image, 'parts/001_front_hair.png');
assert.deepStrictEqual(m.settings, { physAmp: 1.25 }, 'pose and expression values must not be baked into settings');
assert.deepStrictEqual(m.anchorOffsets, { mouth: { dy: 3 } });
// the player model honours the exported state
const M = Core.createModel(Object.assign({}, rig, m));
assert.strictEqual(M.layers[1].visible, false);
assert.deepStrictEqual(M.anchorOffsets, { mouth: { dy: 3 } });
console.log('ok bundle: lossless PNG, valid ZIP, manifest keeps editor state');
