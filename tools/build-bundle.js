#!/usr/bin/env node
'use strict';
/**
 * PSD -> Capsule character bundle
 *
 *   node tools/build-bundle.js <input.psd> <outDir> [--reactions reactions.json] [--settings model.rig.json]
 *
 * --settings takes the editor's settings JSON ("설정 파일 저장" in the check tab) and applies its
 * tuning parameters, anchor offsets and layer visibility / opacity / depth / order.
 * The editor's "Capsule bundle" export writes the same files directly.
 *
 * outDir/
 *   rig.json        layers, anchors, canvas size, default settings
 *   parts/*.png     one PNG per part (cropped to its bounding box)
 *   reactions.json  expressions / motions / reaction table (copied from template if missing)
 *
 * Rigging is done once here, so the player never parses PSDs at runtime.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const agPsd = require(path.join(ROOT, 'lib/ag-psd.min.js'));
const Rigger = require(path.join(ROOT, 'lib/rigger.js'));
const RT = require(path.join(ROOT, 'lib/runtime.js'));
const zlib = require('zlib');
const Bundle = require(path.join(ROOT, 'engine/bundle.js'));
const Core = require(path.join(ROOT, 'engine/core.js'));

agPsd.initializeCanvas(undefined, (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
const PSD_OPTS = { useImageData: true, skipThumbnail: true, skipCompositeImageData: true };

function readPsd(file, extra) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { ab, psd: agPsd.readPsd(new Uint8Array(ab), Object.assign({}, PSD_OPTS, extra || {})) };
}

// Generic closed-eye / closed-mouth parts: tools/*.psd first, built-in data otherwise
// (same priority as the original app).
function genericParts() {
  const g = {};
  try {
    const sb = { self: {}, atob };
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib/genericparts.js'), 'utf8'), sb);
    const GP = sb.self.GenericParts;
    g.eyeL = GP.get('eyeL'); g.eyeR = GP.get('eyeR'); g.mouth = GP.get('mouth');
  } catch (err) { /* ignore */ }
  const grab = name => {
    const f = path.join(ROOT, name);
    if (!fs.existsSync(f)) return null;
    try { return Rigger.flattenPsdToImg(readPsd(f).psd); } catch (err) { return null; }
  };
  const eye = grab('eye_close.psd'), mouth = grab('mouth_close.psd');
  if (eye) { const s = Rigger.splitImgLR(eye); if (s) { g.eyeL = s.l; g.eyeR = s.r; } }
  if (mouth) g.mouth = mouth;
  return (g.eyeL || g.mouth) ? g : null;
}

function safe(name) { return String(name).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'part'; }

/** Editor settings JSON (format anime25d-settings) -> bundle overrides. */
function editorState(file, rig) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ids = rig.layers.map(L => String(L.z) + ':' + L.name);
  const data = RT.settings(value, value.modelId, Core.RANGES, ids, Core.DEFAULTS,
    { anyModel: true, anchorLimit: Math.max(rig.canvas.w, rig.canvas.h) });
  const rec = new Map(data.layers.map(r => [r.id, r]));
  const order = RT.mergeLayerOrder(ids, data.layers.map(r => r.id));
  const layerState = order.map(id => {
    const r = rec.get(id), z = Number(id.slice(0, id.indexOf(':')));
    return r ? { z, visible: r.visible, opacity: r.opacity, depth: r.depth } : { z };
  });
  return { layerState, settings: Bundle.tuningSettings(data.params, Core.DEFAULTS), anchorOffsets: data.anchors };
}

function build(input, outDir, opts) {
  opts = opts || {};
  const { ab } = readPsd(input, { skipLayerImageData: true });
  RT.validateHeader(ab);
  Rigger.validatePsd(agPsd.readPsd(new Uint8Array(ab), Object.assign({}, PSD_OPTS, { skipLayerImageData: true })));
  const psd = agPsd.readPsd(new Uint8Array(ab), Object.assign({}, PSD_OPTS, { skipCompositeImageData: false }));
  const pre = Rigger.cleanPsdLayers(psd);
  const rig = Rigger.buildRig(psd, { generic: genericParts() });

  fs.mkdirSync(path.join(outDir, 'parts'), { recursive: true });
  for (const f of fs.readdirSync(path.join(outDir, 'parts'))) fs.unlinkSync(path.join(outDir, 'parts', f));

  const edit = opts.settings ? editorState(opts.settings, rig) : {};
  const bundle = Bundle.buildManifest(rig, {
    source: { file: path.basename(input), fingerprint: RT.fingerprint(ab), tool: 'build-bundle' },
    layerState: edit.layerState, anchorOffsets: edit.anchorOffsets, cleanup: pre,
    // models with skin eyelids close their eyes with them by default (editor does the same)
    settings: Object.assign(rig.layers.some(L => L.fade === 'eyeLid') ? { eyeLid: 1 } : {}, edit.settings || {})
  });
  const deflate = raw => zlib.deflateSync(raw, { level: 9 });
  const byZ = new Map(rig.layers.map(L => [L.z, L]));
  for (const L of bundle.layers) fs.writeFileSync(path.join(outDir, L.image), Bundle.encodePNG(byZ.get(L.z).img, deflate));
  fs.writeFileSync(path.join(outDir, 'rig.json'), JSON.stringify(bundle, null, 1));

  const reactionsOut = path.join(outDir, 'reactions.json');
  const template = opts.reactions || path.join(ROOT, 'engine/reactions.default.json');
  if (opts.reactions || !fs.existsSync(reactionsOut)) fs.copyFileSync(template, reactionsOut);

  return bundle;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--reactions') opts.reactions = args[++i];
    else if (args[i] === '--settings') opts.settings = args[++i];
    else pos.push(args[i]);
  }
  if (pos.length < 2) {
    console.error('usage: node tools/build-bundle.js <input.psd> <outDir> [--reactions reactions.json] [--settings model.rig.json]');
    process.exit(1);
  }
  const t0 = Date.now();
  const b = build(pos[0], pos[1], opts);
  console.log('built ' + pos[1] + ': ' + b.layers.length + ' parts, ' + b.canvas.w + 'x' + b.canvas.h + ' (' + (Date.now() - t0) + ' ms)');
  for (const w of b.warnings) console.log('  ! ' + w);
}

module.exports = { build };
