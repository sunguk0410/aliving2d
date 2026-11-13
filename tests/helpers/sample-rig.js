'use strict';
// Builds a rig straight from a PSD (same steps as lib/psd-worker.js), so tests
// do not depend on pre-built bundles.
const fs = require('fs');
const path = require('path');
const ag = require('../../lib/ag-psd.min.js');
const Rigger = require('../../lib/rigger.js');
const GP = require('../../lib/genericparts.js');

ag.initializeCanvas(undefined, (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
const OPTS = { useImageData: true, skipThumbnail: true, skipCompositeImageData: true };

function rigFromPsd(file) {
  const bytes = fs.readFileSync(path.resolve(file));
  const psd = ag.readPsd(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), Object.assign({}, OPTS, { skipCompositeImageData: false }));
  Rigger.cleanPsdLayers(psd);
  return Rigger.buildRig(psd, { generic: { eyeL: GP.get('eyeL'), eyeR: GP.get('eyeR'), mouth: GP.get('mouth') } });
}

module.exports = { rigFromPsd };
