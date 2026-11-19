"""
Render a bundle v2 (model.json + parts/*.png) in Python, the same rules as engine/engine.js: keyforms add,
linear between values and clamped; opacity keyforms multiply; clip = drawn inside the named part (or group);
mask-only parts are never drawn. Groups are drawn as plain layers (close enough for checking).

For checking models without a browser (one picture per pose, e.g. after a pipeline run):

  python py/render_bundle.py <bundle dir> <out.png> [--scale 0.5] [--set angleX=1 bodyZ=-1 ...]
  python py/render_bundle.py <bundle dir> <out.png> --sheet      a sheet of the main poses
"""
import argparse
import json
import os

import cv2
import numpy as np
from PIL import Image


def interp(values, items, v):
    v = float(np.clip(v, values[0], values[-1]))
    for i in range(len(values) - 1):
        if values[i] <= v <= values[i + 1]:
            t = (v - values[i]) / max(1e-9, values[i + 1] - values[i])
            return items[i] * (1 - t) + items[i + 1] * t
    return items[0]


def solve_arm(A, ax, ay):
    """engine.js solveArm: wrist offset (arm lengths) -> shoulder and elbow angles (radians)."""
    S, E, W = (np.asarray(A[k], float) for k in 'SEW')
    L1, L2 = np.hypot(*(E - S)), np.hypot(*(W - E))
    reach = L1 + L2
    T = W + np.array([ax * A['out'] * reach, -ay * reach])
    d = max(np.hypot(*(T - S)), 1e-6)
    dc = min(max(d, abs(L1 - L2) + 1e-3 * reach), reach)
    T = S + (T - S) / d * dc
    base = np.arctan2(T[1] - S[1], T[0] - S[0])
    a = np.arccos(np.clip((L1 * L1 + dc * dc - L2 * L2) / (2 * L1 * dc), -1, 1))
    best = None
    for sg in (1, -1):
        ang = base + sg * a
        e = S + L1 * np.array([np.cos(ang), np.sin(ang)])
        score = (e[0] - S[0]) * A['out']
        if best is None or score > best[0] + 1e-6:
            best = (score, ang, e)
    wrap = lambda t: float(np.arctan2(np.sin(t), np.cos(t)))
    sh = wrap(best[1] - np.arctan2(E[1] - S[1], E[0] - S[0]))
    fore = np.arctan2(T[1] - best[2][1], T[0] - best[2][0]) - np.arctan2(W[1] - E[1], W[0] - E[0])
    return {'sh': sh, 'el': wrap(fore - sh)}


class Bundle:
    def __init__(self, d):
        self.dir = d
        self.json = json.load(open(os.path.join(d, 'model.json'), encoding='utf-8'))
        self.defaults = {p['id']: p.get('default', 0) for p in self.json['params']}
        self.tex = {}

    def texture(self, p):
        if p['texture'] not in self.tex:
            im = np.asarray(Image.open(os.path.join(self.dir, p['texture'])).convert('RGBA'), np.float32) / 255
            im = im.copy()
            im[..., :3] *= im[..., 3:]                       # premultiplied
            self.tex[p['texture']] = im
        return self.tex[p['texture']]

    def disp(self, p, params):
        g = p['grid']
        n = (g['ny'] + 1) * (g['nx'] + 1) * 2
        d = np.zeros(n, np.float32)
        for pid, k in p['keys'].items():
            v = params.get(pid, self.defaults.get(pid, 0))
            d += interp(k['values'], [np.asarray(x, np.float32) for x in k['disp']], v)
        d = d.reshape(g['ny'] + 1, g['nx'] + 1, 2)
        arms = self.json.get('arms')
        if p.get('bones') and arms:
            x0, y0, x1, y1 = g['box']
            xs, ys = np.meshgrid(np.linspace(x0, x1, g['nx'] + 1), np.linspace(y0, y1, g['ny'] + 1))
            rest = np.stack([xs, ys], -1).reshape(-1, 2)
            pts = rest.copy()
            for b in p['bones']:
                A = arms[b['arm']]
                ax, ay = params.get(f"arm{b['arm']}X", 0), params.get(f"arm{b['arm']}Y", 0)
                hand = params.get(f"hand{b['arm']}", 0)
                if not (ax or ay or hand):
                    continue
                ang = solve_arm(A, ax, ay) if (ax or ay) else {'sh': 0.0, 'el': 0.0}
                ang['wr'] = -0.35 * (ang['sh'] + ang['el']) + hand * 0.698
                t = ang[b['joint']] * np.asarray(b['w'])
                px, py = {'el': A['E'], 'wr': A['W']}.get(b['joint'], A['S'])
                c, s_ = np.cos(t), np.sin(t)
                x, y = pts[:, 0] - px, pts[:, 1] - py
                pts = np.stack([px + x * c - y * s_, py + x * s_ + y * c], -1)
            d = d + (pts - rest).reshape(d.shape).astype(np.float32)
        return d

    def alpha(self, p, params):
        a = 1.0
        for pid, o in p.get('opacity', {}).items():
            a *= float(interp(o['values'], [np.float32(x) for x in o['alpha']], params.get(pid, self.defaults.get(pid, 0))))
        return a

    def render_part(self, p, params, H, W, s):
        """Premultiplied RGBA layer (H, W, 4) at output scale s."""
        g = p['grid']
        x0, y0, x1, y1 = g['box']
        D = self.disp(p, params)
        # displacement field over the output canvas (bilinear in each cell, clamped outside the grid)
        ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
        qx, qy = (xs + 0.5) / s, (ys + 0.5) / s

        def field(px, py):
            u = np.clip((px - x0) / max(1e-6, x1 - x0), 0, 1) * g['nx']
            v = np.clip((py - y0) / max(1e-6, y1 - y0), 0, 1) * g['ny']
            # cv2.remap does the bilinear lookup in the control grid
            dx = cv2.remap(np.ascontiguousarray(D[..., 0]), u, v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            dy = cv2.remap(np.ascontiguousarray(D[..., 1]), u, v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            return dx, dy

        px, py = qx.copy(), qy.copy()
        for _ in range(6):                                   # invert q = p + D(p)
            dx, dy = field(px, py)
            px, py = qx - dx, qy - dy
        tex = self.texture(p)
        rx, ry, rw, rh = p['rect']
        th, tw = tex.shape[:2]
        mu = ((px - rx) / rw * tw - 0.5).astype(np.float32)
        mv = ((py - ry) / rh * th - 0.5).astype(np.float32)
        return cv2.remap(tex, mu, mv, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)

    def render_part_mesh(self, p, params, H, W, s, step=10):
        """Forward mesh drawing, like the engine (for big rotations, where inverting the warp fails)."""
        g = p['grid']
        x0, y0, x1, y1 = g['box']
        D = self.disp(p, params)
        tex = self.texture(p)
        th, tw = tex.shape[:2]
        rx, ry, rw, rh = p['rect']
        cols, rows = max(1, int(np.ceil(rw / step))), max(1, int(np.ceil(rh / step)))
        u, v = np.meshgrid(np.linspace(0, 1, cols + 1), np.linspace(0, 1, rows + 1))
        X, Y = rx + rw * u, ry + rh * v
        gu = (np.clip((X - x0) / max(1e-6, x1 - x0), 0, 1) * g['nx']).astype(np.float32)
        gv = (np.clip((Y - y0) / max(1e-6, y1 - y0), 0, 1) * g['ny']).astype(np.float32)
        dx = cv2.remap(np.ascontiguousarray(D[..., 0]), gu, gv, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        dy = cv2.remap(np.ascontiguousarray(D[..., 1]), gu, gv, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        PX, PY = (X + dx) * s, (Y + dy) * s
        TU, TV = u * tw, v * th
        out = np.zeros((H, W, 4), np.float32)
        for r in range(rows):
            for c in range(cols):
                for tri in (((r, c), (r, c + 1), (r + 1, c)), ((r, c + 1), (r + 1, c + 1), (r + 1, c))):
                    src = np.float32([[TU[i, j], TV[i, j]] for i, j in tri])
                    dst = np.float32([[PX[i, j], PY[i, j]] for i, j in tri])
                    bx0, by0 = np.floor(dst.min(0)).astype(int) - 1
                    bx1, by1 = np.ceil(dst.max(0)).astype(int) + 2
                    bx0, by0, bx1, by1 = max(bx0, 0), max(by0, 0), min(bx1, W), min(by1, H)
                    if bx1 <= bx0 or by1 <= by0:
                        continue
                    M = cv2.getAffineTransform(src, dst - np.float32([bx0, by0]))
                    patch = cv2.warpAffine(tex, M, (bx1 - bx0, by1 - by0), flags=cv2.INTER_LINEAR,
                                           borderMode=cv2.BORDER_CONSTANT, borderValue=0)
                    m = np.zeros((by1 - by0, bx1 - bx0), np.uint8)
                    cv2.fillConvexPoly(m, np.round((dst - [bx0, by0]) * 16).astype(np.int32), 1, cv2.LINE_8, 4)
                    m = cv2.dilate(m, np.ones((2, 2), np.uint8)).astype(bool)
                    o = out[by0:by1, bx0:bx1]
                    o[m] = patch[m]
        return out

    def render(self, params=None, scale=0.5, bg=(1, 1, 1)):
        params = params or {}
        W, H = self.json['canvas']
        W, H = int(W * scale), int(H * scale)
        parts = self.json['parts']
        clips = {p['clip'] for p in parts if p.get('clip')}
        masks = {}
        for name in clips:
            m = np.zeros((H, W), np.float32)
            for p in parts:
                if (p['name'] == name or p.get('group') == name):
                    a = self.alpha(p, params)
                    if a > 0.001:
                        l = self.render_part(p, params, H, W, scale)[..., 3] * a
                        m = l + m * (1 - l)
            masks[name] = m
        out = np.zeros((H, W, 3), np.float32) + np.asarray(bg, np.float32)
        for p in parts:
            if p.get('maskOnly'):
                continue
            a = self.alpha(p, params)
            if a <= 0.001:
                continue
            moved = p.get('bones') and any(params.get(f"{k}{b['arm']}{x}", 0) for b in p['bones']
                                           for k, x in (('arm', 'X'), ('arm', 'Y'), ('hand', '')))
            l = (self.render_part_mesh(p, params, H, W, scale) if moved else self.render_part(p, params, H, W, scale)) * a
            if p.get('clip'):
                l = l * masks[p['clip']][..., None]
            out = l[..., :3] + out * (1 - l[..., 3:])
        return (np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8)


POSES = [('정면', {}), ('angleX -1', {'angleX': -1}), ('angleX +1', {'angleX': 1}), ('angleY +1', {'angleY': 1}),
         ('bodyZ -1', {'bodyZ': -1}), ('bodyZ +1', {'bodyZ': 1}), ('bodyX -1', {'bodyX': -1}), ('bodyX +1', {'bodyX': 1}),
         ('breath 1', {'breath': 1}), ('눈 감기', {'eyeOpenL': 0, 'eyeOpenR': 0}), ('웃는 눈', {'eyeSmile': 1}),
         ('입 벌림', {'mouthOpen': 1})]


def sheet(b, scale, crop=None):
    from PIL import ImageDraw
    ims = []
    for label, ps in POSES:
        big = Image.fromarray(b.render(ps, min(1.0, scale * 2)))      # drawn larger, then reduced: thin lines stay whole
        im = big.resize((int(b.json['canvas'][0] * scale), int(b.json['canvas'][1] * scale)), Image.LANCZOS)
        if crop:
            im = im.crop(crop)
        ImageDraw.Draw(im).text((8, 8), label, fill=(200, 0, 0))
        ims.append(im)
    w, h = ims[0].size
    cols = 4
    out = Image.new('RGB', (w * cols, h * ((len(ims) + cols - 1) // cols)), 'white')
    for i, im in enumerate(ims):
        out.paste(im, ((i % cols) * w, (i // cols) * h))
    return out


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('bundle')
    ap.add_argument('out')
    ap.add_argument('--scale', type=float, default=0.5)
    ap.add_argument('--set', nargs='*', default=[])
    ap.add_argument('--sheet', action='store_true')
    a = ap.parse_args()
    b = Bundle(a.bundle)
    if a.sheet:
        sheet(b, a.scale).save(a.out)
    else:
        ps = {k: float(v) for k, v in (x.split('=') for x in a.set)}
        Image.fromarray(b.render(ps, a.scale)).save(a.out)
    print(a.out)
