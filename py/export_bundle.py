"""
Bundle v2 writer: model.json + parts/*.png for the browser engine (engine/engine.js).

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
    bones   [{arm, joint: 'el' | 'sh', w: [per control point]}]  rotations about the arm's joints (arm_rig.py),
            elbow first then shoulder, angles from the arm IK of arm<s>X / arm<s>Y
  arms    {L|R: {S, E, W: [x, y], out}}  rest joints of each arm (engine.js solveArm)
  expressions  [{name, label, file, params}]  parameter values over the defaults (face_expr.py), also written
               as expressions/<name>.exp3.json
  motions      [{name, label, group, file, duration, loop, curves: {param: [[t, v], ...]}}]  (motions.py), also
               motions/<name>.motion3.json

  python py/export_bundle.py <psd> <out dir>        (artisan rule rig, for testing)
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


def part_spec(name, rgba, warp, keys, opacity=None, group=None, clip=None, mask_only=False, xf=None, bones=None):
    """xf = (k, ox, oy): the part's own canvas -> the model canvas (x' = ox + k x). A part drawn on a finer canvas
    (the face from the head close-up) keeps its texture at full resolution; only its place and motion scale."""
    return dict(name=name, rgba=rgba, warp=warp, keys=keys, opacity=opacity or {}, group=group, clip=clip,
                mask_only=mask_only, xf=xf, bones=bones)


def write(specs, canvas, out, params=PARAMS, physics=None, arms=None, extras=('presets',)):
    """physics: hair pendulums (hair_rig.py); their output parameters are added as hidden parameters.
    Parameters no part, physics entry or arm uses are left out (no slider that does nothing).
    Expressions: the user's own (expressions.user.json, saved from the viewer) and, with 'presets' in extras,
    face_expr.EXPRESSIONS under them."""
    physics = physics or []
    used = {pid for s in specs for pid in list(s['keys']) + list(s.get('opacity') or {})}
    used |= {e['param'] for e in physics} | {i for e in physics for i in e.get('inputs', {})}
    if arms:
        used |= {f'arm{s}{a}' for s in arms for a in 'XY'} | {f'hand{s}' for s in arms}
    params = [p for p in params if p['id'] in used]
    params = list(params) + [dict(id=p['param'], min=-1, max=1, default=0, hidden=True) for p in physics]
    os.makedirs(os.path.join(out, 'parts'), exist_ok=True)
    H, W = canvas
    parts = []
    for i, s in enumerate(specs):
        k, ox, oy = s.get('xf') or (1.0, 0.0, 0.0)
        H, W = s['rgba'].shape[:2]
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
                           disp=[np.round(ks[v].reshape(-1) * k, 3).tolist() for v in vals])
        op = {p: dict(values=[float(v) for v in vs], alpha=[round(float(x), 4) for x in al])
              for p, (vs, al) in s['opacity'].items()}
        X = lambda x: round(ox + k * float(x), 3)
        Y = lambda y: round(oy + k * float(y), 3)
        parts.append(dict(name=s['name'], texture=fn, rect=[X(x0), Y(y0), round(k * (x1 - x0), 3), round(k * (y1 - y0), 3)],
                          group=s['group'], clip=s.get('clip'), maskOnly=bool(s.get('mask_only')),
                          grid=dict(box=[X(w.x0), Y(w.y0), X(w.x1), Y(w.y1)], nx=w.nx, ny=w.ny),
                          keys=keys, opacity=op))
        if s.get('bones'):                                 # arm rotation deformers (arm_rig.py; model canvas parts)
            parts[-1]['bones'] = [dict(arm=b['arm'], joint=b['joint'], w=np.round(b['w'].reshape(-1), 3).tolist())
                                  for b in s['bones']]
    model = dict(version=2, canvas=[canvas[1], canvas[0]], params=params, parts=parts, physics=physics)
    if arms:
        model['arms'] = arms
    # expressions (face_expr.py): in model.json for the viewer, and one Live2D-style .exp3.json per expression
    # for the CAPSULE contract ({name, file})
    from face_expr import EXPRESSIONS, VOWELS
    ids = {p['id'] for p in params}
    if 'mouthWide' in ids:
        model['vowels'] = VOWELS
    table = dict(EXPRESSIONS) if 'presets' in extras else {}
    table.update(user_expressions())
    if table:
        os.makedirs(os.path.join(out, 'expressions'), exist_ok=True)
        model['expressions'] = []
        for name, (label, vals) in table.items():
            vals = {k: v for k, v in vals.items() if k in ids}
            fn = f'expressions/{name}.exp3.json'
            with open(os.path.join(out, fn), 'w', encoding='utf-8') as f:
                json.dump({'Type': 'Live2D Expression', 'FadeInTime': 0.3, 'FadeOutTime': 0.3,
                           'Parameters': [{'Id': k, 'Value': v, 'Blend': 'Overwrite'} for k, v in vals.items()]},
                          f, ensure_ascii=False, indent=1)
            model['expressions'].append(dict(name=name, label=label, file=fn, params=vals))
    # motions (motions.py): Live2D motion3 files + curves in model.json for the viewer
    from motions import write_motions
    model['motions'] = write_motions(out, ids, bool(arms))
    with open(os.path.join(out, 'model.json'), 'w', encoding='utf-8') as f:
        json.dump(model, f, separators=(',', ':'))
    return model


USER_EXPR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'expressions.user.json')


def user_expressions():
    """{name: (label, {param: value})} saved from the viewer (serve.py POST /api/expressions)."""
    try:
        with open(USER_EXPR, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return {n: (e.get('label') or n, {k: float(v) for k, v in e.get('params', {}).items()})
            for n, e in data.get('expressions', {}).items()}


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
    ap.add_argument('--no-ears', action='store_true', help='leave the ears out (hidden under the hair)')
    ap.add_argument('--extras', default='', help='comma list of artisan.EXTRAS (physics, fx, presets)')
    a = ap.parse_args()
    extras = [x for x in a.extras.split(',') if x]
    rig = load_psd(a.psd, grid=60)
    build(rig, mouth_src=a.src, mouth_open=a.mouth_open, smile_eyes=a.smile_eyes, ears=not a.no_ears, extras=extras)
    from face_expr import EXPR_PARAMS
    m = write(from_rig(rig), rig.size, a.out, params=PARAMS + EXPR_PARAMS, physics=getattr(rig, 'physics', []),
              extras=extras)
    print(len(m['parts']), 'parts ->', a.out)
