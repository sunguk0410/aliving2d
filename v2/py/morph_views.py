"""
Head angle X from a turnaround sheet: front view + three-quarter views drawn by AI, each split into parts.

For every part that exists in both views (same name, left/right split the same way):
  K     control displacements that move the FRONT part onto the side part's shape:
        artisan-rule guess (artisan.turn_disp), refined by optical flow between the guessed front part and the
        side part (one part at a time, so the flow sees the same drawing on both sides)
  Ks    displacements that move the SIDE part back onto the front shape (the inverse of K, sampled on the
        side part's own grid)
At angle t (0..1 toward a side): front part moved by t*K, side part moved by (1-t)*Ks, and the two blended
(premultiplied) with s(t) = smoothstep(0.3, 0.85, t), so the drawing changes while both shapes agree.
That is what a Live2D modeler does with an opacity keyform between two drawn angles.

  python v2/py/morph_views.py <front psd> <neg psd> <pos psd> <out dir> [--deg 25]
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from rig import load_psd, render_part, composite  # noqa: E402
from artisan import landmarks, split_pairs, artisan_order, turn_disp  # noqa: E402
from fit_turn import grid_laplacian  # noqa: E402

GREY = 0.5
EYE_KEYS = ('eyeX', 'eyeY', 'eyeOpenL', 'eyeOpenR', 'eyeSmile')


def prep(psd):
    rig = load_psd(psd, grid=60)
    L = landmarks(rig)
    split_pairs(rig, L['cx'])
    artisan_order(rig)
    from eyes_rig import add_gaze
    from blink_rig import add_blink
    add_gaze(rig)
    add_blink(rig)
    return rig, L


def on_grey(rgba):
    return rgba[..., :3] * rgba[..., 3:4] + GREY * (1 - rgba[..., 3:4])


def part_flow(a, b, box):
    """Flow a -> b (RGBA parts) inside box, colours over grey plus the alpha as a strong channel."""
    x0, y0, x1, y1 = box
    def img(p):
        c = on_grey(p[y0:y1, x0:x1])
        g = cv2.cvtColor((np.clip(c, 0, 1) * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32)
        al = p[y0:y1, x0:x1, 3] * 255
        return np.clip(0.5 * g + 0.5 * al, 0, 255).astype(np.uint8)
    ga, gb = img(a), img(b)
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    dis.setFinestScale(0)
    f = dis.calc(ga, gb, None)
    r = dis.calc(gb, ga, None)
    h, w = ga.shape
    gy, gx = np.mgrid[0:h, 0:w].astype(np.float32)
    back = cv2.remap(r, gx + f[..., 0], gy + f[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    conf = np.exp(-(np.linalg.norm(f + back, axis=-1) / 1.5) ** 2)
    return f, conf


def fit_grid(warp, x, y, target, w, prior, lam=0.05, mu=0.3):
    """Least squares control displacements: bilinear(warp at x, y) ~ target, near `prior`, smooth."""
    A = warp.weights(x, y)
    n_cp = prior.shape[0] * prior.shape[1]
    Lp = grid_laplacian(prior.shape[0] - 1, prior.shape[1] - 1)
    s = max(1.0, len(x) / n_cp)
    sw = np.sqrt(w)[:, None]
    M = np.concatenate([A * sw, np.eye(n_cp, dtype=np.float32) * np.sqrt(lam * s), Lp * np.sqrt(mu * s)])
    out = np.zeros_like(prior)
    for c in range(2):
        p0 = prior[..., c].ravel()
        b = np.concatenate([target[:, c] * sw[:, 0], p0 * np.sqrt(lam * s), Lp @ p0 * np.sqrt(mu * s)])
        out[..., c] = np.linalg.lstsq(M, b, rcond=None)[0].reshape(prior.shape[:2])
    return out


def match_part(fp, sp, L, deg, size):
    """K (front -> side shape) and Ks (side -> front shape) for one part pair."""
    H, W = size
    K0 = turn_disp(fp, L, deg, L['R'], L['D'])
    fp.keys['t'] = {0.0: np.zeros_like(K0), 1.0: K0}
    guess = render_part(fp, {'t': 1.0}, H, W)
    both = (guess[..., 3] > 0.02) | (sp.rgba[..., 3] > 0.02)
    ys, xs = np.nonzero(both)
    pad = 24
    box = (max(0, xs.min() - pad), max(0, ys.min() - pad), min(W, xs.max() + pad), min(H, ys.max() + pad))
    f, conf = part_flow(guess, sp.rgba, box)
    # front pixels, where they land under K0, and where the flow takes them from there
    a = fp.rgba[..., 3] > 0.5
    py, px = np.nonzero(a)
    sel = np.arange(len(px))[:: max(1, len(px) // 6000)]
    px, py = px[sel].astype(np.float32), py[sel].astype(np.float32)
    D0 = fp.warp.field(K0, H, W)
    qx = px + D0[py.astype(int), px.astype(int), 0]
    qy = py + D0[py.astype(int), px.astype(int), 1]
    bx = np.clip((qx - box[0]).round().astype(int), 0, f.shape[1] - 1)
    by = np.clip((qy - box[1]).round().astype(int), 0, f.shape[0] - 1)
    inside = (qx >= box[0]) & (qx < box[2]) & (qy >= box[1]) & (qy < box[3])
    tx = qx + np.where(inside, f[by, bx, 0], 0) - px
    ty = qy + np.where(inside, f[by, bx, 1], 0) - py
    w = np.where(inside, conf[by, bx], 0.05)
    K = fit_grid(fp.warp, px, py, np.stack([tx, ty], 1), w, K0)
    # inverse on the side part's grid: q = p + K(p)  ->  Ks(q) = p - q
    DK = fp.warp.field(K, H, W)
    q = sp.warp.rest.reshape(-1, 2).astype(np.float32)
    p = q.copy()
    for _ in range(8):
        ix = np.clip(p[:, 0].round().astype(int), 0, W - 1)
        iy = np.clip(p[:, 1].round().astype(int), 0, H - 1)
        p = q - DK[iy, ix]
    Ks = (p - q).reshape(sp.warp.rest.shape).astype(np.float32)
    del fp.keys['t']
    return K, Ks


def smooth(t, a=0.3, b=0.85):
    u = np.clip((t - a) / (b - a), 0, 1)
    return u * u * (3 - 2 * u)


class Morph:
    def __init__(self, front, sides, size):
        self.front, self.sides, self.size = front, sides, size       # sides: {+1: (rig, pairs), -1: ...}

    def render(self, t):
        H, W = self.size
        sgn = 1.0 if t >= 0 else -1.0
        a = abs(t)
        side_rig, pairs = self.sides[sgn]
        s = smooth(a)
        layers = []
        for fp in self.front.parts:
            K = pairs.get(fp.name, (None, None, None))[0]
            if K is None:                                        # no partner: rule only, fades out late
                fp.keys['t'] = {0.0: np.zeros_like(fp.warp.rest), 1.0: turn_disp(fp, self.L, sgn * self.deg, self.L['R'], self.L['D'])}
                L1 = render_part(fp, {'t': a}, H, W)
                layers.append(L1)
                continue
            fp.keys['t'] = {0.0: np.zeros_like(K), 1.0: K}
            F = render_part(fp, {'t': a}, H, W)
            sp, Ks = pairs[fp.name][1], pairs[fp.name][2]
            sp.keys['t'] = {0.0: np.zeros_like(Ks), 1.0: Ks}
            S = render_part(sp, {'t': 1 - a}, H, W)
            pf = F[..., :3] * F[..., 3:4] * (1 - s) + S[..., :3] * S[..., 3:4] * s
            al = F[..., 3:4] * (1 - s) + S[..., 3:4] * s
            layers.append(np.concatenate([pf / np.maximum(al, 1e-6), al], -1))
        return composite(layers)


def export(m, out, deg_y=14.0):
    """Bundle v2: every front part plus its three-quarter drawings as one blend group with opacity keyforms."""
    from export_bundle import part_spec, write
    from artisan import nod_disp
    L = m.L
    ts = [round(float(t), 3) for t in np.linspace(0, 1, 11)]
    fade = [round(float(smooth(t)), 4) for t in ts]
    specs = []
    for fp in m.front.parts:
        z = np.zeros_like(fp.warp.rest)
        kx = {0.0: z}
        partners = {}
        for sgn in (-1.0, 1.0):
            _, pairs = m.sides[sgn]
            if fp.name in pairs:
                kx[sgn] = pairs[fp.name][0]
                partners[sgn] = pairs[fp.name]
            else:
                kx[sgn] = turn_disp(fp, L, sgn * m.deg, L['R'], L['D'])
        ky = {-1.0: nod_disp(fp, L, -deg_y, L['R'], L['D']), 0.0: z, 1.0: nod_disp(fp, L, deg_y, L['R'], L['D'])}
        # front opacity: fades out toward a side that has a drawing for this part
        vals, al = [], []
        for t, f in zip(ts[::-1], fade[::-1]):
            vals.append(-t); al.append(1 - f if -1.0 in partners else 1.0)
        for t, f in zip(ts[1:], fade[1:]):
            vals.append(t); al.append(1 - f if 1.0 in partners else 1.0)
        group = fp.name if partners else None
        eyes = {k: v for k, v in fp.keys.items() if k in EYE_KEYS}
        specs.append(part_spec(fp.name, fp.rgba, fp.warp, {'angleX': kx, 'angleY': ky, **eyes},
                               {'angleX': (vals, al)}, group, fp.clip, fp.mask_only))
        for sgn, (K, sp, Ks) in partners.items():
            zs = np.zeros_like(sp.warp.rest)
            kxs = {0.0: Ks, sgn: zs}
            kys = {-1.0: nod_disp(sp, L, -deg_y, L['R'], L['D']), 0.0: zs, 1.0: nod_disp(sp, L, deg_y, L['R'], L['D'])}
            if sgn > 0:
                vs, a = [-1.0] + ts, [0.0] + fade
            else:
                vs, a = [-t for t in ts[::-1]] + [1.0], fade[::-1] + [0.0]
            eyes = {k: v for k, v in sp.keys.items() if k in EYE_KEYS}
            specs.append(part_spec(f'{fp.name}@{"+" if sgn > 0 else "-"}', sp.rgba, sp.warp, {'angleX': kxs, 'angleY': kys, **eyes},
                                   {'angleX': (vs, a)}, group, sp.clip, sp.mask_only))
    return write(specs, m.front.size, out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('front')
    ap.add_argument('neg')
    ap.add_argument('pos')
    ap.add_argument('out')
    ap.add_argument('--deg', type=float, default=25)
    ap.add_argument('--bundle', default=None, help='also write a bundle v2 here')
    ap.add_argument('--gif', action='store_true', help='also render a sweep GIF in Python (slow; the viewer is faster)')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    front, L = prep(a.front)
    L['R'] = L['half'] * 1.04
    L['D'] = L['R'] * 0.95
    sides, report = {}, {}
    for sgn, path in ((-1.0, a.neg), (1.0, a.pos)):
        rig, _ = prep(path)
        byname = {p.name: p for p in rig.parts}
        pairs = {}
        for fp in front.parts:
            sp = byname.get(fp.name)
            if sp is None:
                continue
            K, Ks = match_part(fp, sp, L, sgn * a.deg, front.size)
            pairs[fp.name] = (K, sp, Ks)
        sides[sgn] = (rig, pairs)
        report[str(sgn)] = dict(paired=sorted(pairs), missing=[p.name for p in front.parts if p.name not in pairs])
    m = Morph(front, sides, front.size)
    m.L, m.deg = L, a.deg
    cx, ey, R = int(L['cx']), int(L['eye_y']), L['R']
    s = int(R * 2.8)
    H, W = front.size
    crop = (max(0, cx - s // 2), max(0, ey - int(s * 0.5)), min(W, cx + s // 2), min(H, ey + int(s * 0.7)))
    cut = lambda im: im[crop[1]:crop[3], crop[0]:crop[2]]
    row = [cut(m.render(t)) for t in (-1.0, -0.5, 0.0, 0.5, 1.0)]
    img = np.concatenate(row, 1)
    img = cv2.resize(img, (img.shape[1] // 2, img.shape[0] // 2), interpolation=cv2.INTER_AREA)
    Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).save(os.path.join(a.out, 'keys.png'))
    frames = []
    for t in ([] if not a.gif else  np.concatenate([np.linspace(0, 1, 10), np.linspace(1, -1, 20), np.linspace(-1, 0, 10)])):
        im = cut(m.render(float(t)))
        frames.append(Image.fromarray((np.clip(cv2.resize(im, (im.shape[1] // 2, im.shape[0] // 2), interpolation=cv2.INTER_AREA), 0, 1) * 255).astype(np.uint8)))
    if frames:
        frames[0].save(os.path.join(a.out, 'sweep.gif'), save_all=True, append_images=frames[1:], duration=50, loop=0)
    json.dump(report, open(os.path.join(a.out, 'report.json'), 'w'), indent=1)
    if a.bundle:
        export(m, a.bundle)
    print(json.dumps(report))


if __name__ == '__main__':
    main()
