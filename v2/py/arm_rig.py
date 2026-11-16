"""
Arms (the artisan's rotation deformers: shoulder -> elbow; the hand rides on the forearm).

see-through gives the arms whole (sleeves and hands, the hidden parts painted in) in 'handwear'; the base picture
is asked for arms hanging relaxed beside the body, so each arm is a long vertical blob. Per arm:

  axis     the arm's centre line: the mask's middle in each row, smoothed
  joints   shoulder S half an arm-width below the top of the arm, elbow E and wrist W at 43 % / 80 % of the
           length from S to the fingertips along the axis (upper arm : forearm : hand ~ 43 : 37 : 20)
  bones    weights per control point of a finer warp grid along the arm: the shoulder turns everything below
           the shoulder cap (blended over the cap), the elbow everything below the elbow (blended over +-8 %),
           the wrist the hand (+-5 %). The hand hangs: it gives back 35 % of the forearm's turn (gravity), plus
           hand<s> (+-40 deg) on top.

The engine turns arm<s>X / arm<s>Y (wrist offset in arm lengths: tracking.js) into the two angles by IK
(engine.js solveArm). Arm keys: 'L' = the arm on the screen's left (tracking.js mirror rule), 'R' the other.
"""
import numpy as np
from scipy import ndimage as ndi

from rig import Part, Warp

ARM_PARAMS = [dict(id=f'arm{s}{a}', min=-2, max=2, default=0) for s in ('L', 'R') for a in ('X', 'Y')] +              [dict(id=f'hand{s}', min=-1, max=1, default=0) for s in ('L', 'R')]


def smooth(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def axis_of(mask):
    """(ys, xs) of the arm's centre line, one point per row from top to bottom, smoothed."""
    rows = np.nonzero(mask.any(1))[0]
    y0, y1 = rows.min(), rows.max()
    ys = np.arange(y0, y1 + 1)
    xs = np.array([np.nonzero(mask[y])[0].mean() if mask[y].any() else np.nan for y in ys])
    ok = ~np.isnan(xs)
    xs = np.interp(ys, ys[ok], xs[ok])
    xs = ndi.uniform_filter1d(xs, max(3, int(0.06 * len(ys))), mode='nearest')
    return ys.astype(np.float32), xs.astype(np.float32)


def arc_param(px, py, ys, xs):
    """Arc length along the axis of the nearest axis point to each (px, py)."""
    seg = np.hypot(np.diff(xs), np.diff(ys))
    s = np.concatenate([[0], np.cumsum(seg)])
    d = (px[..., None] - xs) ** 2 + (py[..., None] - ys) ** 2
    return s[np.argmin(d, -1)], s


def arm_side(part, sel, side, grid):
    a = part.rgba[..., 3] * sel
    m = a > 0.5
    lab, n = ndi.label(m)
    if n == 0:
        return None
    big = 1 + int(np.argmax(ndi.sum(m, lab, range(1, n + 1))))
    m = lab == big
    ys_, xs_ = np.nonzero(m)
    h, w = ys_.max() - ys_.min(), xs_.max() - xs_.min()
    if h < 1.6 * w or m.sum() < 500:                      # not a hanging arm: leave it on the body
        return None
    ys, xs = axis_of(m)
    width_top = float(m[int(ys[0]):int(ys[0]) + max(2, int(0.1 * h))].sum(1).mean())
    s_idx = int(min(len(ys) - 1, 0.5 * width_top))
    _, arc = arc_param(np.array([0.0]), np.array([0.0]), ys, xs)
    total = arc[-1] - arc[s_idx]
    at = lambda f: int(np.searchsorted(arc, arc[s_idx] + f * total))
    e_idx, w_idx = min(at(0.43), len(ys) - 1), min(at(0.80), len(ys) - 1)
    S = [float(xs[s_idx]), float(ys[s_idx])]
    E = [float(xs[e_idx]), float(ys[e_idx])]
    W = [float(xs[w_idx]), float(ys[w_idx])]
    rgba = part.rgba * sel[..., None]
    q = Part(part.name + ('_r' if side == 'L' else '_l'), rgba, part.depth, grid)
    b = q.warp
    ny = int(np.clip(round((b.y1 - b.y0) / (0.05 * total)), 12, 24))
    q.warp = Warp((b.x0, b.y0, b.x1, b.y1), max(b.nx, 3), ny)
    P = q.warp.rest
    t, _ = arc_param(P[..., 0], P[..., 1], ys, xs)
    tS, tE = arc[s_idx], arc[e_idx]
    cap = max(4.0, tS)
    w_sh = smooth((t - (tS - cap)) / (cap + 0.1 * total))
    band = 0.08 * total
    w_el = smooth((t - (tE - band)) / (2 * band))
    tW = arc[w_idx]
    wb = 0.05 * total
    w_wr = smooth((t - (tW - wb)) / (2 * wb))
    q.bones = [dict(arm=side, joint='wr', w=w_wr.astype(np.float32)),
               dict(arm=side, joint='el', w=w_el.astype(np.float32)),
               dict(arm=side, joint='sh', w=w_sh.astype(np.float32))]
    out = -1 if side == 'L' else 1
    return q, dict(S=S, E=E, W=W, out=out)


def add_arms(rig, cx, grid=60):
    """Replaces the 'handwear' part by one part per arm with bones; returns {side: joints} (empty if none)."""
    parts, arms = [], {}
    for p in rig.parts:
        if p.name != 'handwear':
            parts.append(p)
            continue
        H, W = p.rgba.shape[:2]
        xx = np.arange(W)[None, :]
        made = []
        for side, sel in (('L', np.broadcast_to(xx < cx, (H, W))), ('R', np.broadcast_to(xx >= cx, (H, W)))):
            r = arm_side(p, sel.astype(np.float32), side, grid)
            if r:
                made.append(r[0])
                arms[side] = r[1]
        if len(made) == 2:
            parts.extend(made)
        else:                                             # one arm found or none: keep the layer as it was
            parts.append(p)
            arms = {}
    rig.parts = parts
    return arms
