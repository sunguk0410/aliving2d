"""
Experiment 3: head angle X keyforms from AI target pictures.

  1. optical flow (OpenCV DIS) from the neutral picture to a target (same character, head turned)
  2. draft from depth: every part's control points move by k * (depth - z0) + c * (x - cx) (a turn about a
     vertical axis, seen from the front); k, c fitted to the flow on the face
  3. fit: per part, control displacements by least squares to the flow on that part's visible pixels, held
     near the draft (no data = the draft) and kept smooth
  4. renders at -1 / 0 / +1 for draft and fit, errors against the targets, and a sweep strip

  python v2/py/fit_turn.py <psd> <depth dir> <neutral src.png> <target -1> <target +1> <out dir>
"""
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from rig import load_psd, render_part, composite  # noqa: E402


def load_rgb(path, size):
    return np.asarray(Image.open(path).convert('RGB').resize(size[::-1], Image.LANCZOS)).astype(np.float32) / 255.0


def flow(a, b, scale=0.5):
    """Dense flow a -> b (pixels at full size) and a confidence from forward-backward consistency."""
    H, W = a.shape[:2]
    g = lambda im: cv2.cvtColor((cv2.resize(im, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
    ga, gb = g(a), g(b)
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    dis.setFinestScale(0)
    f = dis.calc(ga, gb, None)
    r = dis.calc(gb, ga, None)
    h, w = ga.shape
    gy, gx = np.mgrid[0:h, 0:w].astype(np.float32)
    back = cv2.remap(r, gx + f[..., 0], gy + f[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    err = np.linalg.norm(f + back, axis=-1)
    conf = np.exp(-(err / 1.5) ** 2)
    F = cv2.resize(f, (W, H), interpolation=cv2.INTER_LINEAR) / scale
    C = cv2.resize(conf, (W, H), interpolation=cv2.INTER_LINEAR)
    return F, C


def align(N, T, mask):
    """Affine-align target T onto neutral N using only `mask` (neck / shoulders: they stay put when only the
    head turns). GPT reframes its output a little; without this the flow is mostly framing."""
    s = 0.5
    g = lambda im: cv2.cvtColor((cv2.resize(im, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32)
    m = (cv2.resize(mask.astype(np.uint8), None, fx=s, fy=s, interpolation=cv2.INTER_NEAREST) > 0).astype(np.uint8)
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        _, warp = cv2.findTransformECC(g(N), g(T), warp, cv2.MOTION_AFFINE,
                                       (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-5), m, 5)
    except cv2.error:
        pass
    warp[:, 2] /= s
    H, W = N.shape[:2]
    return cv2.warpAffine(T, warp, (W, H), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE), warp


def owners(rig):
    """Index of the top-most opaque part at each pixel (-1 = background)."""
    H, W = rig.size
    own = np.full((H, W), -1, np.int32)
    for i, p in enumerate(rig.parts):
        own[p.rgba[..., 3] > 0.5] = i
    return own


def part_depth_at(part, pts):
    """Depth of the part at control points; points off the part take the nearest part pixel's depth."""
    from scipy import ndimage as ndi
    m = part.rgba[..., 3] > 0.3
    if part.depth is None or not m.any():
        return None
    _, (iy, ix) = ndi.distance_transform_edt(~m, return_indices=True)
    H, W = m.shape
    x = np.clip(pts[..., 0].round().astype(int), 0, W - 1)
    y = np.clip(pts[..., 1].round().astype(int), 0, H - 1)
    return part.depth[iy[y, x], ix[y, x]]


def fit_draft(rig, F, C, own):
    """k, c, offset of the depth draft from the flow on face / hair pixels."""
    rows, rhs, wts = [], [], []
    H, W = rig.size
    ys, xs = np.mgrid[0:H:3, 0:W:3]
    for i, p in enumerate(rig.parts):
        if p.depth is None or p.name not in ('face', 'front hair', 'nose', 'mouth', 'eyebrow', 'eyelash', 'ears'):
            continue
        m = (own[ys, xs] == i)
        if m.sum() < 30:
            continue
        x, y = xs[m], ys[m]
        rows.append(np.stack([p.depth[y, x], x.astype(np.float32), np.ones(len(x))], 1))
        rhs.append(F[y, x, 0])
        wts.append(C[y, x])
    A, b, w = np.concatenate(rows), np.concatenate(rhs), np.concatenate(wts)
    sw = np.sqrt(w)
    sol, *_ = np.linalg.lstsq(A * sw[:, None], b * sw, rcond=None)
    k, c, off = sol
    # disp = k*z + c*x + off  ->  k*(z - z0) + c*(x - cx) with the head's centre column cx: z0 = -(off + c*cx)/k
    cx = float(np.median(A[:, 1]))
    z0 = -(off + c * cx) / k if abs(k) > 1e-6 else 0.0
    return dict(k=float(k), c=float(c), cx=cx, z0=float(z0))


def draft_disp(part, d):
    pts = part.warp.rest
    z = part_depth_at(part, pts)
    if z is None:
        z = np.full(pts.shape[:2], 0.6, np.float32)
    dx = d['k'] * (z - d['z0']) + d['c'] * (pts[..., 0] - d['cx'])
    dy = np.zeros_like(dx)
    return np.stack([dx, dy], -1).astype(np.float32)


def grid_laplacian(ny, nx):
    n = (ny + 1) * (nx + 1)
    rows = []
    idx = lambda j, i: j * (nx + 1) + i
    for j in range(ny + 1):
        for i in range(nx + 1):
            for dj, di in ((0, 1), (1, 0)):
                if j + dj <= ny and i + di <= nx:
                    r = np.zeros(n, np.float32)
                    r[idx(j, i)], r[idx(j + dj, i + di)] = -1, 1
                    rows.append(r)
    return np.array(rows)


def fit_part(part, i, F, C, own, draft, lam=0.15, mu=0.4):
    H, W = own.shape
    ys, xs = np.mgrid[0:H:2, 0:W:2]
    m = (own[ys, xs] == i)
    n_cp = draft.shape[0] * draft.shape[1]
    if m.sum() < 20:
        return draft, 0
    x, y = xs[m].astype(np.float32), ys[m].astype(np.float32)
    A = part.warp.weights(x, y)
    w = C[ys[m], xs[m]]
    sw = np.sqrt(w)[:, None]
    L = grid_laplacian(draft.shape[0] - 1, draft.shape[1] - 1)
    s = len(x) / n_cp
    M = np.concatenate([A * sw, np.eye(n_cp, dtype=np.float32) * np.sqrt(lam * s), L * np.sqrt(mu * s)])
    out = np.zeros_like(draft)
    for c in range(2):
        d0 = draft[..., c].ravel()
        b = np.concatenate([F[ys[m], xs[m], c] * sw[:, 0], d0 * np.sqrt(lam * s), (L @ d0) * np.sqrt(mu * s)])
        sol, *_ = np.linalg.lstsq(M, b, rcond=None)
        out[..., c] = sol.reshape(draft.shape[:2])
    return out, int(m.sum())


def head_mask(rig):
    m = np.zeros(rig.size, bool)
    for p in rig.parts:
        if p.name not in ('topwear', 'neckwear', 'handwear', 'objects'):
            m |= p.rgba[..., 3] > 0.5
    return m


def err(a, b, m):
    return float(np.abs(a - b)[m].mean())


def main(psd, depth_dir, neutral, tgt_neg, tgt_pos, out):
    os.makedirs(out, exist_ok=True)
    rig = load_psd(psd, depth_dir)
    H, W = rig.size
    N = load_rgb(neutral, (H, W))
    own = owners(rig)
    hm = head_mask(rig)
    report = {'parts': [p.name for p in rig.parts]}
    keys = {}
    body = np.zeros((H, W), bool)
    for p in rig.parts:
        if p.name in ('neck', 'topwear', 'neckwear'):
            body |= p.rgba[..., 3] > 0.5
    face = next(p for p in rig.parts if p.name == 'face').rgba[..., 3] > 0.5
    body &= ~face
    for val, tp in ((-1.0, tgt_neg), (1.0, tgt_pos)):
        if tp == 'mirror':                     # no usable target: the other side's draft, mirrored about x
            dn, _ = keys[-val]
            drafts = {k: v * np.array([-1, 1], np.float32) for k, v in dn.items()}
            keys[val] = (drafts, drafts)
            Image.fromarray((N * 255).astype(np.uint8)).save(os.path.join(out, f'target_{val:+.0f}.png'))
            continue
        T = load_rgb(tp, (H, W))
        F, C = flow(N, T)
        d = fit_draft(rig, F, C, own)
        drafts, fits = {}, {}
        for i, p in enumerate(rig.parts):
            dr = draft_disp(p, d)
            fi, n = fit_part(p, i, F, C, own, dr)
            drafts[p.name], fits[p.name] = dr, fi
        keys[val] = (drafts, fits)
        report[str(val)] = dict(draft=d, flow_mean_dx=float(F[..., 0][hm].mean()))
        Image.fromarray((T * 255).astype(np.uint8)).save(os.path.join(out, f'target_{val:+.0f}.png'))
    # renders
    results = {}
    for mode in ('draft', 'fit'):
        for p in rig.parts:
            p.keys['angleX'] = {0.0: np.zeros_like(p.warp.rest)}
            for val in (-1.0, 1.0):
                p.keys['angleX'][val] = keys[val][0 if mode == 'draft' else 1][p.name]
        for val in (-1.0, 1.0):
            R = rig.render({'angleX': val})
            T = load_rgb(os.path.join(out, f'target_{val:+.0f}.png'), (H, W))
            results[(mode, val)] = R
            report.setdefault('error', {})[f'{mode} {val:+.0f}'] = err(R, T, hm)
            Image.fromarray((np.clip(R, 0, 1) * 255).astype(np.uint8)).save(os.path.join(out, f'{mode}_{val:+.0f}.png'))
        if mode == 'fit':
            rig.save_keys(os.path.join(out, 'keys_fit.json'))
            strip = [rig.render({'angleX': v}) for v in np.linspace(-1, 1, 9)]
            S = np.concatenate([cv2.resize(s, (W // 3, H // 3), interpolation=cv2.INTER_AREA) for s in strip], 1)
            Image.fromarray((np.clip(S, 0, 1) * 255).astype(np.uint8)).save(os.path.join(out, 'sweep_fit.png'))
            frames = [Image.fromarray((np.clip(cv2.resize(rig.render({'angleX': float(v)}), (W // 2, H // 2), interpolation=cv2.INTER_AREA), 0, 1) * 255).astype(np.uint8))
                      for v in np.concatenate([np.linspace(0, 1, 8), np.linspace(1, -1, 16), np.linspace(-1, 0, 8)])]
            frames[0].save(os.path.join(out, 'sweep_fit.gif'), save_all=True, append_images=frames[1:], duration=60, loop=0)
    R0 = rig.render({})
    for val in (-1.0, 1.0):
        T = load_rgb(os.path.join(out, f'target_{val:+.0f}.png'), (H, W))
        report['error'][f'no-move {val:+.0f}'] = err(R0, T, hm)
    json.dump(report, open(os.path.join(out, 'report.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    # sheet: target / draft / fit for each side
    rows = []
    for val in (-1.0, 1.0):
        T = load_rgb(os.path.join(out, f'target_{val:+.0f}.png'), (H, W))
        rows.append(np.concatenate([T, results[('draft', val)], results[('fit', val)]], 1))
    sheet = np.concatenate(rows, 0)
    sheet = cv2.resize(sheet, (sheet.shape[1] // 2, sheet.shape[0] // 2), interpolation=cv2.INTER_AREA)
    Image.fromarray((np.clip(sheet, 0, 1) * 255).astype(np.uint8)).save(os.path.join(out, 'sheet.png'))
    print(json.dumps({k: report[k] for k in ('error', '-1.0', '1.0')}, indent=1))


if __name__ == '__main__':
    main(*sys.argv[1:])
