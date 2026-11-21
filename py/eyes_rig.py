"""
Gaze for a rig: per eye, the iris layer becomes a whole iris (hidden part filled, eye_parts.py), a pupil and
highlights, all clipped to that eye's white, with keyforms for eyeX / eyeY.

  iris, pupil   move by up to 0.45 iris radius across, 0.30 up/down
  highlights    move half as much (they mirror the light, not the eyeball)
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from eye_parts import eye_parts  # noqa: E402
from rig import Part  # noqa: E402


def full(crop, box, size):
    H, W = size
    out = np.zeros((H, W, 4), np.float32)
    x0, y0, x1, y1 = box
    out[y0:y1, x0:x1] = crop
    return out


def add_gaze(rig, grid=40):
    byname = {p.name: p for p in rig.parts}
    for s in ('r', 'l'):
        white, iris, lash = byname.get(f'eyewhite_{s}'), byname.get(f'irides_{s}'), byname.get(f'eyelash_{s}')
        if not (white and iris):
            continue
        wm, im = white.rgba[..., 3] > 0.5, iris.rgba[..., 3] > 0.5
        if wm.sum() < 50 or im.sum() < 30:
            continue
        lash_rgba = lash.rgba if lash else np.zeros_like(white.rgba)
        parts, info, _ = eye_parts(iris.rgba, white.rgba, lash_rgba, im, wm)
        box = info['box']
        cx, cy, r, _ = info['iris_ellipse']
        # sideways the iris travels until its edge nearly meets the corner of the eye (the white's room beside it,
        # on the narrower side), at least 0.45 r and at most 0.8 r
        row = wm[int(round(cy + box[1]))]
        xs = np.nonzero(row)[0]
        c = cx + box[0]
        room = min(c - xs.min(), xs.max() - c) - r if xs.size else 0.0
        mx = float(np.clip(0.9 * room, 0.45 * r, 0.8 * r))
        my = 0.30 * r
        new = []
        for key, name, k in (('iris', f'irides_{s}', 1.0), ('pupil', f'pupil_{s}', 1.0),
                             ('highlight2', f'highlight2_{s}', 0.5), ('highlight', f'highlight_{s}', 0.5)):
            rgba = full(parts[key], box, rig.size)
            if (rgba[..., 3] > 0.3).sum() < 3:
                continue
            p = Part(name, rgba, None, grid)
            p.clip = f'eyewhite_{s}'
            sh = lambda dx, dy: np.broadcast_to(np.array([dx, dy], np.float32), p.warp.rest.shape).copy()
            p.keys['eyeX'] = {-1.0: sh(-mx * k, 0), 0.0: sh(0, 0), 1.0: sh(mx * k, 0)}
            p.keys['eyeY'] = {-1.0: sh(0, my * k), 0.0: sh(0, 0), 1.0: sh(0, -my * k)}   # +1 = look up
            new.append(p)
        i = rig.parts.index(iris)
        rig.parts[i:i + 1] = new
    return rig
