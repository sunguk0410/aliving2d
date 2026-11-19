"""
Blink and smiling eyes from parts (no closed-eye drawing):

  eyelid_s       skin lid: the eye opening filled with the face colour around the eye, clipped to the eye white.
                 eyeOpen 1: squeezed into the top lid line (hidden); 0: its lower edge on the closing line
  eyelid_low_s   lower skin lid for the smile: squeezed into the bottom line; eyeSmile 1: up to the smile line
  lash_upper_s   the lash band: goes down to the closing line, thinner as it goes (closed eye = a ∪ line)
  lash_lower_s   comes up a little when closing, up to the smile line when smiling (smile = ∩)
  lash_crease_s  the double-lid line: barely moves
  eyebrow_s      comes down a little with a closed eye

Closing line: 70 % of the way from the upper lid line to the lower one; smile line: 45 %, its ends lower (∩).
"""
import os
import sys

import numpy as np
from scipy import ndimage as ndi

sys.path.insert(0, os.path.dirname(__file__))
from eye_parts import split_lashes  # noqa: E402
from rig import Part  # noqa: E402


def follow_line(seg, pool, max_gap=3):
    """A line is one part: a line found where it stands free (`seg`) is followed along its own curve into the
    places where it touches or runs into other strokes (`pool`), so the whole line comes along.

    Centre line of the free piece -> quadratic fit -> step outward column by column, taking the pool pixels within
    the line's thickness of the curve, until the line has ended (max_gap columns with nothing near the curve)."""
    ys, xs = np.nonzero(seg)
    if len(np.unique(xs)) < 4:
        return seg
    cols = np.unique(xs)
    cy = np.array([ys[xs == x].mean() for x in cols])
    th = np.median([np.sum(xs == x) for x in cols])
    poly = np.polyfit(cols, cy, 2 if len(cols) >= 8 else 1)
    out = seg.copy()
    H, W = seg.shape
    for step, x_start in ((-1, cols.min() - 1), (1, cols.max() + 1)):
        x, gap = x_start, 0
        while 0 <= x < W and gap < max_gap:
            yc = np.polyval(poly, x)
            r = th * 0.7 + 1
            y0, y1 = int(max(0, np.floor(yc - r))), int(min(H, np.ceil(yc + r) + 1))
            hit = pool[y0:y1, x]
            if hit.any():
                # the stroke the curve is on in this column: running alongside another stroke it sits at that
                # stroke's edge; buried deep inside it, the line has ended (it went into the band)
                col = pool[:, x]
                yi = int(np.clip(round(yc), 0, H - 1))
                if col[yi]:
                    a = yi
                    while a > 0 and col[a - 1]:
                        a -= 1
                    b = yi
                    while b < H - 1 and col[b + 1]:
                        b += 1
                    if (b - a + 1) > 2.5 * th and (yc - th / 2 - a) > th and (b - (yc + th / 2)) > th:
                        break
                out[y0:y1, x] |= hit
                gap = 0
            else:
                gap += 1
            x += step
    return out


def split_lashes_corners(lash_a, white_m):
    """Upper lash band / lower lash / crease lines, by the eye's corners.

    The eye white's outline is cut at its inner and outer corners (its leftmost / rightmost points) into the upper
    and the lower lid line. Every lash pixel belongs to the lid line it is nearest to - so a lash line that turns
    down at the outer corner and runs into the lower lashes goes with the lower lashes where it runs along them.
    Past the corners (wing tips) it is upper. Crease lines: long thin strokes above the upper band, separated
    from it by a gap (at least a quarter of the eye wide; short ones are lash tips and stay with the band)."""
    H, W = white_m.shape
    m = lash_a > 0.08
    ys, xs = np.nonzero(white_m)
    i_l, i_r = np.argmin(xs), np.argmax(xs)
    cl, cr = np.array([xs[i_l], ys[i_l]], float), np.array([xs[i_r], ys[i_r]], float)
    edge = white_m & ~ndi.binary_erosion(white_m)
    ey, ex = np.nonzero(edge)
    # side of the corner-to-corner chord: above = upper lid line
    d = cr - cl
    above = (d[0] * (ey - cl[1]) - d[1] * (ex - cl[0])) < 0
    lab = np.zeros((H, W), np.int8)
    lab[ey, ex] = np.where(above, 1, 2)
    _, (iy, ix) = ndi.distance_transform_edt(lab == 0, return_indices=True)
    near = lab[iy, ix]
    yy, xx = np.mgrid[0:H, 0:W]
    # past the corners: upper (the wing), unless clearly below the chord line
    chord_y = cl[1] + (xx - cl[0]) * (d[1] / max(1.0, d[0]))
    beyond = (xx < cl[0] - 2) | (xx > cr[0] + 2)
    near = np.where(beyond, np.where(yy > chord_y + 0.15 * d[0] * 0.3, 2, 1), near)
    upper = m & (near == 1)
    lower = m & (near == 2)

    # crease: in each column, walk up from the lowest upper-lash pixel through the band; after a gap of 2+ px
    # the rest of the column is a candidate
    cand = np.zeros_like(m)
    for x in range(W):
        c = np.nonzero(upper[:, x])[0]
        if not len(c):
            continue
        k, gap = c.max(), 0
        while k >= 0:
            if upper[k, x]:
                if gap >= 2:
                    cand[:k + 1, x] = upper[:k + 1, x]
                    break
                gap = 0
            else:
                gap += 1
            k -= 1
    labc, n = ndi.label(cand, structure=np.ones((3, 3)))
    crease = np.zeros_like(m)
    eye_w = cr[0] - cl[0]
    for i, sl in enumerate(ndi.find_objects(labc)):
        if sl[1].stop - sl[1].start >= 0.25 * eye_w:
            crease |= follow_line(labc == i + 1, upper)
    band = upper & ~crease
    return band.astype(np.float32), lower.astype(np.float32), crease.astype(np.float32)


def lid_lines(white_m, lash_a):
    """Per column of the eye: top of the eye white, the visible upper lid (lowest upper-lash pixel), bottom."""
    ys, xs = np.nonzero(white_m)
    x0, x1 = xs.min(), xs.max()
    cols = np.arange(white_m.shape[1])
    top = np.full(len(cols), np.nan)
    bot = np.full(len(cols), np.nan)
    vis = np.full(len(cols), np.nan)
    for x in range(x0, x1 + 1):
        c = np.nonzero(white_m[:, x])[0]
        if not len(c):
            continue
        top[x], bot[x] = c.min(), c.max()
        mid = (c.min() + c.max()) / 2
        la = np.nonzero(lash_a[:int(mid), x] > 0.5)[0]
        vis[x] = la.max() + 1 if len(la) else c.min()
    ok = ~np.isnan(top)
    f = lambda a: np.interp(cols, cols[ok], a[ok])
    return f(top), f(vis), f(bot), x0, x1


def face_colour(face_rgba, white_m, lash_a):
    ring = ndi.binary_dilation(white_m, iterations=14) & ~ndi.binary_dilation(white_m, iterations=4)
    ring &= (face_rgba[..., 3] > 0.9) & (lash_a < 0.05)
    if ring.sum() < 20:
        ring = face_rgba[..., 3] > 0.9
    return np.median(face_rgba[..., :3][ring], axis=0)


def lid_part(name, white_m, colour, grid, shade_bottom=True, skin=None):
    """Skin lid over the eye opening (a little bigger, so it also covers the eye white's outline). `skin` = the
    face layer: see-through paints the skin under the eyes, so the lid uses exactly the face's own colours."""
    m = ndi.binary_dilation(white_m, iterations=3)
    rgba = np.zeros(white_m.shape + (4,), np.float32)
    rgba[..., :3] = colour
    if skin is not None:
        ok = skin[..., 3] > 0.95
        rgba[..., :3] = np.where(ok[..., None], skin[..., :3], colour)
    rgba[..., 3] = ndi.gaussian_filter(m.astype(np.float32), 0.7)
    # a slightly darker band at the moving edge reads as the lid's thickness
    ys, xs = np.nonzero(m)
    h = ys.max() - ys.min() + 1
    yy = np.arange(white_m.shape[0])[:, None]
    t = np.clip((yy - ys.min()) / h, 0, 1)
    k = 1 - 0.10 * np.clip((t - 0.75) / 0.25, 0, 1) if shade_bottom else 1 - 0.10 * np.clip((0.25 - t) / 0.25, 0, 1)
    rgba[..., :3] *= k[..., None]
    return Part(name, rgba, None, grid)


def clean_skin(face_rgba, white_m, size=15):
    """The face layer around one eye with thin strokes taken out: see-through sometimes paints strands of the
    bangs or their shadows into the face layer, and a lid made of those pixels would carry a stripe down over
    the eye. A median filter (wider than a strand) keeps the skin's soft shading and drops the strands."""
    ys, xs = np.nonzero(white_m)
    h = ys.max() - ys.min() + 1
    m = 2 * h + size
    y0, y1 = max(0, ys.min() - m), min(white_m.shape[0], ys.max() + m)
    x0, x1 = max(0, xs.min() - m), min(white_m.shape[1], xs.max() + m)
    out = face_rgba.copy()
    roi = face_rgba[y0:y1, x0:x1, :3]
    med = np.stack([ndi.median_filter(roi[..., c], size=size) for c in range(3)], -1)
    out[y0:y1, x0:x1, :3] = ndi.gaussian_filter(med, (1.5, 1.5, 0))
    return out


def smile_keys(lines, smile_y):
    """Put the eyeSmile keys of one eye's lids on the meeting line smile_y (one y per image column)."""
    for part in lines['upper']:
        part.keys['eyeSmile'][1.0] = column_disp(part, smile_y - lines['vis'])
    for part in lines['lower']:
        part.keys['eyeSmile'][1.0] = column_disp(part, smile_y - lines['bot'])


def column_disp(part, dy):
    P = part.warp.rest
    d = np.zeros_like(P)
    d[..., 1] = at(dy, P[..., 0])
    return d.astype(np.float32)


def at(arr, x):
    return arr[np.clip(np.round(x).astype(int), 0, len(arr) - 1)]


def crease_apart(up_w, cr_w, lash_a, touch=2):
    """The crease is a line of its own with skin between it and the lashes. A 'crease' piece that touches the
    upper lash is a piece of the lash (a thick lash, a strand drawn into it) and closes with it; left on the
    crease it would stay up and leave a hole in the closing lash."""
    cm = (cr_w * lash_a) > 0.3
    um = ndi.binary_dilation((up_w * lash_a) > 0.3, iterations=touch)
    lab, n = ndi.label(cm)
    up_w, cr_w = up_w.copy(), cr_w.copy()
    for i in range(1, n + 1):
        comp = lab == i
        if (comp & um).any():
            region = ndi.binary_dilation(comp, iterations=1)
            up_w[region] = np.maximum(up_w[region], cr_w[region])
            cr_w[region] = 0
    return up_w, cr_w


def fill_lash_under_hair(lash, hair_a, max_gap):
    """see-through leaves the lash out where a strand of the bangs crosses it; the strand hides the hole at rest,
    but a closing lid pulls the lash out from under it. Draw the lash in (the artisan's 描き足し): in each row,
    hair-covered pixels between two lash pixels at most `max_gap` apart take the colour between them."""
    a = lash.rgba[..., 3]
    ys, xs = np.nonzero(a > 0.5)
    if len(xs) < 20:
        return 0
    hair = ndi.binary_dilation(hair_a > 0.5, iterations=2)
    out = lash.rgba.copy()
    n = 0
    for y in range(ys.min(), ys.max() + 1):
        have = np.nonzero(a[y] > 0.5)[0]
        if len(have) < 2:
            continue
        cand = np.nonzero((a[y] < 0.5) & hair[y])[0]
        cand = cand[(cand > have[0]) & (cand < have[-1])]
        if not len(cand):
            continue
        r = have[np.searchsorted(have, cand)]
        l = have[np.searchsorted(have, cand) - 1]
        ok = (r - l) <= max_gap
        cand, l, r = cand[ok], l[ok], r[ok]
        t = ((cand - l) / np.maximum(1, r - l))[:, None]
        out[y, cand] = out[y, l] * (1 - t) + out[y, r] * t
        n += len(cand)
    lash.rgba = out
    return n


def add_blink(rig, grid=24):
    byname = {p.name: p for p in rig.parts}
    hairs = [p.rgba[..., 3] for p in rig.parts if p.name == 'front hair']
    if hairs:
        hair_a = np.max(hairs, 0)
        for s in ('r', 'l'):
            lash, white = byname.get(f'eyelash_{s}'), byname.get(f'eyewhite_{s}')
            if lash is not None and white is not None:
                xs = np.nonzero((white.rgba[..., 3] > 0.5).any(0))[0]
                if len(xs):
                    fill_lash_under_hair(lash, hair_a, max(6, int(0.18 * (xs.max() - xs.min()))))
    face = byname.get('face')
    for s, param in (('r', 'eyeOpenR'), ('l', 'eyeOpenL')):
        white, lash = byname.get(f'eyewhite_{s}'), byname.get(f'eyelash_{s}')
        if not (white and lash and face):
            continue
        wm = white.rgba[..., 3] > 0.5
        la = lash.rgba[..., 3]
        if wm.sum() < 50:
            continue
        top, vis, bot, x0, x1 = lid_lines(wm, la)
        close = vis + (bot - vis) * 0.70
        span = max(1, x1 - x0)
        u = np.clip((np.arange(len(top)) - x0) / span, 0, 1)
        smile = vis + (bot - vis) * (0.45 + 0.35 * (2 * u - 1) ** 2)      # ∩: ends lower than the middle
        col = face_colour(face.rgba, wm, la)

        def grid_disp(part, fn):
            P = part.warp.rest
            return fn(P[..., 0], P[..., 1]).astype(np.float32)

        # lashes: upper / lower / crease
        up_w, lo_w, cr_w = split_lashes_corners(la, wm)
        up_w, cr_w = crease_apart(up_w, cr_w, la)
        parts = {}
        for key, w in (('lash_crease', cr_w), ('lash_lower', lo_w), ('lash_upper', up_w)):
            rgba = lash.rgba.copy()
            rgba[..., 3] = rgba[..., 3] * w
            if (rgba[..., 3] > 0.3).sum() < 3:
                continue
            parts[key] = Part(f'{key}_{s}', rgba, None, grid)
        U, Lo, C = parts.get('lash_upper'), parts.get('lash_lower'), parts.get('lash_crease')
        if U is None:
            continue

        # where the lids meet: upper comes down 70 % of the opening, lower comes up 30 %;
        # smiling: they meet on a ∩ line (ends lower than the middle)
        gap = bot - vis
        down_close, up_close = gap * 0.70, -gap * 0.30
        # ^ ^: the lids meet on a high arch - near the top in the middle, down at the corners
        smile_y = vis + gap * (0.12 + 0.88 * np.abs(2 * u - 1) ** 1.6)
        down_smile, up_smile = smile_y - vis, smile_y - bot

        def column(part, dy):
            P = part.warp.rest
            d = np.zeros_like(P)
            d[..., 1] = at(dy, P[..., 0])
            return d.astype(np.float32)

        # skin lids glued to their lashes: the same warp grid and the same column displacements, so a lid edge
        # can never part from its lash. Each lid waits hidden behind its lash band (clipped to the eye white),
        # and its texture is the face skin of the place it will cover.
        H, W = wm.shape
        yy, xx = np.mgrid[0:H, 0:W]
        cols = (xx >= x0) & (xx <= x1)

        skin = clean_skin(face.rgba, wm)

        def skin_layer(y_from, y_to, shift):
            m = cols & (yy >= at(y_from, xx)) & (yy <= at(y_to, xx))
            sy = np.clip(np.round(yy + at(shift, xx)).astype(int), 0, H - 1)
            rgba = np.zeros((H, W, 4), np.float32)
            src = skin[sy, xx]
            rgba[..., :3] = np.where(src[..., 3:4] > 0.5, src[..., :3], col)
            rgba[..., 3] = m
            return rgba

        # the lids are clipped to a mask a little bigger than the eye white (never drawn itself), so they also
        # cover the eye white's soft outline stroke
        mrgba = np.zeros((H, W, 4), np.float32)
        mrgba[..., :3] = 1
        mrgba[..., 3] = ndi.binary_dilation(wm, iterations=3)
        mask = Part(f'eyemask_{s}', mrgba, None, grid)
        mask.mask_only = True
        lid = Part(f'eyelid_{s}', skin_layer(vis - gap - 6, vis - 3, down_close), None, grid)
        lid.warp = U.warp
        lid.clip = f'eyemask_{s}'
        low = Part(f'eyelid_low_{s}', skin_layer(bot + 1, bot + gap + 6, up_close), None, grid)
        low.clip = f'eyemask_{s}'
        z_u = np.zeros_like(U.warp.rest)
        for part in (U, lid):
            part.keys[param] = {0.0: column(part, down_close), 1.0: z_u}
            part.keys['eyeSmile'] = {0.0: z_u, 1.0: column(part, down_smile)}
        if Lo is not None:
            low.warp = Lo.warp
            z_l = np.zeros_like(Lo.warp.rest)
            for part in (Lo, low):
                part.keys[param] = {0.0: column(part, up_close), 1.0: z_l}
                part.keys['eyeSmile'] = {0.0: z_l, 1.0: column(part, up_smile)}
        else:
            z_l = np.zeros_like(low.warp.rest)
            low.keys[param] = {0.0: column(low, up_close), 1.0: z_l}
            low.keys['eyeSmile'] = {0.0: z_l, 1.0: column(low, up_smile)}
        # kept for drawn_eyes.fit_smile_line: the lids' smile keys can be moved onto a drawn ^ ^ arch
        lines = rig.__dict__.setdefault('smile_lines', {})
        lines[s] = dict(vis=vis, bot=bot, x0=x0, x1=x1,
                        upper=[U, lid], lower=[Lo, low] if Lo is not None else [low])
        if C is not None:
            z_c = np.zeros_like(C.warp.rest)
            C.keys[param] = {0.0: column(C, down_close * 0.12), 1.0: z_c}
        brow = byname.get(f'eyebrow_{s}')
        if brow is not None:
            drop = (np.nanmean(bot[x0:x1 + 1]) - np.nanmean(vis[x0:x1 + 1])) * 0.12
            z = np.zeros_like(brow.warp.rest)
            dz = z.copy()
            dz[..., 1] = drop
            brow.keys[param] = {0.0: dz, 1.0: z}
        # draw order: ... iris, pupil, highlights, lower lid, upper lid, lashes (crease, lower, upper)
        i = rig.parts.index(lash)
        rig.parts[i:i + 1] = [mask, low, lid] + [parts[k] for k in ('lash_crease', 'lash_lower', 'lash_upper') if k in parts]
    return rig
