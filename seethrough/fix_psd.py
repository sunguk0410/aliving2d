#!/usr/bin/env python3
"""
Clean up a see-through PSD against the picture it came from (runs in seethrough/.venv).

see-through paints every part complete, including what is hidden (the back of a
collar behind the neck, the white of the eye under the iris), and stacks parts by
estimated depth. When that order is wrong for a spot, the hidden painting of an
upper part covers what the picture actually shows there: the neck disappears
behind the shirt, the eyes go blank.

Fix: wherever an upper part and a lower part overlap and the picture clearly
shows the LOWER part (its colours match, the upper part's do not), erase that
spot from the upper part. What the upper part really covers (the front collar)
stays. The face's small parts (eyes, brows, mouth, nose) are left to the rigger,
which orders them itself (the eye white is the iris clipping mask).

  python seethrough/fix_psd.py in.psd src_img.png out.psd   -> JSON summary
"""
import json
import sys

import cv2
import numpy as np
from PIL import Image
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer

KEEP = ('eyewhite', 'irides', 'eyelash', 'eyebrow', 'mouth', 'nose', 'eyes')   # never erased from
OPAQUE = 200
ERR_UPPER, ERR_LOWER, ERR_GAP = 16, 14, 9      # mean |rgb - picture| per pixel (a light grey collar over skin is ~20)
HAIR = ('hair', 'back hair', 'front hair', 'side hair', 'ahoge')   # strands see-through misfiles: never a reason to erase
MIN_REGION = 80          # overlap worth checking
MIN_ERASE = 500          # at 1280 px: erase only solid regions (a strip of neck), not scattered bits


def base(name):
    return name.strip().lower().split('-')[0].rstrip('0123456789 _')


def fix(psd_path, src_path, out_path):
    psd = PSDImage.open(psd_path)
    W, H = psd.size
    src = Image.open(src_path).convert('RGB')
    if src.size != (W, H):
        src = src.resize((W, H), Image.LANCZOS)
    src = np.asarray(src).astype(np.int16)
    layers = []
    for l in psd:
        if l.is_group():
            continue
        im = np.array(l.topil().convert('RGBA'))
        layers.append({'name': l.name, 'left': l.left, 'top': l.top, 'img': im, 'opacity': l.opacity})

    def canvas_box(L):
        h, w = L['img'].shape[:2]
        return L['left'], L['top'], L['left'] + w, L['top'] + h

    min_erase = MIN_ERASE * (max(W, H) / 1280) ** 2
    erased = {}
    for j, U in enumerate(layers):
        if base(U['name']).startswith(KEEP):
            continue
        ux0, uy0, ux1, uy1 = canvas_box(U)
        kill = np.zeros(U['img'].shape[:2], bool)
        # Spots that a part above U covers show that part, not U or what is under it:
        # leave U alone there (e.g. front hair over the shirt must not open the shirt to the back hair).
        above = np.zeros(U['img'].shape[:2], bool)
        for A in layers[j + 1:]:
            ax0, ay0, ax1, ay1 = canvas_box(A)
            x0, y0, x1, y1 = max(ux0, ax0), max(uy0, ay0), min(ux1, ax1), min(uy1, ay1)
            if x1 > x0 and y1 > y0:
                above[y0 - uy0:y1 - uy0, x0 - ux0:x1 - ux0] |= A['img'][y0 - ay0:y1 - ay0, x0 - ax0:x1 - ax0, 3] > 24
        for i in range(j):
            Lw = layers[i]
            if base(Lw['name']) in HAIR:
                continue
            lx0, ly0, lx1, ly1 = canvas_box(Lw)
            x0, y0, x1, y1 = max(ux0, lx0, 0), max(uy0, ly0, 0), min(ux1, lx1, W), min(uy1, ly1, H)
            if x1 - x0 < 4 or y1 - y0 < 4:
                continue
            u = U['img'][y0 - uy0:y1 - uy0, x0 - ux0:x1 - ux0].astype(np.int16)
            lo = Lw['img'][y0 - ly0:y1 - ly0, x0 - lx0:x1 - lx0].astype(np.int16)
            both = (u[..., 3] > OPAQUE) & (lo[..., 3] > OPAQUE)
            if both.sum() < MIN_REGION:
                continue
            s = src[y0:y1, x0:x1]
            eu = np.abs(u[..., :3] - s).mean(-1)
            el = np.abs(lo[..., :3] - s).mean(-1)
            m = both & (eu > ERR_UPPER) & (el < ERR_LOWER) & (eu - el > ERR_GAP) & ~above[y0 - uy0:y1 - uy0, x0 - ux0:x1 - ux0]
            if m.sum() < MIN_REGION:
                continue
            kill[y0 - uy0:y1 - uy0, x0 - ux0:x1 - ux0] |= m
        if not kill.any():
            continue
        k = cv2.morphologyEx(kill.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        n, lab, stats, _ = cv2.connectedComponentsWithStats(k, connectivity=8)
        keep = np.zeros(n, bool)
        keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= min_erase
        k = keep[lab].astype(np.uint8)
        if not k.any():
            continue
        k = cv2.dilate(k, np.ones((3, 3), np.uint8))
        soft = cv2.GaussianBlur(k.astype(np.float32), (5, 5), 0)
        a = U['img'][..., 3].astype(np.float32) * (1 - np.clip(soft * 1.5, 0, 1))
        U['img'][..., 3] = a.astype(np.uint8)
        erased[U['name']] = int(k.sum())

    if erased:
        new = PSDImage.new('RGBA', (W, H))   # RGB would drop the layers' transparency
        for L in layers:
            nl = PixelLayer.frompil(Image.fromarray(L['img'], 'RGBA'), new, L['name'], L['top'], L['left'])
            nl.opacity = L['opacity']
            new.append(nl)
        new.save(out_path)
    return {'erased': erased, 'written': bool(erased)}


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('usage: fix_psd.py in.psd src_img.png out.psd')
    print(json.dumps(fix(*sys.argv[1:]), ensure_ascii=False))
