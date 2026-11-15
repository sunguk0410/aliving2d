"""
Mouth from parts: the closed mouth of the model + one AI drawing of the same face with the mouth open ("ah").

  mouthmask      the open mouth's shape (never drawn): squeezed onto the closed mouth line when mouthOpen = 0
  mouth_inner    the open drawing's inside (teeth, tongue, dark), clipped to the mask. Its top 35 % (upper teeth)
                 rides with the upper lip, the rest follows the lower lip
  mouth_upper    the open drawing's outline above the mouth's middle: goes to the closed line when closing
  mouth_lower    the outline below the middle (lower lip): goes up to the closed line
  mouth          the model's own closed mouth line: fades out as the mouth opens, the open parts fade in
  mouthForm      corners up (+1, smile) / down (-1), the mouth a little wider when smiling

The open drawing is aligned to the model's source picture on the face around the mouth (translation), so its
pixels land where the closed mouth is.
"""
import os
import sys

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

sys.path.insert(0, os.path.dirname(__file__))
from rig import Part  # noqa: E402


def load(path, size):
    return np.asarray(Image.open(path).convert('RGB').resize(size[::-1], Image.LANCZOS)).astype(np.float32) / 255.0


def align(src, opn, keep):
    """Translation that puts `opn` on `src`, measured on `keep` (the face around the mouth)."""
    g = lambda a: cv2.cvtColor((a * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32)
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        _, warp = cv2.findTransformECC(g(src), g(opn), warp, cv2.MOTION_TRANSLATION,
                                       (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 100, 1e-5), keep.astype(np.uint8), 5)
    except cv2.error:
        pass
    H, W = src.shape[:2]
    return cv2.warpAffine(opn, warp, (W, H), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE), warp


def open_mouth_mask(src, opn, cx, cy, w, skin):
    """The open mouth (outline + inside): pixels that changed and are not skin, around the closed mouth."""
    H, W = src.shape[:2]
    x0, x1 = int(cx - 1.4 * w), int(cx + 1.4 * w)
    y0, y1 = int(cy - 0.8 * w), int(cy + 1.8 * w)
    box = np.zeros((H, W), bool)
    box[max(0, y0):y1, max(0, x0):x1] = True
    diff = np.abs(opn - src).max(-1)
    off_skin = np.linalg.norm(opn - skin, axis=-1) > 0.10
    m = box & (diff > 0.08) & off_skin
    m = ndi.binary_closing(m, iterations=3)
    m = ndi.binary_opening(m, iterations=1)
    lab, n = ndi.label(m)
    if n == 0:
        return None
    sizes = ndi.sum(m, lab, range(1, n + 1))
    # the biggest piece that overlaps the mouth's column
    best = max(range(n), key=lambda i: sizes[i] * (1 if (lab[:, int(cx)] == i + 1).any() else 0.1))
    return ndi.binary_fill_holes(lab == best + 1)


def columns(mask):
    H, W = mask.shape
    top = np.full(W, np.nan)
    bot = np.full(W, np.nan)
    for x in np.nonzero(mask.any(0))[0]:
        c = np.nonzero(mask[:, x])[0]
        top[x], bot[x] = c.min(), c.max()
    ok = ~np.isnan(top)
    xs = np.arange(W)
    return np.interp(xs, xs[ok], top[ok]), np.interp(xs, xs[ok], bot[ok]), xs[ok].min(), xs[ok].max()


def at(a, x):
    return a[np.clip(np.round(x).astype(int), 0, len(a) - 1)]


def add_mouth(rig, src_path, open_path, grid=8):
    byname = {p.name: p for p in rig.parts}
    mouth, face = byname.get('mouth'), byname.get('face')
    if mouth is None or face is None:
        return rig
    H, W = rig.size
    src, opn = load(src_path, (H, W)), load(open_path, (H, W))
    mm = mouth.rgba[..., 3] > 0.3
    if mm.sum() < 3:
        return rig
    ys, xs = np.nonzero(mm)
    cx, cy, w = xs.mean(), ys.mean(), max(8.0, xs.max() - xs.min())
    keep = (face.rgba[..., 3] > 0.9).astype(np.uint8)
    keep[int(cy - w):int(cy + 2 * w), int(cx - 1.6 * w):int(cx + 1.6 * w)] = 0
    opn, _ = align(src, opn, keep)
    ring = ndi.binary_dilation(mm, iterations=int(w * 0.6)) & ~ndi.binary_dilation(mm, iterations=3) & (face.rgba[..., 3] > 0.9)
    skin = np.median(src[ring], axis=0)
    M = open_mouth_mask(src, opn, cx, cy, w, skin)
    if M is None or M.sum() < 30:
        return rig
    top, bot, ox0, ox1 = columns(M)
    # the closed line: the model's mouth layer, per column (its middle), held at its ends past the corners
    cl = np.full(W, np.nan)
    for x in np.nonzero(mm.any(0))[0]:
        c = np.nonzero(mm[:, x])[0]
        cl[x] = (c.min() + c.max()) / 2
    ok = ~np.isnan(cl)
    closed = np.interp(np.arange(W), np.arange(W)[ok], cl[ok])
    cw = xs.max() - xs.min()
    ocx, ow = (ox0 + ox1) / 2, max(1.0, ox1 - ox0)
    sw = min(1.0, (cw + 2) / ow)                      # closed width / open width
    # AI open mouths tend to be drawn big (an "O" rather than a relaxed "ah"): fully open = about 1.15 x the
    # closed width, scaled about the middle of the upper lip so the drawing keeps its proportions
    k_open = float(np.clip(1.15 * cw / ow, 0.45, 1.0))
    anchor_y = float(np.interp(ocx, np.arange(W), top))

    def make(name, alpha, rgb):
        rgba = np.zeros((H, W, 4), np.float32)
        rgba[..., :3] = rgb
        rgba[..., 3] = alpha
        return Part(name, rgba, None, grid)

    band = M & ~ndi.binary_erosion(M, iterations=max(2, int(w * 0.05)))
    mid = (top + bot) / 2
    yy, xx = np.mgrid[0:H, 0:W]
    upper_band = band & (yy <= at(mid, xx))
    lower_band = band & (yy > at(mid, xx))
    soft = lambda m: np.clip(ndi.gaussian_filter(m.astype(np.float32), 0.6) * 1.3, 0, 1)

    mask = make('mouthmask', M.astype(np.float32), 1.0)
    mask.mask_only = True
    inner = make('mouth_inner', soft(ndi.binary_dilation(M, iterations=2)), opn)
    inner.clip = 'mouthmask'
    up = make('mouth_upper', soft(upper_band), opn)
    lo = make('mouth_lower', soft(lower_band), opn)
    for p in (inner, up, lo):
        p.warp = mask.warp

    def disp(part, fn):
        P = part.warp.rest
        x, y = P[..., 0], P[..., 1]
        dx = (ocx + (x - ocx) * sw) - x                 # corners in to the closed width
        dy = fn(x, y)
        return np.stack([dx, dy], -1).astype(np.float32)

    v = lambda x, y: np.clip((y - at(top, x)) / np.maximum(1, at(bot, x) - at(top, x)), 0, 1)
    to_top = lambda x: at(closed, x) - at(top, x)
    to_bot = lambda x: at(closed, x) - at(bot, x) + 1
    shut = {
        'mouthmask': lambda x, y: to_top(x) * (1 - v(x, y)) + to_bot(x) * v(x, y),
        'mouth_inner': lambda x, y: np.where(v(x, y) < 0.35, to_top(x),
                                             to_top(x) + (to_bot(x) - to_top(x)) * (v(x, y) - 0.35) / 0.65),
        # the outline squeezes with the opening (a column's side wall must shrink too, or it stands upright)
        'mouth_upper': lambda x, y: to_top(x) * (1 - v(x, y)) + to_bot(x) * v(x, y),
        'mouth_lower': lambda x, y: to_top(x) * (1 - v(x, y)) + to_bot(x) * v(x, y),
    }
    def opened(part):
        P = part.warp.rest
        x, y = P[..., 0], P[..., 1]
        return np.stack([(ocx + (x - ocx) * k_open) - x, (anchor_y + (y - anchor_y) * k_open) - y], -1).astype(np.float32)

    def lens(part, Dc, Do, t=0.35, tx=0.45):
        """A little open = a lens: the corners stay pinched (opening shrinks toward them), only the middle opens."""
        P = part.warp.rest
        Pc, Po = P + Dc, P + Do
        xm = Pc[..., 0] + (Po[..., 0] - Pc[..., 0]) * tx
        ylin = Pc[..., 1] + (Po[..., 1] - Pc[..., 1]) * t
        line = np.interp(xm, np.arange(W), closed)
        half_m = (cw + (ow * k_open - cw) * tx) / 2
        u = np.clip(np.abs(xm - ocx) / max(1.0, half_m), 0, 1)
        ym = line + (ylin - line) * (1 - 0.85 * u * u)
        return (np.stack([xm, ym], -1) - P).astype(np.float32)

    for p in (mask, inner, up, lo):
        Dc, Do = disp(p, shut[p.name]), opened(p)
        p.keys['mouthOpen'] = {0.0: Dc, 0.12: lens(p, Dc, Do, 0.12, 0.15), 0.35: lens(p, Dc, Do), 1.0: Do}
        if p.name != 'mouthmask':
            p.opacity = {'mouthOpen': ([0.0, 0.05, 0.14, 1.0], [0.0, 0.0, 1.0, 1.0])}
    mouth.opacity = {'mouthOpen': ([0.0, 0.10, 0.22, 1.0], [1.0, 1.0, 0.0, 0.0])}

    # the closed mouth line needs enough columns to bend into a curve (3 columns only make a V)
    from rig import Warp
    b = mouth.warp
    mouth.warp = Warp((b.x0, b.y0, b.x1, b.y1), 8, 2)
    # mouth form: corners up (smile) / down, a little wider when smiling
    half = max(ow, cw) / 2
    for p in (mask, inner, up, lo, mouth):
        P = p.warp.rest
        f = np.clip(np.abs(P[..., 0] - cx) / half, 0, 1.3) ** 2          # centred on the closed mouth
        k = np.stack([(P[..., 0] - cx) * 0.14, -0.34 * half * f], -1).astype(np.float32)
        p.keys['mouthForm'] = {-1.0: -k * np.array([0.3, 1.0], np.float32), 0.0: np.zeros_like(P), 1.0: k}
    i = rig.parts.index(mouth)
    rig.parts[i:i + 1] = [mask, inner, lo, up, mouth]
    return rig
