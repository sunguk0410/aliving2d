"""
Eye parts, Live2D style, from see-through eye layers (irides / eyewhite / eyelash) at face-crop resolution.

Per eye:
  iris        the iris as a whole ellipse: the hidden part under the lids is filled (it shows when the eye looks
              up / down), highlights and the pupil taken out and painted over
  pupil       the dark centre blob (pupil size parameter)
  highlight   the main bright spot(s) (moves less than the iris, may shimmer)
  highlight2  small side reflections
  lash_upper / lash_lower / lash_crease   the eyelash layer split by where it sits around the eye opening

Visible pixels always come from the source layers: putting the parts back together gives the source eye again
(checked by `recompose_error`). Only pixels that were hidden are made up.

  python py/eye_parts.py <see-through psd> <out dir>
"""
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image
from psd_tools import PSDImage
from scipy import ndimage as ndi


# ---------------------------------------------------------------- helpers

def layer_rgba(psd, name):
    for l in psd.descendants():
        if l.name == name:
            im = Image.new('RGBA', (psd.width, psd.height))
            im.alpha_composite(l.topil().convert('RGBA'), (l.left, l.top))
            return np.asarray(im).astype(np.float32) / 255.0
    return None


def components(alpha, thr=0.5, min_px=200):
    lab, k = ndi.label(alpha > thr)
    out = []
    for i, sl in enumerate(ndi.find_objects(lab)):
        m = lab == i + 1
        if m.sum() >= min_px:
            out.append(m)
    return out


def luma(rgb):
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def disk(r):
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return (x * x + y * y) <= r * r


def bbox(m, pad=0):
    ys, xs = np.nonzero(m)
    return max(0, ys.min() - pad), max(0, xs.min() - pad), ys.max() + 1 + pad, xs.max() + 1 + pad


def inpaint_rgb(rgb, hole, radius=4):
    """Fill `hole` from its surroundings (OpenCV Telea). rgb float 0..1."""
    u8 = (np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8)
    out = cv2.inpaint(u8, hole.astype(np.uint8) * 255, radius, cv2.INPAINT_TELEA)
    return out.astype(np.float32) / 255.0


# ---------------------------------------------------------------- iris

def fit_iris_ellipse(iris_m, white_m):
    """Axis-aligned ellipse of the whole iris. The true iris outline is where the iris edge lies inside the eye
    white (not on the lid line); those points fix the centre x and the width, and the height follows the usual
    anime iris (a bit taller than wide), centred on the visible part's middle unless the edge points say otherwise."""
    edge = iris_m & ~ndi.binary_erosion(iris_m, iterations=1)
    inner = edge & ndi.binary_erosion(white_m, iterations=3)       # iris edge not on the lid line
    ys, xs = np.nonzero(iris_m)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    cx, a = (x0 + x1) / 2, (x1 - x0) / 2
    py, px = np.nonzero(inner)
    b = a * 1.15
    cy = (y0 + y1) / 2
    if len(px) >= 8:
        # side points: (x-cx)^2/a^2 + (y-cy)^2/b^2 = 1, fit cy and b by least squares over a small grid
        best = None
        for bb in np.linspace(a * 0.95, a * 1.45, 21):
            for cc in np.linspace(y0 - a * 0.4, y1 + a * 0.4, 41):
                r = ((px - cx) / a) ** 2 + ((py - cc) / bb) ** 2 - 1
                e = float(np.mean(r * r))
                # the ellipse must contain the visible iris
                if ((((xs - cx) / (a + 1)) ** 2 + ((ys - cc) / (bb + 1)) ** 2) > 1.0).mean() > 0.01:
                    continue
                if best is None or e < best[0]:
                    best = (e, cc, bb)
        if best is not None:
            _, cy, b = best
    return cx, cy, a, b, int(inner.sum())


def ellipse_mask(shape, cx, cy, a, b):
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
    return ((xx - cx) / a) ** 2 + ((yy - cy) / b) ** 2 <= 1.0


def split_iris(rgba, white_m):
    rgb, al = rgba[..., :3], rgba[..., 3]
    vis = al > 0.5
    L = luma(rgb)
    sat = rgb.max(-1) - rgb.min(-1)
    Lv = L[vis]

    # highlights: bright and pale; keep a soft one-pixel rim
    hi_core = vis & (L > max(0.80, np.percentile(Lv, 99.0) - 0.02)) & (sat < 0.25)
    hi = ndi.binary_dilation(hi_core, iterations=1) & vis
    comps = components(hi.astype(np.float32), min_px=3)
    comps.sort(key=lambda m: -m.sum())
    main_hi = np.zeros_like(hi)
    side_hi = np.zeros_like(hi)
    if comps:
        big = comps[0].sum()
        for m in comps:
            (main_hi if m.sum() >= 0.35 * big else side_hi)[...] |= m

    # paint the highlights out of the iris
    hole = ndi.binary_dilation(hi, iterations=1) & vis
    base = inpaint_rgb(rgb, hole, 3)

    # pupil: a dark blob much smaller than the iris: grey closing with a disk erases it, the difference finds it
    ys, xs = np.nonzero(vis)
    iw = xs.max() - xs.min()
    r = max(3, int(iw * 0.16))
    Lb = luma(base)
    fill = np.where(vis, Lb, ndi.grey_dilation(np.where(vis, Lb, 0), size=(5, 5)))
    closed = ndi.grey_closing(fill, footprint=disk(r))
    dark = vis & ((closed - Lb) > 0.06) & ndi.binary_erosion(vis, iterations=max(2, r // 3)) & ~hole
    pupil = np.zeros_like(vis)
    pcs = components(dark.astype(np.float32), min_px=max(6, int(iw * iw * 0.004)))
    if pcs:
        cxv = xs.mean()
        pcs.sort(key=lambda m: abs(np.nonzero(m)[1].mean() - cxv) - m.sum() * 0.05)
        pupil = ndi.binary_closing(pcs[0], iterations=2) & vis
    soft = np.clip(ndi.gaussian_filter(pupil.astype(np.float32), 1.0) * 1.6, 0, 1) * (al > 0)
    base2 = inpaint_rgb(base, ndi.binary_dilation(pupil, iterations=2) & vis, 5)

    return dict(hi_main=main_hi, hi_side=side_hi, pupil=pupil, pupil_soft=soft, pupil_rgb=base, base=base2, vis=vis, L=L)


def complete_iris(base, vis, ell, lid_edge, base_alpha):
    """Fill the hidden part of the iris ellipse.

    `lid_edge` = visible iris pixels along the lid lines that the lashes cover anyway: they carry the drawn lid
    shadow, which must not be carried into the hidden part (it would show as a dark line when the eye looks
    up/down), so they are repainted too. Every other visible pixel stays as drawn.
    Hidden colours come from the nearest reliable interior pixel, then smoothed so they read as paint."""
    keep = vis & ~lid_edge & (base_alpha > 0.95)
    src = ndi.binary_erosion(keep, iterations=2)
    if src.sum() < 20:
        src = keep
    out = base.copy()
    hole = ell & ~keep
    if not hole.any():
        return out
    _, (iy, ix) = ndi.distance_transform_edt(~src, return_indices=True)
    out[hole] = base[iy[hole], ix[hole]]
    sm = np.stack([ndi.gaussian_filter(out[..., c], 3.0) for c in range(3)], -1)
    d = ndi.distance_transform_edt(~keep)
    t = np.clip(d / 4.0, 0, 1)[..., None]                       # 0 at the kept edge -> 1 four px in
    out = np.where(hole[..., None], out * (1 - t) + sm * t, out)
    return out


# ---------------------------------------------------------------- lashes

def split_lashes(lash_rgba, white_m):
    """Upper lash / lower lash / crease, by position around the eye opening (the eye white)."""
    al = lash_rgba[..., 3]
    m = al > 0.08
    ys, xs = np.nonzero(white_m)
    wx0, wx1 = xs.min(), xs.max()
    top = np.full(white_m.shape[1], -1.0)
    bot = np.full(white_m.shape[1], -1.0)
    for x in range(wx0, wx1 + 1):
        c = np.nonzero(white_m[:, x])[0]
        if len(c):
            top[x], bot[x] = c.min(), c.max()
    # extend the lid lines past the corners with the end values
    cols = np.arange(white_m.shape[1])
    ok = top >= 0
    top_f = np.interp(cols, cols[ok], top[ok])
    bot_f = np.interp(cols, cols[ok], bot[ok])
    mid = (top_f + bot_f) / 2
    H, W = m.shape
    yy, xx = np.mgrid[0:H, 0:W]
    below = m & (yy > mid[None, :])
    above = m & ~below

    # upper lash band: in each column the lowest run of lash pixels above the midline (1 px gaps bridged) -
    # that is the lash line sitting on the eye. Crease lines are runs further up, separated by a gap.
    low_run = np.zeros_like(m)
    run_top = np.full(W, -1)
    thick = []
    for x in range(W):
        c = above[:, x]
        if not c.any():
            continue
        y = int(np.nonzero(c)[0].max())
        k, gap = y, 0
        while k >= 0:
            if c[k]:
                low_run[k, x] = True
                gap = 0
            else:
                gap += 1
                if gap > 1:
                    break
            k -= 1
        run_top[x] = k + gap + 1
        thick.append(y - run_top[x] + 1)
    t_med = float(np.median(thick)) if thick else 4.0
    # lash tips that stick up out of the band belong to it: grow the band through `above`, but only up to
    # 2.5 band thicknesses over the band's top in that column
    reach = np.where(run_top >= 0, run_top - 1.3 * t_med, H)
    allowed = above & (yy >= reach[None, :])
    band = ndi.binary_propagation(low_run, mask=allowed)
    crease = above & ~band
    lab, k = ndi.label(crease)
    for i in range(1, k + 1):                                   # specks are band bits
        ci = lab == i
        if ci.sum() < max(12, t_med * 4):
            band |= ci
            crease &= ~ci

    # lower lash: the thin line along the lower lid. Toward the outer corner the thick wing of the upper lash
    # also reaches below the midline: per column, the lowest run below the midline counts as lower lash only
    # while it stays thin; the change-over is ramped over a few columns (weights sum to 1, no hard cut).
    runs = np.zeros(W)
    for x in range(W):
        c = np.nonzero(below[:, x])[0]
        runs[x] = len(c)
    tl = float(np.median(runs[runs > 0])) if (runs > 0).any() else 2.0
    thin = (runs > 0) & (runs <= max(3.0, tl * 1.8))
    thin_s = ndi.uniform_filter1d(thin.astype(np.float32), 7)
    w_lower = np.clip((thin_s - 0.3) / 0.5, 0, 1)[None, :].astype(np.float32)
    lower_w = below * w_lower
    upper_w = band + below * (1 - w_lower)
    return np.clip(upper_w, 0, 1).astype(np.float32), lower_w, crease.astype(np.float32)


# ---------------------------------------------------------------- per eye

def layer_from(mask_alpha, rgb):
    a = np.clip(mask_alpha, 0, 1)
    return np.concatenate([rgb, a[..., None]], -1)


def eye_parts(iris_rgba, white_rgba, lash_rgba, iris_m, white_m):
    sl = bbox(white_m | iris_m, pad=int(max(8, (bbox(white_m)[3] - bbox(white_m)[1]) * 0.35)))
    y0, x0, y1, x1 = sl
    crop = lambda a: a[y0:y1, x0:x1]
    I, Wm, Im = crop(iris_rgba) * crop(iris_m)[..., None], crop(white_m), crop(iris_m)
    s = split_iris(I, Wm)
    cx, cy, a, b, n_edge = fit_iris_ellipse(Im, Wm)
    ell = ellipse_mask(Im.shape, cx, cy, a + 0.5, b + 0.5) | s['vis']
    lash = crop(lash_rgba)
    vis = s['vis']
    on_lid = vis & ~ndi.binary_erosion(Wm, iterations=2)          # iris pixels at the eye-white edge (lid line)
    lid_edge = ndi.binary_dilation(on_lid, iterations=3) & vis & (lash[..., 3] > 0.6)
    iris_rgb = complete_iris(s['base'], vis, ell, lid_edge, I[..., 3])
    al = I[..., 3]
    iris_a = ell.astype(np.float32)   # the eyeball is opaque; the eye white clips it
    hi_main = layer_from(np.where(s['hi_main'], al, 0), I[..., :3])
    hi_side = layer_from(np.where(s['hi_side'], al, 0), I[..., :3])
    pupil = layer_from(s['pupil_soft'] * al, s['pupil_rgb'])
    lu, ll, lc = split_lashes(lash, Wm)
    la = lash[..., 3]
    parts = {
        'iris': layer_from(iris_a, iris_rgb),
        'pupil': pupil,
        'highlight': hi_main,
        'highlight2': hi_side,
        'lash_upper': layer_from(lu * la, lash[..., :3]),
        'lash_lower': layer_from(ll * la, lash[..., :3]),
        'lash_crease': layer_from(lc * la, lash[..., :3]),
        'white': crop(white_rgba) * Wm[..., None],
    }
    info = dict(box=[int(x0), int(y0), int(x1), int(y1)], iris_ellipse=[float(cx), float(cy), float(a), float(b)],
                iris_edge_px=n_edge)
    src = over(over(parts['white'].copy(), I), lash)
    return parts, info, src


def over(dst, src):
    a = src[..., 3:4]
    out_a = a + dst[..., 3:4] * (1 - a)
    rgb = (src[..., :3] * a + dst[..., :3] * dst[..., 3:4] * (1 - a)) / np.maximum(out_a, 1e-6)
    return np.concatenate([rgb, out_a], -1)


def recompose(parts, clip):
    """The eye at rest from its parts: white, then the eyeball (clipped to the eye white like the engine does),
    then the lashes. Lash weights are additive, so the two lash layers are summed before compositing."""
    ball = parts['iris'].copy()
    for k in ('pupil', 'highlight2', 'highlight'):
        ball = over(ball, parts[k])
    ball[..., 3] *= clip
    c = over(parts['white'].copy(), ball)
    lu, ll = parts['lash_upper'], parts['lash_lower']
    a = np.clip(lu[..., 3] + ll[..., 3], 0, 1)
    rgb = np.where((lu[..., 3] >= ll[..., 3])[..., None], lu[..., :3], ll[..., :3])
    c = over(c, parts['lash_crease'])
    return over(c, np.concatenate([rgb, a[..., None]], -1))


def recompose_error(parts, src):
    """Mean abs RGB difference (0..1) between the eye rebuilt from its parts and the source layers, where visible."""
    c = recompose(parts, parts['white'][..., 3])
    vis = src[..., 3] > 0.5
    return float(np.abs(c[..., :3] * c[..., 3:4] - src[..., :3] * src[..., 3:4])[vis].mean())


def run(psd_path, out_dir):
    psd = PSDImage.open(psd_path)
    iris, white, lash = (layer_rgba(psd, n) for n in ('irides', 'eyewhite', 'eyelash'))
    whites = components(white[..., 3], min_px=500)
    irises = components(iris[..., 3], min_px=200)
    os.makedirs(out_dir, exist_ok=True)
    report = {}
    for wm in whites:
        side = 'R' if np.nonzero(wm)[1].mean() < psd.width / 2 else 'L'    # character's right eye is on image left
        im = max(irises, key=lambda m: (m & ndi.binary_dilation(wm, iterations=4)).sum())
        parts, info, src = eye_parts(iris, white, lash, im, wm)
        info['recompose_error'] = recompose_error(parts, src)
        for k, v in parts.items():
            Image.fromarray((np.clip(v, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGBA').save(os.path.join(out_dir, f'eye{side}_{k}.png'))
        report['eye' + side] = info
    with open(os.path.join(out_dir, 'eyes.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=1)
    return report


if __name__ == '__main__':
    print(json.dumps(run(sys.argv[1], sys.argv[2]), indent=1))
