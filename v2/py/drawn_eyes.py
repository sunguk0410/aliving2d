"""
Drawn eyes (Live2D 描き目): an AI drawing of the same face with the eyes in another state (e.g. smiling "^ ^")
becomes one part per eye that takes over at the end of a parameter, the way the Cubism manual does it: the
deformed eye leads up to it, then the drawing fades in over the last stretch.

Each part = the model's own face skin over the eye region (so no seam even if the AI shaded the skin a little
differently) + the AI drawing's strokes (pixels that are not skin in the AI picture), feathered at the edge.

  add_drawn_eyes(rig, src_png, drawn_png, param='eyeSmile', name='smileeye', fade=(0.8, 0.97))
"""
import os
import sys

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

sys.path.insert(0, os.path.dirname(__file__))
from rig import Part  # noqa: E402
from mouth_rig import load, align  # noqa: E402


def add_drawn_eyes(rig, src_path, drawn_path, param='eyeSmile', name='smileeye', fade=(0.8, 0.97), grid=24):
    byname = {p.name: p for p in rig.parts}
    face = byname.get('face')
    if face is None:
        return rig
    H, W = rig.size
    src, drw = load(src_path, (H, W)), load(drawn_path, (H, W))
    # align on the face away from the eyes
    eyes = np.zeros((H, W), bool)
    for s in ('r', 'l'):
        for k in ('eyewhite', 'eyelash', 'lash_upper', 'lash_lower', 'lash_crease'):
            p = byname.get(f'{k}_{s}')
            if p is not None:
                eyes |= p.rgba[..., 3] > 0.2
    keep = (face.rgba[..., 3] > 0.9) & ~ndi.binary_dilation(eyes, iterations=40)
    drw, _ = align(src, drw, keep)
    for s in ('r', 'l'):
        white = byname.get(f'eyewhite_{s}')
        if white is None:
            continue
        wm = white.rgba[..., 3] > 0.5
        lash = np.zeros((H, W), bool)
        for k in ('lash_upper', 'lash_lower', 'lash_crease', 'eyelash'):
            p = byname.get(f'{k}_{s}')
            if p is not None:
                lash |= p.rgba[..., 3] > 0.2
        region = ndi.binary_dilation(wm | lash, iterations=10)
        ring = ndi.binary_dilation(region, iterations=8) & ~region & (face.rgba[..., 3] > 0.9)
        skin_ai = np.median(drw[ring], axis=0) if ring.sum() > 20 else np.median(drw[region], axis=0)
        # strokes = whole drawn shapes: start from clearly dark pixels the AI added (the lash arch) and grow
        # through every connected pixel it changed that is not skin, so the arch comes whole (its lighter inside
        # too). The model's own bangs cover their place anyway: strokes there are AI hair, dropped.
        dist = np.linalg.norm(drw - skin_ai, axis=-1)
        changed = np.abs(drw - src).max(-1)
        lum = drw @ np.array([0.299, 0.587, 0.114], np.float32)
        skin_l = float(skin_ai @ np.array([0.299, 0.587, 0.114], np.float32))
        hair = byname['front hair'].rgba[..., 3] > 0.5 if 'front hair' in byname else np.zeros((H, W), bool)
        cand = region & ~hair & (changed > 0.05) & (dist > 0.06)
        seed = cand & (lum < skin_l - 0.30)
        grown = ndi.binary_propagation(seed, mask=cand)
        lab, n = ndi.label(grown)
        if n:
            sizes = ndi.sum(grown, lab, range(1, n + 1))
            keep = np.isin(lab, 1 + np.nonzero(sizes >= max(30, 0.15 * sizes.max()))[0])
        else:
            keep = grown
        keep = ndi.binary_closing(keep, iterations=1)
        stroke = np.clip((dist - 0.04) / 0.10, 0, 1) * keep
        stroke = np.maximum(stroke, ndi.binary_erosion(keep, iterations=1) * 1.0)
        stroke = ndi.gaussian_filter(stroke.astype(np.float32), 0.5)
        rgba = np.zeros((H, W, 4), np.float32)
        skin = face.rgba[..., :3]
        rgba[..., :3] = skin * (1 - stroke[..., None]) + drw * stroke[..., None]
        edge = ndi.gaussian_filter(region.astype(np.float32), 3.0)
        rgba[..., 3] = np.clip(edge * 1.4, 0, 1) * (face.rgba[..., 3] > 0.5)
        p = Part(f'{name}_{s}', rgba, None, grid)
        p.opacity = {param: ([0.0, fade[0], fade[1], 1.0], [0.0, 0.0, 1.0, 1.0])}
        # above the eye's own lashes, below the brows
        last = max(i for i, q in enumerate(rig.parts) if q.name.endswith(f'_{s}') and
                   q.name.rsplit('_', 1)[0] in ('lash_upper', 'lash_lower', 'lash_crease', 'eyelash', 'eyelid', 'eyelid_low'))
        rig.parts.insert(last + 1, p)
    return rig
