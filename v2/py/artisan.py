"""
Artisan-rule head angle keyforms (the way Live2D modelers think about angle X, after 925's notes):

  * the head is a cylinder (elliptic cross-section): far side narrows, near side widens a little, depth shows
    through width only (angle X moves things horizontally, never compresses height)
  * the nose sticks out -> moves more than the face; the brows sit on the brow bone -> a little more than the eyes;
    the eyes sit in sockets -> a little less
  * bangs and side hair are outside the face -> a slightly bigger shell, move a little more
  * back hair is behind the axis -> moves the other way
  * the neck stays; only its top follows the jaw a little

Every control point of every part gets a depth from these rules, then is turned about the vertical head axis:
x' = x cos t + z sin t (orthographic). Angle X = +1 turns the face toward the viewer's right.

  python v2/py/artisan.py <psd> <out dir> [--deg 20]
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

sys.path.insert(0, os.path.dirname(__file__))
from rig import Part, Rig, load_psd  # noqa: E402

PAIRED = ('eyewhite', 'irides', 'eyelash', 'eyebrow', 'ears', 'eyewear', 'earwear')


# ---------------------------------------------------------------- left / right parts

def split_pairs(rig, cx, grid=60):
    """Paired layers (both eyes in one layer etc.) become a left and a right part, in place in the draw order."""
    out = []
    for p in rig.parts:
        if p.name not in PAIRED:
            out.append(p)
            continue
        a = p.rgba[..., 3]
        H, W = a.shape
        xx = np.arange(W)[None, :]
        for side, sel in (('r', xx < cx), ('l', xx >= cx)):    # character's right eye is on the image left
            rgba = p.rgba * sel[..., None]
            if (rgba[..., 3] > 0.5).sum() < 20:
                continue
            q = Part(f'{p.name}_{side}', rgba, None if p.depth is None else p.depth, grid)
            out.append(q)
    rig.parts = out
    return rig


# ---------------------------------------------------------------- landmarks

def centroid(m):
    ys, xs = np.nonzero(m)
    return float(xs.mean()), float(ys.mean())


def landmarks(rig):
    P = {p.name: p for p in rig.parts}
    face = P['face'].rgba[..., 3] > 0.5
    ys, xs = np.nonzero(face)
    L = {}
    if 'irides' in P:
        ir = P['irides'].rgba[..., 3] > 0.5
        lab, k = ndi.label(ir)
        sizes = ndi.sum(ir, lab, range(1, k + 1))
        big = np.argsort(sizes)[::-1][:2] + 1
        cs = sorted(centroid(lab == i) for i in big)
        L['eye_r'], L['eye_l'] = cs[0], cs[-1]
    eye_y = (L['eye_r'][1] + L['eye_l'][1]) / 2 if 'eye_r' in L else ys.min() + 0.55 * (ys.max() - ys.min())
    row = face[int(eye_y)]
    rx = np.nonzero(row)[0]
    # centre line: the nose if it is there, else midway between the eyes
    if 'nose' in P and (P['nose'].rgba[..., 3] > 0.5).sum() > 3:
        L['nose'] = centroid(P['nose'].rgba[..., 3] > 0.5)
    cx = (L['eye_r'][0] + L['eye_l'][0]) / 2 if 'eye_r' in L else (rx.min() + rx.max()) / 2
    if 'mouth' in P and (P['mouth'].rgba[..., 3] > 0.5).sum() > 3:
        L['mouth'] = centroid(P['mouth'].rgba[..., 3] > 0.5)
    # face half width at the cheeks: the widest face row between the eyes and the mouth
    y0 = int(eye_y)
    y1 = int(L['mouth'][1]) if 'mouth' in L else int(eye_y + 0.3 * (ys.max() - ys.min()))
    widths = [(np.ptp(np.nonzero(face[y])[0]) if face[y].any() else 0) for y in range(y0, max(y0 + 1, y1))]
    half = max(widths) / 2
    L.update(cx=float(cx), eye_y=float(eye_y), chin_y=float(ys.max()), top_y=float(ys.min()), half=float(half))
    return L


# ---------------------------------------------------------------- the head model

def shell(x, R, D):
    """Front surface depth of an elliptic cylinder (semi-axes R across, D in depth) at x (relative to the axis)."""
    u = np.clip(x / R, -1, 1)
    return D * np.sqrt(1 - u * u)


def part_rule(name, L):
    """(shell radius factor, depth factor, extra depth in head radii, sign) for a part.
    sign -1 = on the back of the head."""
    base = name.rsplit('_', 1)[0] if name.endswith(('_l', '_r')) else name
    return {
        'face':       (1.00, 1.00, 0.00, 1),
        'nose':       (1.00, 1.00, 0.16, 1),
        'mouth':      (1.00, 1.00, 0.04, 1),
        'mouthmask':  (1.00, 1.00, 0.04, 1),
        'mouth_inner': (1.00, 1.00, 0.02, 1),
        'mouth_upper': (1.00, 1.00, 0.04, 1),
        'mouth_lower': (1.00, 1.00, 0.04, 1),
        'eyewhite':   (1.00, 1.00, -0.05, 1),
        'irides':     (1.00, 1.00, -0.05, 1),
        'pupil':      (1.00, 1.00, -0.05, 1),
        'highlight':  (1.00, 1.00, -0.04, 1),
        'highlight2': (1.00, 1.00, -0.04, 1),
        'eyelash':    (1.00, 1.00, -0.03, 1),
        'lash_upper': (1.00, 1.00, -0.03, 1),
        'lash_lower': (1.00, 1.00, -0.03, 1),
        'lash_crease': (1.00, 1.00, -0.02, 1),
        'eyelid':     (1.00, 1.00, -0.04, 1),
        'smileeye':   (1.00, 1.00, -0.03, 1),
        'eyemask':    (1.00, 1.00, -0.05, 1),
        'eyelid_low': (1.00, 1.00, -0.04, 1),
        'eyebrow':    (1.00, 1.00, 0.04, 1),
        'eyewear':    (1.00, 1.00, 0.10, 1),
        'ears':       (1.00, 0.00, -0.10, 1),     # at the side of the head
        'earwear':    (1.00, 0.00, -0.08, 1),
        'front hair': (1.12, 1.10, 0.02, 1),
        'headwear':   (1.15, 1.15, 0.04, 1),
        'back hair':  (1.25, 1.10, 0.00, -1),
    }.get(base)


def turn_disp(part, L, deg, R, D):
    """Control-point displacement of one part for a turn of `deg` degrees (angle X)."""
    pts = part.warp.rest
    x = pts[..., 0] - L['cx']
    y = pts[..., 1]
    t = np.radians(deg)
    name = part.name
    rule = part_rule(name, L)
    if rule is None:                                            # neck, clothes: the neck top follows the jaw a bit
        if name in ('neck', 'neckwear'):
            w = np.clip((L['chin_y'] + 0.15 * R - y) / (0.5 * R), 0, 1) * 0.35
            z = shell(x, R * 0.55, D * 0.5)
            dx = (x * np.cos(t) + z * np.sin(t) - x) * w
            return np.stack([dx, np.zeros_like(dx)], -1).astype(np.float32)
        return np.zeros_like(pts)
    rf, df, extra, sign = rule
    z = sign * shell(x, R * rf, D * df) + extra * R
    # hair hanging below the jaw: still on the head (it hangs from it), but less and less turned with distance
    if name in ('front hair', 'back hair'):
        hang = np.clip((y - L['chin_y']) / (1.2 * R), 0, 1)
        z = z * (1 - 0.6 * hang)
    dx = x * np.cos(t) + z * np.sin(t) - x
    return np.stack([dx, np.zeros_like(dx)], -1).astype(np.float32)


def nod_disp(part, L, deg, R, D):
    """Angle Y (+ = looking up): mostly a vertical shift (925: move the deformer up/down rather than reshape it),
    front features (nose, brows) more, the back of the head the other way; the head is an ellipsoid so points
    near the top / jaw get less depth. Pivot at eye level; the neck stays."""
    pts = part.warp.rest
    x = pts[..., 0] - L['cx']
    yr = pts[..., 1] - L['eye_y']
    t = np.radians(deg)
    rule = part_rule(part.name, L)
    Ry = (L['chin_y'] - L['top_y']) * 0.75
    if rule is None:
        if part.name in ('neck', 'neckwear'):                     # the top of the neck stretches with the jaw
            w = np.clip((L['chin_y'] + 0.15 * R - pts[..., 1]) / (0.5 * R), 0, 1) * 0.5
            dy = -np.sin(t) * D * 0.4 * w
            return np.stack([np.zeros_like(dy), dy], -1).astype(np.float32)
        return np.zeros_like(pts)
    rf, df, extra, sign = rule
    vy = np.sqrt(np.clip(1 - (yr / (Ry * rf)) ** 2, 0, 1))
    z = sign * shell(x, R * rf, D * df) * vy + extra * R
    if part.name in ('front hair', 'back hair'):
        hang = np.clip((pts[..., 1] - L['chin_y']) / (1.2 * R), 0, 1)
        z = z * (1 - 0.6 * hang)
    dy = yr * np.cos(t) - z * np.sin(t) - yr
    return np.stack([np.zeros_like(dy), dy], -1).astype(np.float32)


ORDER = ['back hair', 'topwear', 'handwear', 'neck', 'neckwear', 'ears', 'earwear', 'face', 'nose', 'mouth',
         'eyewhite', 'irides', 'eyelash', 'eyewear', 'eyebrow', 'front hair', 'headwear', 'objects']


def artisan_order(rig):
    """see-through orders its layers by estimated depth, which sometimes puts the bangs under the face;
    a Live2D modeler stacks a head the same way every time."""
    rank = lambda p: ORDER.index(p.name.rsplit('_', 1)[0] if p.name.endswith(('_l', '_r')) else p.name) \
        if (p.name.rsplit('_', 1)[0] if p.name.endswith(('_l', '_r')) else p.name) in ORDER else len(ORDER)
    rig.parts.sort(key=rank)          # stable: left / right pairs keep their order


def build(rig, deg=20.0, deg_y=14.0, gaze=True, mouth_src=None, mouth_open=None, smile_eyes=None):
    """mouth_src: the picture the PSD was made from; mouth_open / smile_eyes: the same picture with the mouth
    open / the eyes smiling (^ ^), drawn by AI - used as drawn states (Live2D 描き目)."""
    L = landmarks(rig)
    split_pairs(rig, L['cx'])
    artisan_order(rig)
    if gaze:
        from eyes_rig import add_gaze
        from blink_rig import add_blink
        add_gaze(rig)
        add_blink(rig)
    if mouth_src and mouth_open:
        from mouth_rig import add_mouth
        add_mouth(rig, mouth_src, mouth_open)
    if mouth_src and smile_eyes:
        from drawn_eyes import add_drawn_eyes
        add_drawn_eyes(rig, mouth_src, smile_eyes)
    R = L['half'] * 1.04
    D = R * 0.95
    for p in rig.parts:
        z0 = np.zeros_like(p.warp.rest)
        p.keys['angleX'] = {-1.0: turn_disp(p, L, -deg, R, D), 0.0: z0, 1.0: turn_disp(p, L, deg, R, D)}
        p.keys['angleY'] = {-1.0: nod_disp(p, L, -deg_y, R, D), 0.0: z0, 1.0: nod_disp(p, L, deg_y, R, D)}
    return L, R, D


def save_grid(rig, out, crop):
    """3 x 3: angle Y +1 / 0 / -1 (rows) x angle X -1 / 0 / +1 (columns). Diagonals are the X and Y offsets added."""
    rows = []
    for vy in (1.0, 0.0, -1.0):
        row = [rig.render({'angleX': vx, 'angleY': vy})[crop[1]:crop[3], crop[0]:crop[2]] for vx in (-1.0, 0.0, 1.0)]
        rows.append(np.concatenate(row, 1))
    g = np.concatenate(rows, 0)
    g = cv2.resize(g, (g.shape[1] // 2, g.shape[0] // 2), interpolation=cv2.INTER_AREA)
    Image.fromarray((np.clip(g, 0, 1) * 255).astype(np.uint8)).save(os.path.join(out, 'grid.png'))


def save_sweep(rig, out, crop=None, n=9):
    H, W = rig.size
    frames = []
    for v in np.concatenate([np.linspace(0, 1, 8), np.linspace(1, -1, 16), np.linspace(-1, 0, 8)]):
        im = rig.render({'angleX': float(v)})
        if crop:
            im = im[crop[1]:crop[3], crop[0]:crop[2]]
        frames.append(Image.fromarray((np.clip(cv2.resize(im, (im.shape[1] // 2, im.shape[0] // 2), interpolation=cv2.INTER_AREA), 0, 1) * 255).astype(np.uint8)))
    frames[0].save(os.path.join(out, 'sweep.gif'), save_all=True, append_images=frames[1:], duration=60, loop=0)
    keys = [rig.render({'angleX': v}) for v in (-1.0, 0.0, 1.0)]
    if crop:
        keys = [k[crop[1]:crop[3], crop[0]:crop[2]] for k in keys]
    Image.fromarray((np.clip(np.concatenate(keys, 1), 0, 1) * 255).astype(np.uint8)).save(os.path.join(out, 'keys.png'))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('psd')
    ap.add_argument('out')
    ap.add_argument('--deg', type=float, default=20)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    rig = load_psd(a.psd, grid=60)
    L, R, D = build(rig, a.deg)
    json.dump(dict(landmarks=L, R=R, D=D, parts=[p.name for p in rig.parts]), open(os.path.join(a.out, 'artisan.json'), 'w'), indent=1)
    rig.save_keys(os.path.join(a.out, 'keys.json'))
    cx, ey = int(L['cx']), int(L['eye_y'])
    s = int(R * 2.6)
    crop = (max(0, cx - s // 2), max(0, ey - int(s * 0.55)), min(rig.size[1], cx + s // 2), min(rig.size[0], ey + int(s * 0.65)))
    save_sweep(rig, a.out, crop)
    save_grid(rig, a.out, crop)
    print(json.dumps(dict(R=R, cx=L['cx'], eye_y=L['eye_y'], parts=len(rig.parts))))
