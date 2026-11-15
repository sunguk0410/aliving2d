"""
Bundle v2 writer: model.json + parts/*.png for the browser engine (v2/engine/engine.js).

model.json
  version 2, canvas [W, H]
  params  [{id, min, max, default}]
  parts   in draw order (first = bottom):
    name, texture (relative path), rect [x, y, w, h]   where the texture sits on the canvas
    group   parts with the same group are mixed (premultiplied, weighted by opacity) before compositing:
            two drawings of one part at different angles
    grid    {box: [x0, y0, x1, y1], nx, ny}          the warp grid, (ny+1) x (nx+1) control points
    keys    {param: {values: [...], disp: [[dx0, dy0, dx1, dy1, ...] per value]}}   control displacements,
            linear between values, clamped at the ends; parameters add
    opacity {param: {values: [...], alpha: [...]}}  multiplied over parameters (none = 1)

  python v2/py/export_bundle.py <psd> <out dir>        (artisan rule rig, for testing)
"""
import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))

PARAMS = [dict(id='angleX', min=-1, max=1, default=0), dict(id='angleY', min=-1, max=1, default=0),
          dict(id='eyeX', min=-1, max=1, default=0), dict(id='eyeY', min=-1, max=1, default=0),
          dict(id='eyeOpenL', min=0, max=1, default=1), dict(id='eyeOpenR', min=0, max=1, default=1),
          dict(id='eyeSmile', min=0, max=1, default=0),
          dict(id='mouthOpen', min=0, max=1, default=0), dict(id='mouthForm', min=-1, max=1, default=0)]


def part_spec(name, rgba, warp, keys, opacity=None, group=None, clip=None, mask_only=False):
    return dict(name=name, rgba=rgba, warp=warp, keys=keys, opacity=opacity or {}, group=group, clip=clip,
                mask_only=mask_only)


def write(specs, canvas, out, params=PARAMS):
    os.makedirs(os.path.join(out, 'parts'), exist_ok=True)
    H, W = canvas
    parts = []
    for i, s in enumerate(specs):
        a = s['rgba'][..., 3]
        ys, xs = np.nonzero(a > 0.004)
        if len(xs) == 0:
            continue
        x0, y0 = max(0, xs.min() - 1), max(0, ys.min() - 1)
        x1, y1 = min(W, xs.max() + 2), min(H, ys.max() + 2)
        tex = (np.clip(s['rgba'][y0:y1, x0:x1], 0, 1) * 255 + 0.5).astype(np.uint8)
        fn = f'parts/{i:03d}_{s["name"].replace(" ", "_")}.png'
        Image.fromarray(tex, 'RGBA').save(os.path.join(out, fn), optimize=False, compress_level=6)
        w = s['warp']
        keys = {}
        for p, ks in s['keys'].items():
            vals = sorted(ks)
            keys[p] = dict(values=[float(v) for v in vals],
                           disp=[np.round(ks[v].reshape(-1), 2).tolist() for v in vals])
        op = {p: dict(values=[float(v) for v in vs], alpha=[round(float(x), 4) for x in al])
              for p, (vs, al) in s['opacity'].items()}
        parts.append(dict(name=s['name'], texture=fn, rect=[int(x0), int(y0), int(x1 - x0), int(y1 - y0)],
                          group=s['group'], clip=s.get('clip'), maskOnly=bool(s.get('mask_only')), grid=dict(box=[round(w.x0, 2), round(w.y0, 2), round(w.x1, 2), round(w.y1, 2)],
                                                      nx=w.nx, ny=w.ny),
                          keys=keys, opacity=op))
    model = dict(version=2, canvas=[W, H], params=params, parts=parts)
    with open(os.path.join(out, 'model.json'), 'w', encoding='utf-8') as f:
        json.dump(model, f, separators=(',', ':'))
    return model


def from_rig(rig):
    return [part_spec(p.name, p.rgba, p.warp, p.keys, opacity=p.opacity, clip=p.clip, mask_only=p.mask_only) for p in rig.parts]


if __name__ == '__main__':
    from rig import load_psd
    from artisan import build
    import argparse
    ap = argparse.ArgumentParser(description='artisan-rule model -> bundle v2')
    ap.add_argument('psd')
    ap.add_argument('out')
    ap.add_argument('--src', help='the picture the PSD was made from')
    ap.add_argument('--mouth-open', help='the same picture with the mouth open (AI)')
    ap.add_argument('--smile-eyes', help='the same picture with smiling closed eyes ^ ^ (AI)')
    a = ap.parse_args()
    rig = load_psd(a.psd, grid=60)
    build(rig, mouth_src=a.src, mouth_open=a.mouth_open, smile_eyes=a.smile_eyes)
    m = write(from_rig(rig), rig.size, a.out)
    print(len(m['parts']), 'parts ->', a.out)
