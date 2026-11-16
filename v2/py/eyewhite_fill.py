"""
Eye whites the split did not give (the artisan draws the missing part in).

see-through sometimes leaves no 'eyewhite' layer: the white is painted into the face layer as skin, and gaze,
blink and the eye clips all need it. The opening of each eye is where the eye white has to be: between the upper
lash line and the lower lash line, column by column, plus the iris. The lines are found from the eyelash layer
(top run / bottom run of each column; columns without a lower line are interpolated between their neighbours);
the colour comes from the source picture where it is white there, and spreads from those pixels under the iris
(so a moving iris shows white, shaded like the visible white).
"""
import numpy as np
from scipy import ndimage as ndi

from rig import Part


def runs(col):
    """(start, end) of the True runs of a 1-D bool array."""
    d = np.diff(np.concatenate([[0], col.astype(np.int8), [0]]))
    return list(zip(np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]))


def opening(lash, iris):
    """Eye opening mask of one eye (bool), from its lash (bool) and iris (bool) masks."""
    H, W = lash.shape
    ys, xs = np.nonzero(lash | iris)
    if len(xs) < 50:
        return np.zeros_like(lash)
    x0, x1 = xs.min(), xs.max() + 1
    up = np.full(W, np.nan)
    lo = np.full(W, np.nan)
    # the eye's middle: the iris centre. Above it the lash line nearest the opening is the upper lash (a crease
    # or a lid line lies further up); below it the first line is the lower lash
    iy = np.nonzero(iris)[0]
    cy = iy.mean() if len(iy) else (ys.min() + ys.max()) / 2
    for x in range(x0, x1):
        r = runs(lash[:, x])
        above = [e for s_, e in r if s_ < cy]
        below = [s_ for s_, e in r if s_ >= cy]
        if above:
            up[x] = min(above[-1], cy)
        if below:
            lo[x] = below[0]
    ix = np.nonzero(iris.any(0))[0]
    # the lower line exists where it was drawn; between those columns it is interpolated, and outside them
    # the eye closes toward the corners (the upper line's ends)
    have = np.nonzero(~np.isnan(lo))[0]
    if len(have) < 3:
        return iris.copy()
    xs_all = np.arange(W)
    lo_i = np.interp(xs_all, have, lo[have])
    up_ok = np.nonzero(~np.isnan(up))[0]
    up_i = np.interp(xs_all, up_ok, up[up_ok])
    a, b = min(have.min(), ix.min() if len(ix) else W), max(have.max(), ix.max() if len(ix) else 0)
    m = np.zeros_like(lash)
    yy = np.arange(H)[:, None]
    span = (xs_all >= a) & (xs_all <= b)
    m |= (yy >= up_i[None, :]) & (yy <= lo_i[None, :]) & span[None, :]
    m |= iris
    m = ndi.binary_closing(m, np.ones((5, 5)), iterations=1)
    m = ndi.binary_opening(m, np.ones((5, 5))) | iris      # no one-column spikes
    return ndi.binary_fill_holes(m)


def white_colour(src, mask, iris, lash):
    """Source colour where it is white inside the opening, spread under the iris and lash from the nearest white."""
    lum = src @ np.array([0.299, 0.587, 0.114], np.float32)
    sat = src.max(-1) - src.min(-1)
    good = mask & ~iris & ~lash & (src.min(-1) > 0.8) & (sat < 0.14)
    if good.sum() < 20:
        rgb = np.zeros_like(src)
        rgb[:] = (0.97, 0.96, 0.97)
        return rgb
    # normalised blur: the visible white's shading, carried smoothly under the iris
    g = good.astype(np.float32)
    out = np.zeros_like(src)
    for sig in (6, 18, 60):
        w = ndi.gaussian_filter(g, sig)
        c = np.stack([ndi.gaussian_filter(src[..., i] * g, sig) for i in range(3)], -1)
        fill = (w > 1e-3) & (out.sum(-1) == 0)
        out[fill] = c[fill] / w[fill, None]
    out[good] = src[good]
    return out


def add_eyewhite(rig, src):
    """src: the source picture on the rig canvas (H, W, 3) float. Adds 'eyewhite' just below 'irides' when the
    split has none. Returns True if it added one."""
    names = [p.name for p in rig.parts]
    if 'eyewhite' in names or 'eyelash' not in names or 'irides' not in names:
        return False
    P = {p.name: p for p in rig.parts}
    lash_a, iris_a = P['eyelash'].rgba[..., 3], P['irides'].rgba[..., 3]
    lash, iris = lash_a > 0.3, iris_a > 0.5
    # one opening per eye: the eyes are the two largest lash + iris blobs
    lab, n = ndi.label(ndi.binary_dilation(lash | iris, np.ones((9, 9))))
    if n == 0:
        return False
    sizes = ndi.sum(np.ones_like(lab), lab, range(1, n + 1))
    eyes = [i + 1 for i in np.argsort(sizes)[::-1][:2]]
    mask = np.zeros_like(lash)
    for e in eyes:
        sel = lab == e
        o = opening(lash & sel, iris & sel)
        ia = (iris & sel).sum()
        # a sane opening is about the iris's size or a few times it; otherwise only the iris
        if ia and not (0.6 * ia <= o.sum() <= 4.0 * ia):
            o = iris & sel
        mask |= o
    if mask.sum() < 50:
        return False
    rgb = white_colour(src, mask, iris, lash)
    alpha = ndi.gaussian_filter(mask.astype(np.float32), 0.7)
    rgba = np.concatenate([rgb, alpha[..., None]], -1).astype(np.float32)
    q = Part('eyewhite', rgba, P['irides'].depth, 60)
    i = names.index('irides')
    rig.parts.insert(i, q)
    return True
