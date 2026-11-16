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
from blink_rig import smile_keys  # noqa: E402


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
        fit_smile_line(rig, s, keep)
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


def fit_smile_line(rig, s, stroke):
    """The deformed lids lead up to the drawing, so they should meet where the drawn ^ ^ lid line lies, or the
    cross-fade shows two arches. Meeting line per column = lower edge of the first (topmost) stroke run, i.e. the
    underside of the drawn lash arch; smoothed with a low-order fit, used only when it covers most of the eye.
    Columns past the drawn arch keep the rule's arch, blended in."""
    lines = getattr(rig, 'smile_lines', {}).get(s)
    if lines is None:
        return None
    vis, bot, x0, x1 = lines['vis'], lines['bot'], lines['x0'], lines['x1']
    xs, ys = [], []
    for x in range(x0, x1 + 1):
        col = np.nonzero(stroke[:, x])[0]
        if len(col) < 2:
            continue
        run_end = col[0]
        for y in col[1:]:
            if y - run_end > 1:
                break
            run_end = y
        lo, hi = vis[x] - 0.5 * (bot[x] - vis[x]), bot[x]
        if np.isfinite(lo) and lo <= run_end <= hi:
            xs.append(x)
            ys.append(run_end)
    if len(xs) < 0.6 * (x1 - x0 + 1):
        return None
    xs, ys = np.float64(xs), np.float64(ys)
    ys = ndi.median_filter(ys, size=5)
    c = np.polyfit(xs, ys, 4 if len(xs) > 30 else 2)
    xa = np.arange(len(vis), dtype=np.float64)
    arch = np.polyval(c, np.clip(xa, xs.min(), xs.max()))
    # the rule's arch, for the ends the drawing does not reach
    u = np.clip((xa - x0) / max(1, x1 - x0), 0, 1)
    rule = vis + (bot - vis) * (0.12 + 0.88 * np.abs(2 * u - 1) ** 1.6)
    w = np.clip(np.minimum(xa - xs.min(), xs.max() - xa) / 6.0 + 1, 0, 1)
    smile_y = np.where(np.isfinite(vis), w * arch + (1 - w) * rule, rule)
    smile_y = np.clip(smile_y, vis - 0.3 * (bot - vis), bot)
    smile_keys(lines, smile_y)
    return smile_y
