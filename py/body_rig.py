"""
Body motion (the artisan's step after the face: body angle X / Y / Z and breathing, Live2D's ParamBodyAngleX/Y/Z
and ParamBreath). Everything above the waist hangs on one chain - waist -> chest -> shoulders -> neck -> head - so
every part (the head's too) gets its keyforms from where its control points sit, not from its name:

  bodyZ   -1..1  the upper body leans sideways about the waist (+-6 deg). The waist row stays, the bend grows
                 toward the chest and is whole from the shoulders up: the head rides on it (rotated with it).
  bodyX   -1..1  the torso turns (+-12 deg) as a cylinder: its front moves sideways, the far side narrows. Above the
                 neck everything moves as one block by the neck front's shift (the head turns on its own: angleX).
  bodyY   -1..1  the upper body straightens (+) / slumps (-): a small vertical stretch from the waist.
  breath   0..1  shoulders and chest rise (the chest stretches), the head rides on the shoulders; the waist stays.
  angleZ   -1..1  the head tilts (+-14 deg) about the top of the neck (Live2D ParamAngleZ); clothes and arms stay.

Displacements are in the model canvas and stored in each part's own canvas units (/k for parts placed by xf).
"""
import numpy as np

BODY_PARAMS = [dict(id='angleZ', min=-1, max=1, default=0),
               dict(id='bodyX', min=-1, max=1, default=0), dict(id='bodyY', min=-1, max=1, default=0),
               dict(id='bodyZ', min=-1, max=1, default=0), dict(id='breath', min=0, max=1, default=0)]

DEG_Z, DEG_X = 6.0, 12.0


def smooth(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def frame(body_parts, L, canvas):
    """Waist row (the pivot of the upper body), neck row, torso centre and half width, from the body's layers."""
    H, W = canvas
    names = ('topwear', 'bottomwear', 'neck', 'handwear')
    alpha = np.zeros((H, W), np.float32)
    for p in body_parts:
        if p.name in names:
            alpha = np.maximum(alpha, p.rgba[..., 3])
    ys, xs = np.nonzero(alpha > 0.5)
    neck_y = float(L['chin_y'])
    if len(ys) < 100:                                     # no clothes found: the canvas below the chin
        return dict(waist=float(H), neck=neck_y, cx=float(L['cx']), hw=0.25 * W)
    waist = float(ys.max())
    # a skirt / trousers below: the waist is where they start (the waistband), not their hem
    bottom = [p.rgba[..., 3] for p in body_parts if p.name == 'bottomwear']
    if bottom:
        by = np.nonzero((np.max(bottom, 0) > 0.5).any(1))[0]
        if len(by) and neck_y + 0.3 * (waist - neck_y) < by.min() < waist:
            waist = float(by.min())
    # the torso's width at the chest (a third of the way from the neck to the waist), around the neck's centre
    yc = int(neck_y + 0.35 * (waist - neck_y))
    row = np.nonzero(alpha[min(H - 1, max(0, yc))] > 0.5)[0]
    cx = float(L['cx'])
    hw = 0.5 * float(row.max() - row.min()) if len(row) > 10 else 0.25 * W
    # arms hanging beside the body widen that row; the chest itself is rarely wider than ~2.2 heads
    hw = min(hw, 2.2 * L['half'])
    return dict(waist=waist, neck=neck_y, cx=cx, hw=max(hw, 10.0))


def bend(y, F):
    """0 at the waist, 1 from a little below the neck up."""
    return smooth((F['waist'] - y) / max(1.0, 0.75 * (F['waist'] - F['neck'])))


def disp_z(P, F, v):
    x, y = P[..., 0], P[..., 1]
    t = np.radians(DEG_Z * v) * bend(y, F)
    px, py = F['cx'], F['waist']
    dx, dy = x - px, y - py
    nx = px + dx * np.cos(t) + dy * np.sin(t)
    ny = py - dx * np.sin(t) + dy * np.cos(t)
    return np.stack([nx - x, ny - y], -1)


def disp_x(P, F, v):
    x, y = P[..., 0], P[..., 1]
    t = np.radians(DEG_X * v)
    hw, depth = F['hw'], 0.6
    u = np.clip((x - F['cx']) / hw, -1, 1)
    xr = x - F['cx']
    z = np.sqrt(1 - u * u) * hw * depth
    body = xr * np.cos(t) + z * np.sin(t) - xr
    # above the neck: one block, moved like the neck's front
    head = np.full_like(x, hw * depth * np.sin(t))
    h = smooth((F['neck'] + 0.1 * (F['waist'] - F['neck']) - y) / max(1.0, 0.2 * (F['waist'] - F['neck'])))
    dx = (body * (1 - h) + head * h) * bend(y, F)
    return np.stack([dx, np.zeros_like(dx)], -1)


def disp_y(P, F, v):
    y = np.maximum(P[..., 1], F['neck'])                  # above the neck: moved like the neck, not stretched
    dy = (y - F['waist']) * 0.025 * v * bend(y, F)
    return np.stack([np.zeros_like(dy), dy], -1)


def disp_breath(P, F, v):
    y = P[..., 1]
    A = 0.018 * (F['waist'] - F['neck'])
    g = smooth((F['waist'] - y) / max(1.0, F['waist'] - F['neck']))
    dy = -A * v * g                                       # from the shoulders up one block: the head is never squashed
    return np.stack([np.zeros_like(dy), dy], -1)


DEG_HEAD_Z = 14.0


def disp_head_z(P, F, v, R):
    """angleZ: the head tilts about the top of the neck (just under the chin); the neck bends a little; hair
    hanging below the chin goes with the head, less and less toward its ends."""
    x, y = P[..., 0], P[..., 1]
    px, py = F['cx'], F['neck'] + 0.25 * R
    w = smooth((py + 0.6 * R - y) / (0.9 * R))            # 1 on the head, fading over the neck / hanging hair
    t = np.radians(DEG_HEAD_Z * v) * w
    dx, dy = x - px, y - py
    nx = px + dx * np.cos(t) + dy * np.sin(t)
    ny = py - dx * np.sin(t) + dy * np.cos(t)
    return np.stack([nx - x, ny - y], -1)


def add_body_keys(specs, F, R=None):
    """Adds bodyX / bodyY / bodyZ / breath keyforms to every part spec (export_bundle.part_spec dicts)."""
    for s in specs:
        k, ox, oy = s.get('xf') or (1.0, 0.0, 0.0)
        G = s['warp'].rest
        P = np.stack([ox + k * G[..., 0], oy + k * G[..., 1]], -1)
        keys = dict(s['keys'])
        f = lambda d: (d / k).astype(np.float32)
        z = np.zeros_like(G, np.float32)
        keys['bodyZ'] = {v: (f(disp_z(P, F, v)) if v else z) for v in (-1.0, -0.5, 0.0, 0.5, 1.0)}
        keys['bodyX'] = {v: (f(disp_x(P, F, v)) if v else z) for v in (-1.0, -0.5, 0.0, 0.5, 1.0)}
        keys['bodyY'] = {-1.0: f(disp_y(P, F, -1.0)), 0.0: z, 1.0: f(disp_y(P, F, 1.0))}
        keys['breath'] = {0.0: z, 1.0: f(disp_breath(P, F, 1.0))}
        if R is not None and not (s.get('bones') or s['name'].startswith(('topwear', 'bottomwear', 'legwear'))):
            keys['angleZ'] = {v: (f(disp_head_z(P, F, v, R)) if v else z) for v in (-1.0, -0.5, 0.0, 0.5, 1.0)}
        s['keys'] = keys
    return specs


def drive_physics(physics):
    """Hair swings with the body too (the head rides on it)."""
    for e in physics:
        e['inputs'] = dict(dict(bodyX=0.5, bodyZ=0.8), **e.get('inputs', {}))   # an entry's own inputs win
    return physics
