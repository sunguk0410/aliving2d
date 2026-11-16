"""
Hair sway (the artisan's hair: it bends from the root and lags behind the head) without cutting the layer.

add_hair_sway(rig, L, R)
  Default: each layer sways as one piece (the user preferred the first, plain model). zones=True:
  Each 'front hair' / 'back hair' layer stays one part (cutting it into locks only works where the cut follows
  the hair's grain; a wrong cut shows). Its warp grid gets finer, and the layer is covered by several overlapping
  sway zones across its width - smooth bumps that add up to 1 everywhere, so neighbouring zones blend and nothing
  can part. Each zone:

    keyforms   param 'sway<prefix><k>' -1 / 0 / +1: sideways by nothing at the root (the top of the hair in that
               column, 30 % of its length stays) and most at the tip (u^1.6), the tip lifting a little (an arc)
    physics    a two-stage pendulum the engine runs every frame, driven by the head's angle X / Y; longer hair
               swings slower and further, each zone with its own breeze phase, so the hair moves like bunches.
"""
import os
import sys

import numpy as np
from scipy import ndimage as ndi

sys.path.insert(0, os.path.dirname(__file__))
from rig import Warp  # noqa: E402


def column_extent(a):
    """Top and bottom row of the hair in every column (smoothed; empty columns take their neighbours')."""
    m = a > 0.3
    H, W = m.shape
    has = m.any(0)
    top = np.where(has, np.argmax(m, 0), np.nan).astype(float)
    bot = np.where(has, H - 1 - np.argmax(m[::-1], 0), np.nan).astype(float)
    xs = np.arange(W)
    ok = ~np.isnan(top)
    top = np.interp(xs, xs[ok], top[ok])
    bot = np.interp(xs, xs[ok], bot[ok])
    k = max(3, W // 40)
    return ndi.uniform_filter1d(top, k), ndi.uniform_filter1d(bot, k)


def add_hair_sway(rig, L, R, prefix='h', zones=False):
    """Adds sway keyforms and physics to every hair layer (in place); returns the physics entries.
    zones=False (default, the user's choice 2026-11-16): each layer sways as ONE piece on its own coarse grid - the
    look of the first model. zones=True: several overlapping zones across the width on a finer grid (bunches)."""
    physics = getattr(rig, 'physics', [])
    k = len(physics)
    for p in rig.parts:
        if p.name not in ('front hair', 'back hair'):
            continue
        a = p.rgba[..., 3]
        ys, xs = np.nonzero(a > 0.3)
        if len(xs) < 200:
            continue
        front = p.name == 'front hair'
        x0, x1 = xs.min(), xs.max()
        width = x1 - x0
        zone_w = (0.16 if front else 0.3) * R
        n = int(np.clip(round(width / zone_w), 1, 8)) if zones else 1
        b = p.warp
        if zones:
            p.warp = Warp((b.x0, b.y0, b.x1, b.y1), int(np.clip(round((b.x1 - b.x0) / (0.08 * R)), b.nx, 20)),
                          int(np.clip(round((b.y1 - b.y0) / (0.12 * R)), b.ny, 16)))
        P = p.warp.rest
        top, bot = column_extent(a)
        cx = np.clip(P[..., 0].round().astype(int), 0, a.shape[1] - 1)
        t, bo = top[cx], bot[cx]
        length = np.maximum(10.0, bo - t)
        u = np.clip(((P[..., 1] - t) / length - 0.3) / 0.7, 0, 1) ** 1.6
        # zones: gaussian bumps across the width, normalised to sum to 1
        centres = x0 + (np.arange(n) + 0.5) * width / n
        sig = 0.6 * width / n
        bumps = np.exp(-0.5 * ((P[..., 0][None] - centres[:, None, None]) / sig) ** 2)
        bumps /= bumps.sum(0, keepdims=True) + 1e-9
        for i in range(n):
            ci = int(np.clip(centres[i], 0, a.shape[1] - 1))
            zl = max(10.0, bot[ci] - top[ci]) if zones else float(np.median((bot - top)[x0:x1 + 1]))
            amp = (0.05 if front else 0.07) * zl + 0.01 * R
            w = bumps[i] * u
            d = np.stack([amp * w, -0.12 * amp * w * u], -1).astype(np.float32)
            name = f'sway{prefix}{k}'
            p.keys[name] = {-1.0: d * np.array([-1, 1], np.float32), 0.0: np.zeros_like(d), 1.0: d}
            rel = zl / R
            physics.append(dict(param=name, inputs={'angleX': 1.0, 'angleY': 0.35},
                                freq=float(np.clip(2.6 / np.sqrt(0.4 + rel), 0.9, 3.2)) * (0.92 + 0.16 * (i % 3) / 2),
                                damping=0.22 if front else 0.16, gain=0.7 if front else 0.9,
                                wind=0.05 if front else 0.07, seed=k))
            k += 1
    rig.physics = physics
    return physics
