"""
Reference keyform engine (Python, for fitting and checking; the browser engine follows the same rules).

Live2D-like model:
  part      RGBA texture on the canvas, in draw order (first = bottom)
  warp      a control grid over the part's box (nx x ny cells, (ny+1) x (nx+1) points). A pixel moves by the
            bilinear blend of its cell's control-point displacements. Outside the box the edge displacement holds.
  keyforms  control-point positions at parameter values, e.g. {'angleX': {-1: P, 0: P0, 1: P}}; between keys the
            positions are interpolated linearly, several parameters add their offsets (from the rest pose)
"""
import json
import os

import cv2
import numpy as np
from PIL import Image
from psd_tools import PSDImage

DEFAULTS = {'eyeOpenL': 1.0, 'eyeOpenR': 1.0}
SKIP = {'head', 'tail', 'wings', 'bottomwear', 'legwear', 'footwear'}


class Warp:
    def __init__(self, box, nx, ny):
        self.x0, self.y0, self.x1, self.y1 = [float(v) for v in box]
        self.nx, self.ny = nx, ny
        xs = np.linspace(self.x0, self.x1, nx + 1)
        ys = np.linspace(self.y0, self.y1, ny + 1)
        self.rest = np.stack(np.meshgrid(xs, ys), -1)          # (ny+1, nx+1, 2)

    def weights(self, x, y):
        """Bilinear weights of points (x, y) (flat arrays) on the control points: (n, (ny+1)*(nx+1)) dense."""
        u = np.clip((x - self.x0) / max(1e-6, self.x1 - self.x0), 0, 1) * self.nx
        v = np.clip((y - self.y0) / max(1e-6, self.y1 - self.y0), 0, 1) * self.ny
        i = np.minimum(u.astype(int), self.nx - 1)
        j = np.minimum(v.astype(int), self.ny - 1)
        fu, fv = u - i, v - j
        n = len(x)
        W = np.zeros((n, (self.ny + 1) * (self.nx + 1)), np.float32)
        idx = lambda jj, ii: jj * (self.nx + 1) + ii
        r = np.arange(n)
        W[r, idx(j, i)] += (1 - fu) * (1 - fv)
        W[r, idx(j, i + 1)] += fu * (1 - fv)
        W[r, idx(j + 1, i)] += (1 - fu) * fv
        W[r, idx(j + 1, i + 1)] += fu * fv
        return W

    def field(self, disp, H, W, step=4):
        """Displacement field (H, W, 2) of control displacements `disp` (ny+1, nx+1, 2), computed on a coarse
        grid and resized (the field is bilinear per cell, so this is exact enough)."""
        gh, gw = (H + step - 1) // step, (W + step - 1) // step
        ys, xs = np.mgrid[0:gh, 0:gw]
        xs = (xs * step).ravel().astype(np.float32)
        ys = (ys * step).ravel().astype(np.float32)
        u = np.clip((xs - self.x0) / max(1e-6, self.x1 - self.x0), 0, 1) * self.nx
        v = np.clip((ys - self.y0) / max(1e-6, self.y1 - self.y0), 0, 1) * self.ny
        i = np.minimum(u.astype(int), self.nx - 1)
        j = np.minimum(v.astype(int), self.ny - 1)
        fu, fv = (u - i)[:, None], (v - j)[:, None]
        d = (disp[j, i] * (1 - fu) * (1 - fv) + disp[j, i + 1] * fu * (1 - fv)
             + disp[j + 1, i] * (1 - fu) * fv + disp[j + 1, i + 1] * fu * fv)
        f = d.reshape(gh, gw, 2).astype(np.float32)
        return cv2.resize(f, (gw * step, gh * step), interpolation=cv2.INTER_LINEAR)[:H, :W]


class Part:
    def __init__(self, name, rgba, depth, grid):
        self.name, self.rgba, self.depth = name, rgba, depth
        a = rgba[..., 3]
        ys, xs = np.nonzero(a > 0.02)
        H, W = a.shape
        self.bbox = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
        bw, bh = self.bbox[2] - self.bbox[0], self.bbox[3] - self.bbox[1]
        m = 0.08 * max(bw, bh) + 4
        box = (self.bbox[0] - m, self.bbox[1] - m, self.bbox[2] + m, self.bbox[3] + m)
        nx = int(np.clip(round(bw / grid), 2, 10))
        ny = int(np.clip(round(bh / grid), 2, 10))
        self.warp = Warp(box, nx, ny)
        self.keys = {}                                          # param -> {value: displacement (ny+1, nx+1, 2)}
        self.clip = None                                        # name of the part this one is drawn inside
        self.mask_only = False                                  # only used as a clip mask, never drawn
        self.opacity = {}                                       # param -> (values, alphas), multiplied

    def displacement(self, params):
        d = np.zeros_like(self.warp.rest)
        for p, ks in self.keys.items():
            v = params.get(p, DEFAULTS.get(p, 0.0))
            if not ks:
                continue
            vals = sorted(ks)
            v = float(np.clip(v, vals[0], vals[-1]))
            for a, b in zip(vals, vals[1:]):
                if a <= v <= b:
                    t = (v - a) / (b - a) if b > a else 0
                    d = d + ks[a] * (1 - t) + ks[b] * t
                    break
        return d


def part_alpha(part, params):
    a = 1.0
    for p, (vals, al) in part.opacity.items():
        a *= float(np.interp(params.get(p, DEFAULTS.get(p, 0.0)), vals, al))
    return a


def render_part(part, params, H, W):
    """Forward warp of one part: invert the displacement field by fixed-point iteration and sample."""
    k = part_alpha(part, params)
    if k <= 0.001:
        return np.zeros_like(part.rgba)
    if k < 0.999:
        faded = part.rgba.copy()
        faded[..., 3] *= k
        part = type('P', (), dict(rgba=faded, displacement=part.displacement, warp=part.warp))()
    disp = part.displacement(params)
    if not np.any(disp):
        return part.rgba
    D = part.warp.field(disp, H, W)
    gy, gx = np.mgrid[0:H, 0:W].astype(np.float32)
    sx, sy = gx.copy(), gy.copy()                                # source position of each output pixel
    for _ in range(6):
        dd = cv2.remap(D, sx, sy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        sx, sy = gx - dd[..., 0], gy - dd[..., 1]
    pre = part.rgba.copy()
    pre[..., :3] *= pre[..., 3:4]
    out = cv2.remap(pre, sx, sy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    rgb = out[..., :3] / np.maximum(out[..., 3:4], 1e-6)
    return np.concatenate([rgb, out[..., 3:4]], -1)


def composite(layers, bg=1.0):
    H, W = layers[0].shape[:2]
    c = np.full((H, W, 3), bg, np.float32)
    for L in layers:
        a = L[..., 3:4]
        c = L[..., :3] * a + c * (1 - a)
    return c


class Rig:
    def __init__(self, parts, size):
        self.parts, self.size = parts, size

    def render(self, params, bg=1.0):
        H, W = self.size
        return composite([render_part(p, params, H, W) for p in self.parts if not p.mask_only], bg)

    def save_keys(self, path):
        out = {p.name: {k: {str(v): d.round(3).tolist() for v, d in ks.items()} for k, ks in p.keys.items()}
               for p in self.parts}
        json.dump(out, open(path, 'w'), separators=(',', ':'))

    def load_keys(self, path):
        data = json.load(open(path))
        for p in self.parts:
            for k, ks in data.get(p.name, {}).items():
                p.keys[k] = {float(v): np.array(d, np.float32) for v, d in ks.items()}


def load_psd(psd_path, depth_dir=None, grid=90, min_px=50, skip=None):
    """Parts from a see-through PSD (+ the per-part depth PNGs next to it, if any)."""
    psd = PSDImage.open(psd_path)
    H, W = psd.height, psd.width
    layers = [l for l in psd.descendants() if l.kind != 'group']
    parts = []
    for l in layers:                                             # psd-tools lists bottom -> top
        if l.name in (SKIP if skip is None else skip):
            continue
        im = Image.new('RGBA', (W, H))
        im.alpha_composite(l.topil().convert('RGBA'), (l.left, l.top))
        rgba = np.asarray(im).astype(np.float32) / 255.0
        a = rgba[..., 3]
        a[a < 0.03] = 0                                          # see-through leaves faint alpha all over
        # ...and faint specks far from the drawing: keep only what lies near its solid pixels, so the part's
        # box (and its warp grid) is the drawing's, not the whole canvas
        from scipy import ndimage as _ndi
        a[~_ndi.binary_dilation(a > 0.3, iterations=6)] = 0
        if (a > 0.5).sum() < min_px:
            continue
        depth = None
        if depth_dir:
            p = os.path.join(depth_dir, l.name + '_depth.png')
            if os.path.exists(p):
                depth = np.asarray(Image.open(p).convert('L')).astype(np.float32) / 255.0
        parts.append(Part(l.name, rgba, depth, grid))
    return Rig(parts, (H, W))
