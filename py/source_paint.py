"""
Visible pixels come from the original picture.

see-through does not cut the picture into layers, it draws each layer again - mostly faithfully, sometimes not
(an ear drawn as a grey blob where the picture has a clear pink ear). So before rigging, every layer's pixels that
are visible in the front pose (the top-most opaque layer there, in the artisan stacking order) take the picture's
colour. Pixels hidden under other layers keep see-through's drawing: they only show when things move.
Thin edges (where layers meet) are left alone, so a small misalignment cannot double a line.

  paint_from_source(rig, picture_png)          picture framed like the PSD (see-through pads it to a square)
"""
import numpy as np
from PIL import Image
from scipy import ndimage as ndi


def picture_on_canvas(path, size, like=None):
    """The picture placed the way see-through placed it on its square canvas (padded, scaled).
    like: another picture's path - this one is first resized to its size (an AI redraw of that picture)."""
    H, W = size
    im = Image.open(path).convert('RGB')
    if like is not None:
        im = im.resize(Image.open(like).size, Image.LANCZOS)
    w, h = im.size
    s = W / max(w, h)
    nw, nh = round(w * s), round(h * s)
    canvas = Image.new('RGB', (W, H), (255, 255, 255))
    canvas.paste(im.resize((nw, nh), Image.LANCZOS), ((W - nw) // 2, (H - nh) // 2))
    return np.asarray(canvas).astype(np.float32) / 255.0


def paint_from_source(rig, picture, order_rank=None, edge=2, max_diff=None, keep=None, skip=()):
    """keep: pixels never to repaint (where a layer was left out: the picture still shows that layer there).
    skip: parts never repainted (taken from another picture's split, already in that picture's colours)."""
    H, W = rig.size
    src = picture_on_canvas(picture, (H, W))
    parts = list(rig.parts)
    if order_rank is not None:
        parts.sort(key=order_rank)                     # bottom -> top
    owner = np.full((H, W), -1, np.int32)
    for i, p in enumerate(parts):
        owner[p.rgba[..., 3] > 0.9] = i
    changed = {}
    for i, p in enumerate(parts):
        m = owner == i
        if m.sum() < 20 or p.name in skip:
            continue
        m = ndi.binary_erosion(m, iterations=edge)       # keep away from where layers meet
        if keep is not None:
            m &= ~ndi.binary_dilation(keep, iterations=2)
        if max_diff is not None:                          # optional: skip big colour jumps
            m &= np.abs(p.rgba[..., :3] - src).max(-1) < max_diff
        if not m.any():
            continue
        w = ndi.gaussian_filter(m.astype(np.float32), 1.0) * m
        p.rgba = p.rgba.copy()
        p.rgba[..., :3] = p.rgba[..., :3] * (1 - w[..., None]) + src * w[..., None]
        changed[p.name] = int(m.sum())
    return changed


def shade_hidden(rig, picture, order_rank=None, name='back hair', leaders=('front hair', 'back hair'),
                 dark=0.25, feather=8.0):
    """The back hair behind the face never shows in the front pose, and see-through fills it with a flat grey-brown;
    a head turn uncovers it beside the cheek. The artisan paints the inside of the hair in the hair's own shadow
    tone: hidden pixels take the darker quarter of the hair colours the picture shows (median), keeping
    see-through's light and dark (strand texture) as a gentle factor; blended in over `feather` px from where the
    layer shows."""
    H, W = rig.size
    by = [p for p in rig.parts if p.name == name]
    if not by:
        return 0
    src = picture_on_canvas(picture, (H, W))
    parts = list(rig.parts)
    if order_rank is not None:
        parts.sort(key=order_rank)
    owner = np.full((H, W), -1, np.int32)
    for i, p in enumerate(parts):
        owner[p.rgba[..., 3] > 0.9] = i
    hair_px = np.zeros((H, W), bool)
    for i, p in enumerate(parts):
        if p.name in leaders:
            hair_px |= owner == i
    hair_px = ndi.binary_erosion(hair_px, iterations=2)
    if hair_px.sum() < 200:
        return 0
    lum = lambda c: c @ np.array([0.299, 0.587, 0.114], np.float32)
    cols = src[hair_px]
    lv = lum(cols)
    lo, hi = np.quantile(lv, [0.05, dark])
    shadow = np.median(cols[(lv >= lo) & (lv <= hi)], 0)
    done = 0
    for p in by:
        i = parts.index(p)
        a = p.rgba[..., 3]
        shown = owner == i
        hidden = (a > 0.02) & ~shown
        if hidden.sum() < 50:
            continue
        w = np.clip(ndi.distance_transform_edt(~shown) / feather, 0, 1) * hidden
        own = lum(p.rgba[..., :3])
        ratio = np.clip(own / max(1e-3, float(np.median(own[hidden]))), 0.85, 1.15)
        new = np.clip(shadow[None, None, :] * ratio[..., None], 0, 1)
        p.rgba = p.rgba.copy()
        p.rgba[..., :3] = p.rgba[..., :3] * (1 - w[..., None]) + new * w[..., None]
        done += int(hidden.sum())
    return done


def clear_fringe(rig, picture, names=('front hair', 'back hair'), solid=0.95):
    """see-through paints soft wide strokes where the picture has only thin flyaway hairs on the background; they
    show as a grey haze around the hair. Where the picture shows the outer background (near-white, connected to
    the picture's border), the hair's see-through edge (alpha < `solid`) goes; solid hair is never touched."""
    H, W = rig.size
    src = picture_on_canvas(picture, (H, W))
    white = (src.min(-1) > 0.93) & ((src.max(-1) - src.min(-1)) < 0.06)
    lab, n = ndi.label(white)
    border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    bg = np.isin(lab, list(border))
    bg = ndi.binary_erosion(bg, iterations=1)
    cleared = 0
    for p in rig.parts:
        if p.name not in names:
            continue
        a = p.rgba[..., 3]
        m = bg & (a < solid)
        if m.any():
            p.rgba = p.rgba.copy()
            p.rgba[..., 3] = np.where(m, 0.0, a)
            cleared += int((a[m] > 0.02).sum())
    return cleared


def uncover(rig, picture, behind='neck', front=('topwear', 'neckwear'), margin=0.04):
    """A part drawn behind another (the neck behind the clothes) must still show where the picture shows it: the
    split often gives the front part a filled-in piece over it (a shirt's back collar across the neck), which then
    covers the neck with a line the picture does not have. Where the two overlap, each pixel goes to the part whose
    own colour the picture matches; the front part is cut there (feathered a little)."""
    by = {p.name: p for p in rig.parts}
    b = by.get(behind)
    if b is None:
        return 0
    src = picture_on_canvas(picture, rig.size)
    cut_total = 0
    for name in front:
        f = by.get(name)
        if f is None:
            continue
        over = (b.rgba[..., 3] > 0.5) & (f.rgba[..., 3] > 0.3)
        if over.sum() < 20:
            continue
        d_b = np.linalg.norm(src - b.rgba[..., :3], axis=-1)
        d_f = np.linalg.norm(src - f.rgba[..., :3], axis=-1)
        cut = over & (d_b + margin < d_f)
        cut = ndi.binary_opening(cut, iterations=1)
        cut = ndi.binary_closing(cut, iterations=2) & over
        if cut.sum() < 20:
            continue
        soft = np.clip(ndi.gaussian_filter(cut.astype(np.float32), 1.0) * 1.5, 0, 1)
        f.rgba = f.rgba.copy()
        f.rgba[..., 3] *= 1 - soft
        cut_total += int(cut.sum())
    return cut_total
