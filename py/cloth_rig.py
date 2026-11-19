"""
Secondary motion of clothes and hands (the artisan's physics step, beyond the hair).

  skirt     'bottomwear' sways from the waistband (fixed) to the hem (most), driven by the body's lean and turn:
            param 'swaySkirt' (hidden) written by a pendulum each frame, keyforms on a finer warp grid
  hands     each hand lags a beat behind its arm and the body: param 'handLag<s>' (hidden), added to the wrist
            angle by the engine (engine.js handAngle), so it never fights a motion's own hand<s>
"""
import numpy as np

from hair_rig import column_extent
from rig import Warp


def add_skirt_sway(rig, R):
    physics = getattr(rig, 'physics', [])
    for p in rig.parts:
        if p.name != 'bottomwear':
            continue
        a = p.rgba[..., 3]
        ys, xs = np.nonzero(a > 0.3)
        if len(xs) < 200:
            continue
        b = p.warp
        p.warp = Warp((b.x0, b.y0, b.x1, b.y1), max(b.nx, 8), max(b.ny, 8))
        P = p.warp.rest
        top, bot = column_extent(a)
        cx = np.clip(P[..., 0].round().astype(int), 0, a.shape[1] - 1)
        t, bo = top[cx], bot[cx]
        u = np.clip((P[..., 1] - t) / np.maximum(10.0, bo - t), 0, 1) ** 1.5
        height = float(ys.max() - ys.min())
        amp = 0.06 * height
        # the hem swings sideways and rises a little on the side it swings to (a skirt is a cone)
        mid = (xs.min() + xs.max()) / 2
        side = np.clip((P[..., 0] - mid) / max(1.0, (xs.max() - xs.min()) / 2), -1, 1)
        d = np.stack([amp * u, -0.25 * amp * u * side], -1).astype(np.float32)
        p.keys['swaySkirt'] = {-1.0: d * np.float32([-1, -1]), 0.0: np.zeros_like(d), 1.0: d}
        physics.append(dict(param='swaySkirt', inputs={'bodyZ': 1.0, 'bodyX': 0.6, 'bodyY': 0.3},
                            freq=1.5, damping=0.2, gain=1.1, wind=0.02, seed=97))
        break
    rig.physics = physics
    return physics


def hand_lag_physics(arms):
    """Pendulums for the hands (only when the model has arms)."""
    out = []
    for i, s in enumerate(arms or {}):
        out.append(dict(param=f'handLag{s}', inputs={f'arm{s}X': 0.8, f'arm{s}Y': -0.6, 'bodyZ': 0.5},
                        freq=2.2, damping=0.25, gain=0.9, wind=0.0, seed=90 + i))
    return out
