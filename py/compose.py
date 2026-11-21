"""
One model from one base illustration split twice (the artisan's single large drawing, approximated):

  body PSD   see-through on the whole waist-up base picture: body, arms, neck, clothes, back hair, long hair
  head PSD   see-through on a square crop of the same picture around the head, enlarged: the face in detail

The face (everything `artisan.build` makes: eyes, gaze, blink, smile eyes, mouth) comes from the head PSD and
keeps its full-resolution textures; it is placed on the body canvas by the crop's position and scale
(export_bundle xf). The bangs come from the head too, faded out toward the crop's edges, where the body PSD's
front hair takes over - both come from the same picture, so they line up.

  python py/compose.py <body psd> <base png> <head psd> <head box json> <head png> <out dir> [--mouth-open P] [--smile-eyes P]
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image
from psd_tools import PSDImage

sys.path.insert(0, os.path.dirname(__file__))
from rig import load_psd  # noqa: E402
from artisan import build, turn_disp, nod_disp, ORDER  # noqa: E402
from export_bundle import part_spec, write, PARAMS  # noqa: E402
from body_rig import BODY_PARAMS, frame, add_body_keys, drive_physics  # noqa: E402
from face_expr import EXPR_PARAMS  # noqa: E402

HEAD_BASES = {'face', 'ears', 'earwear', 'nose', 'mouth', 'mouthmask', 'mouth_inner', 'mouth_upper', 'mouth_lower',
              'eyewhite', 'irides', 'pupil', 'highlight', 'highlight2', 'eyemask', 'eyelid', 'eyelid_low',
              'lash_upper', 'lash_lower', 'lash_crease', 'eyelash', 'smileeye', 'eyebrow', 'eyewear', 'front hair',
              'headwear', 'fx blush', 'fx gloom', 'fx tears', 'fx sweat', 'fx anger',
              'fx heart', 'fx sparkle'}
BODY_NAMES = ['back hair', 'topwear', 'bottomwear', 'handwear', 'neck', 'neckwear', 'objects', 'front hair']
BODY_SKIP = {'head', 'tail', 'wings', 'footwear', 'legwear'}


def base_name(n):
    return n.rsplit('_', 1)[0] if n.endswith(('_l', '_r')) else n


def psd_map(psd_size, img_size):
    """see-through pads a picture to a square and scales it: picture (x, y) -> PSD (s x + ox, s y + oy)."""
    P = psd_size
    w, h = img_size
    s = P / max(w, h)
    return s, (P - w * s) / 2, (P - h * s) / 2


def head_box(body_psd_path, img_size):
    """Square crop around the head in picture coordinates, from the body PSD's face layer: the face plus the
    hair above it and a little neck, like the crop that worked in experiment 0."""
    psd = PSDImage.open(body_psd_path)
    s, ox, oy = psd_map(psd.width, img_size)
    for l in psd.descendants():
        if l.name == 'face':
            a = np.asarray(l.topil().convert('RGBA'))[..., 3]
            ys, xs = np.nonzero(a > 128)
            fx0, fx1 = (xs.min() + l.left - ox) / s, (xs.max() + l.left - ox) / s
            fy0, fy1 = (ys.min() + l.top - oy) / s, (ys.max() + l.top - oy) / s
            break
    else:
        raise RuntimeError('몸 PSD에 얼굴 레이어가 없습니다')
    fh = fy1 - fy0
    S = int(round(max(1.45 * fh, 1.9 * (fx1 - fx0))))
    cx = (fx0 + fx1) / 2
    x0 = int(round(cx - S / 2))
    y0 = int(round(fy0 - 0.25 * fh))
    w, h = img_size
    x0 = max(0, min(w - S, x0))
    y0 = max(0, min(h - S, y0))
    return dict(x0=x0, y0=y0, size=min(S, w, h))


def crop_head(base_png, box, out_png, target=1280):
    """The head square, enlarged with the anime upscaler toward `target` px. 1280 = see-through's own size: a bigger
    picture gives the same 1280 layers and only makes its depth step (which runs at the input size) slow and
    memory-hungry."""
    import upscale
    im = Image.open(base_png).convert('RGB')
    c = im.crop((box['x0'], box['y0'], box['x0'] + box['size'], box['y0'] + box['size']))
    big = upscale.upscale(c, 4) if c.width * 2 < target else upscale.upscale(c, 2)
    big.resize((target, target), Image.LANCZOS).save(out_png)
    upscale.unload()


def edge_weight(H, W, x0, y0, x1, y1, feather_x, feather_bottom):
    """1 inside the box, ramping to 0 over `feather` px toward its left, right and bottom edges (the top of the
    crop is above the hair anyway)."""
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    wx = np.clip(np.minimum(xx - x0, x1 - xx) / max(1.0, feather_x), 0, 1)
    wy = np.clip((y1 - yy) / max(1.0, feather_bottom), 0, 1) * (yy >= y0)
    return (wx * wy).astype(np.float32)


def compose(body_psd, base_png, head_psd, box, head_png, out, mouth_open=None, smile_eyes=None, ears=True, extras=(), ears_covered=None,
            ears_split=None):
    img_size = Image.open(base_png).size
    # --- the head: the whole face rig, on its own (finer) canvas
    head = load_psd(head_psd, grid=60)
    L, R, D = build(head, mouth_src=head_png, mouth_open=mouth_open, smile_eyes=smile_eyes, ears=ears, extras=extras,
                     ears_covered=ears_covered, ears_split=ears_split)
    Hh = head.size[0]
    body = load_psd(body_psd, grid=60, skip=BODY_SKIP)
    from source_paint import paint_from_source
    from artisan import order_rank
    from source_paint import uncover
    uncover(body, base_png)
    paint_from_source(body, base_png, order_rank)
    from source_paint import shade_hidden
    shade_hidden(body, base_png, order_rank)
    from source_paint import clear_fringe
    clear_fringe(body, base_png)
    s, bx, by = psd_map(body.size[1], img_size)
    k = s * box['size'] / Hh                          # head canvas -> body canvas
    ox, oy = bx + s * box['x0'], by + s * box['y0']
    xf = (k, ox, oy)
    # head landmarks on the body canvas, for the body's hair and neck
    Lb = dict(L)
    for key in ('cx',):
        Lb[key] = ox + k * L[key]
    for key in ('eye_y', 'chin_y', 'top_y'):
        Lb[key] = oy + k * L[key]
    Lb['half'] = k * L['half']
    Rb, Db = k * R, k * D

    # the crop on each canvas, for handing the bangs over from the head to the body
    Hb, Wb = body.size
    feather_h = 0.12 * Hh
    head_w = edge_weight(Hh, Hh, 0, 0, Hh, Hh, feather_h, 0.2 * Hh)
    c0x, c0y, c1x, c1y = ox, oy, ox + k * Hh, oy + k * Hh
    body_in = edge_weight(Hb, Wb, c0x, c0y, c1x, c1y, feather_h * k, 0.2 * Hh * k)

    # the body's hair sways too (its own sway parameters)
    from hair_rig import add_hair_sway
    from arm_rig import add_arms, ARM_PARAMS
    from cloth_rig import add_skirt_sway, hand_lag_physics
    if 'physics' in extras:
        add_hair_sway(body, Lb, Rb, prefix='b')
        add_skirt_sway(body, Rb)
    # the arms: shoulder and elbow rotation deformers (arm_rig.py)
    arms = add_arms(body, Lb['cx']) if 'arms' in extras else None
    specs = []

    def body_spec(p):
        z = np.zeros_like(p.warp.rest)
        keys = dict(p.keys)
        if p.name in ('back hair', 'front hair', 'neck', 'neckwear', 'headwear'):
            keys['angleX'] = {-1.0: turn_disp(p, Lb, -20.0, Rb, Db), 0.0: z, 1.0: turn_disp(p, Lb, 20.0, Rb, Db)}
            keys['angleY'] = {-1.0: nod_disp(p, Lb, -14.0, Rb, Db), 0.0: z, 1.0: nod_disp(p, Lb, 14.0, Rb, Db)}
        return part_spec(p.name + '@body' if p.name == 'front hair' else p.name, p.rgba, p.warp, keys,
                         bones=getattr(p, 'bones', None))

    # body below the head (in the artisan order), then the whole head block, then the long front hair
    rank = lambda n: ORDER.index(base_name(n)) if base_name(n) in ORDER else len(ORDER)
    head_first = rank('ears')
    for p in sorted((p for p in body.parts if p.name != 'front hair'), key=lambda p: rank(p.name)):
        if rank(p.name) < head_first or base_name(p.name) in ('topwear', 'bottomwear', 'handwear', 'objects'):
            specs.append(body_spec(p))
    for p in head.parts:
        if base_name(p.name) not in HEAD_BASES:
            continue
        rgba = p.rgba
        if p.name == 'front hair':
            rgba = p.rgba.copy()
            rgba[..., 3] *= head_w
        specs.append(part_spec(p.name, rgba, p.warp, p.keys, p.opacity, None, p.clip, p.mask_only, xf))
    for p in body.parts:
        if p.name != 'front hair':
            continue
        p.rgba = p.rgba.copy()
        p.rgba[..., 3] *= (1 - body_in)
        if (p.rgba[..., 3] > 0.3).sum() > 30:
            specs.append(body_spec(p))
    # body angle X / Y / Z and breathing on every part, the head riding on the body
    if 'body' in extras:
        add_body_keys(specs, frame(body.parts, Lb, body.size), Rb)
    physics = drive_physics(list(getattr(head, 'physics', [])) + list(getattr(body, 'physics', [])))
    if 'physics' in extras:
        physics += hand_lag_physics(arms)
    model = write(specs, body.size, out, params=PARAMS + EXPR_PARAMS + BODY_PARAMS + (ARM_PARAMS if arms else []),
                  physics=physics, arms=arms, extras=extras)
    return model, dict(k=k, ox=ox, oy=oy, head_parts=sum(1 for s_ in specs if s_.get('xf')))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    for a in ('body_psd', 'base_png', 'head_psd', 'box', 'head_png', 'out'):
        ap.add_argument(a)
    ap.add_argument('--mouth-open')
    ap.add_argument('--smile-eyes')
    ap.add_argument('--extras', default='', help='comma list of artisan.EXTRAS')
    a = ap.parse_args()
    box = json.load(open(a.box)) if os.path.exists(a.box) else json.loads(a.box)
    m, info = compose(a.body_psd, a.base_png, a.head_psd, box, a.head_png, a.out, a.mouth_open, a.smile_eyes,
                      extras=[x for x in a.extras.split(',') if x])
    print(len(m['parts']), 'parts', json.dumps(info))
