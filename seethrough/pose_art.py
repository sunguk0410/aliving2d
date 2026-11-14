#!/usr/bin/env python3
"""
Study poses with props for a parts PSD (runs in seethrough/.venv).

  image:  python seethrough/pose_art.py image base.psd out.png --pose typing
          OpenAI edits the character's picture (the PSD composite) so only the arms change and the
          props appear (laptop on a desk, notebook and pen, a waving hand). The face is protected.
  merge:  python seethrough/pose_art.py merge base.psd variant.psd out.psd --pose typing
          `variant.psd` is see-through's conversion of that picture. Its arms (handwear) and props
          (objects) are aligned onto the base canvas and added as "handwear@typing" / "objects@typing";
          the editor's engine shows them with poseTyping (and hides the rigged arms).

key: OPENAI_API_KEY or <repo>/.local/openai.json          -> JSON summary on stdout
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import expression_art as ea  # noqa: E402  (load / composite / edit / align helpers)

KEEP = ('Keep the face and its calm expression, eyes open, mouth closed, the hairstyle and hair color exactly the same. '
        'Keep the outfit exactly the same, including the shirt, its sleeves, the necktie and all colors. '
        'Keep the art style, line art, framing, camera angle, position and size of the character exactly the same. '
        'Only the arms and hands change and the new objects appear. Plain white background, no other people.')
POSES = {
    'typing': 'She is typing on a laptop with both hands: a laptop on a small wooden desk at her waist, below the necktie, '
              'both forearms forward, fingers on the keyboard. ',
    'writing': 'She is studying: an open notebook on a small wooden desk at her waist, writing with a pen in her right hand, '
               'her left hand holding the notebook. ',
    'wave': 'She raises one hand beside her face and waves cheerfully, palm toward the viewer; the other arm stays relaxed. ',
}
SIZE = 1024


def protect_face(W, H, layers):
    """Mask (RGBA, SIZE²): transparent = may change. Kept as drawn: the face, and the body down to the
    chest except where the arms are - so the body keeps its size and the new arms meet its shoulders.
    Free: the arms, everything below the chest (props, forearms in front) and the space around the body."""
    face, body, arms = (np.zeros((H, W), bool) for _ in range(3))
    for L in layers:
        if '@' in L['name']:
            continue
        b = ea.base(L['name'])
        a = ea.canvas_alpha(W, H, L) > 32
        if b in ea.STATE_LAYERS:
            continue
        if b in ('face', 'eyewhite', 'irides', 'eyelash', 'eyebrow', 'mouth', 'mouth close', 'nose', 'ears'):
            face |= a
        if b == 'handwear':
            arms |= a
        else:
            body |= a
    fb = ea.bbox(face)
    m = np.zeros((H, W), np.uint8)
    if fb:
        fh = fb[3] - fb[1]
        chest = min(H, int(fb[3] + fh * 1.1))
        keep_body = body.copy()
        keep_body[chest:] = False
        keep_body &= ~(cv2.dilate(arms.astype(np.uint8), np.ones((25, 25), np.uint8)) > 0)
        m[keep_body] = 1
        mx, my = int((fb[2] - fb[0]) * 0.12), int(fh * 0.08)
        m[max(0, fb[1] - my):fb[3] + my, max(0, fb[0] - mx):fb[2] + mx] = 1
    m = cv2.resize(m, (SIZE, SIZE), interpolation=cv2.INTER_NEAREST)
    mask = np.zeros((SIZE, SIZE, 4), np.uint8)
    mask[..., 3] = m * 255
    return mask, fb


def cmd_image(args):
    key = ea.api_key()
    W, H, layers = ea.load(args.base)
    comp = ea.composite(W, H, layers)
    img = Image.fromarray(comp).resize((SIZE, SIZE), Image.LANCZOS)
    mask, _ = protect_face(W, H, layers)
    out = Image.fromarray(ea.over(ea.edit(key, img, Image.fromarray(mask, 'RGBA'), POSES[args.pose] + KEEP), np.asarray(img)))
    if out.size != (SIZE, SIZE):
        out = out.resize((SIZE, SIZE), Image.LANCZOS)
    out.save(args.out)
    return {'pose': args.pose, 'written': True, 'size': [SIZE, SIZE]}


def cmd_merge(args):
    W, H, base = ea.load(args.base)
    w2, h2, var = ea.load(args.variant)
    a = ea.composite(W, H, base)
    b = ea.composite(w2, h2, var)
    b_on = cv2.resize(b, (W, H), interpolation=cv2.INTER_AREA if w2 > W else cv2.INTER_CUBIC)
    # align on the head (protected while drawing, so it matches best)
    m, _ = protect_face(W, H, base)
    keep = (cv2.resize(m[..., 3], (W, H), interpolation=cv2.INTER_NEAREST) > 0).astype(np.uint8)
    if keep.sum() < 1000:
        keep[:] = 1
    ga, gb = (cv2.cvtColor(x, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255 for x in (a, b_on))
    warp = np.eye(2, 3, dtype=np.float32)
    aligned = True
    try:
        _, warp = cv2.findTransformECC(ga, gb, warp, cv2.MOTION_AFFINE, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6), keep, 5)
    except cv2.error:
        aligned = False
    sx, sy = W / w2, H / h2
    taken = []
    for L in var:
        bn = ea.base(L['name'])
        if bn not in ('handwear', 'objects'):
            continue
        full = np.zeros((h2, w2, 4), np.uint8)
        h, w = L['img'].shape[:2]
        x0, y0 = max(0, L['left']), max(0, L['top'])
        x1, y1 = min(w2, L['left'] + w), min(h2, L['top'] + h)
        if x1 <= x0 or y1 <= y0:
            continue
        full[y0:y1, x0:x1] = L['img'][y0 - L['top']:y1 - L['top'], x0 - L['left']:x1 - L['left']]
        full = cv2.resize(full, (W, H), interpolation=cv2.INTER_AREA if sx < 1 else cv2.INTER_CUBIC)
        full = cv2.warpAffine(full, warp, (W, H), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderValue=(0, 0, 0, 0))
        bb = ea.bbox(full[..., 3] > 8)
        if not bb:
            continue
        x0, y0, x1, y1 = bb
        taken.append({'name': ('handwear' if bn == 'handwear' else 'objects') + '@' + args.pose, 'left': x0, 'top': y0,
                      'img': full[y0:y1, x0:x1].copy(), 'opacity': 255})
    if not any(t['name'].startswith('handwear') for t in taken):
        return {'pose': args.pose, 'written': False, 'error': '변환된 그림에서 팔(handwear)을 찾지 못했습니다'}
    # drop an older version of this pose, put the new one just under the front hair
    out = [L for L in base if not L['name'].endswith('@' + args.pose)]
    at = next((i for i, L in enumerate(out) if ea.base(L['name']) == 'front hair'), len(out))
    out = out[:at] + taken + out[at:]
    new = PSDImage.new('RGBA', (W, H))
    for L in out:
        nl = PixelLayer.frompil(Image.fromarray(L['img'], 'RGBA'), new, L['name'], L['top'], L['left'])
        nl.opacity = L['opacity']
        new.append(nl)
    new.save(args.out)
    return {'pose': args.pose, 'written': True, 'aligned': aligned, 'layers': [t['name'] for t in taken]}


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    p1 = sub.add_parser('image')
    p1.add_argument('base')
    p1.add_argument('out')
    p1.add_argument('--pose', required=True, choices=list(POSES))
    p2 = sub.add_parser('merge')
    p2.add_argument('base')
    p2.add_argument('variant')
    p2.add_argument('out')
    p2.add_argument('--pose', required=True, choices=list(POSES))
    args = ap.parse_args(argv)
    try:
        info = cmd_image(args) if args.cmd == 'image' else cmd_merge(args)
    except (RuntimeError, OSError, ValueError, KeyError) as err:
        info = {'written': False, 'error': str(err)[:300]}
    print(json.dumps(info, ensure_ascii=False))
    return 0 if info.get('written') else 1


if __name__ == '__main__':
    sys.exit(main())
