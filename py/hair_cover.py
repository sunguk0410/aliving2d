"""
The hair over the ears.

The ear is a part of its own on the side of the head, under the hair, and turns with the head. In the picture it
often peeks out between the locks; see-through still draws the hair solid there, as hair without the ear it could
not see. The model needs exactly that hair, but see-through's guess looks foreign next to the picture's hair. So
the hair there comes from the same picture drawn by AI with the hair falling over the ears (a drawn state, like
the open mouth): where the picture shows the ear through the hair and the drawing shows hair, the hair layer takes
the drawing's pixels. Where the drawing still shows an ear (the AI left it), see-through's hair stays.

That drawing is only needed when the ear peeks out between the locks. An ear the picture shows in the open (the
hair beside it, a few thin strands across) keeps the picture's own hair, and an ear the picture already hides needs
nothing: `ear_peek` measures, per ear, how much of it the picture shows where see-through drew hair over it.

  ear_peek(head_psd, picture) -> [per ear]; needs_cover(peeks) -> bool (PEEK)
  cover_ears(rig, picture, covered, covers) -> pixels the repaint from the picture must leave alone (or None)
"""
import os
import sys

import numpy as np
from scipy import ndimage as ndi

sys.path.insert(0, os.path.dirname(__file__))
from source_paint import picture_on_canvas  # noqa: E402

# an ear peeks out between the locks when this much of it is hair in the split but ear in the picture
# (measured: open ears 0.02-0.03, ears already under the hair 0.01-0.02, an ear between two locks 0.2)
PEEK = 0.08
HAIR_OVER_EARS = ('front hair',)


def ear_peek(head_psd, picture, grid=60):
    """Per ear (largest first), the share of it the picture shows where see-through drew the hair over it."""
    from rig import load_psd
    rig = load_psd(head_psd, grid=grid)
    ears = [p for p in rig.parts if p.name == 'ears']
    hair = [p for p in rig.parts if p.name in HAIR_OVER_EARS]
    if not ears or not hair:
        return []
    ea = np.max([p.rgba[..., 3] for p in ears], 0)
    ha = np.max([p.rgba[..., 3] for p in hair], 0)
    src = picture_on_canvas(picture, rig.size)
    mean = lambda ps: sum(p.rgba[..., :3] * p.rgba[..., 3:] for p in ps) / np.maximum(1e-3, sum(p.rgba[..., 3:] for p in ps))
    ear_like = np.linalg.norm(src - mean(ears), axis=-1) < np.linalg.norm(src - mean(hair), axis=-1)
    lab, n = ndi.label(ea > 0.5)
    sizes = ndi.sum(np.ones_like(ea), lab, range(1, n + 1))
    out = []
    for i in np.argsort(-sizes)[:2]:
        if sizes[i] < 200:
            continue
        e = lab == i + 1
        out.append(round(float((e & (ha > 0.3) & ear_like).sum() / e.sum()), 3))
    return out


def needs_cover(peeks):
    return any(p >= PEEK for p in peeks)


def align_covered(picture, covered, out=None):
    """The AI drawing lined up on the picture (translation; it may shift the picture a few px), saved over itself
    or to `out` at the picture's size - so a split of it lines up with the split of the picture."""
    from PIL import Image
    from mouth_rig import align
    src = np.asarray(Image.open(picture).convert('RGB')).astype(np.float32) / 255.0
    drw = np.asarray(Image.open(covered).convert('RGB').resize(src.shape[1::-1], Image.LANCZOS)).astype(np.float32) / 255.0
    drw, warp = align(src, drw, np.ones(src.shape[:2], bool))
    Image.fromarray((np.clip(drw, 0, 1) * 255).astype(np.uint8)).save(out or covered)
    return [round(float(warp[0, 2]), 2), round(float(warp[1, 2]), 2)]


def hair_from_split(rig, covered_psd, covered_png, covers, grid=60):
    """Two pictures (Live2D: the hair drawn whole over the ear): the hair parts come from the split of the drawing
    with the ears covered, coloured from that drawing; everything else (the ears too) from the picture's own split.
    Returns the names taken (the repaint from the picture must leave them alone), or () if there is nothing."""
    from rig import load_psd
    from source_paint import paint_from_source
    from artisan import order_rank
    if not covered_psd or not os.path.exists(covered_psd) or not covered_png or not os.path.exists(covered_png):
        return ()
    other = load_psd(covered_psd, grid=grid)
    if tuple(other.size) != tuple(rig.size):
        return ()
    paint_from_source(other, covered_png, order_rank)
    theirs = {p.name: p for p in other.parts if p.name in covers}
    taken = []
    for i, p in enumerate(rig.parts):
        if p.name in theirs:
            rig.parts[i] = theirs.pop(p.name)
            taken.append(p.name)
    return tuple(taken)


def cover_ears(rig, picture, covered, covers, reach=3, ring=(4, 40), pad=4):
    """See-through's hair made solid where the picture shows the ear through it (never a second ear painted on the
    hair); with the covered drawing, the hair there from the drawing."""
    hair = [p for p in rig.parts if p.name in covers]
    ears = [p for p in rig.parts if p.name in ('ears', 'earwear')]
    if not hair or not ears:
        return None
    ha = np.max([p.rgba[..., 3] for p in hair], 0)
    ea = np.max([p.rgba[..., 3] for p in ears], 0)
    under = (ea > 0.05) & (ha > 0.3)
    if under.sum() < 20 or picture is None:
        return under if under.any() else None
    H, W = rig.size
    src = picture_on_canvas(picture, (H, W))
    # the colours the two layers are drawn in, per pixel (see-through draws both whole)
    ear_rgb = sum(p.rgba[..., :3] * p.rgba[..., 3:] for p in ears) / np.maximum(1e-3, sum(p.rgba[..., 3:] for p in ears))
    hair_rgb = sum(p.rgba[..., :3] * p.rgba[..., 3:] for p in hair) / np.maximum(1e-3, sum(p.rgba[..., 3:] for p in hair))
    ear_like = lambda c: np.linalg.norm(c - ear_rgb, axis=-1) < np.linalg.norm(c - hair_rgb, axis=-1)
    region = ndi.binary_dilation(under, iterations=reach) & (ha > 0.3)
    shows_ear = region & ear_like(src)                  # where the picture shows the ear through the hair
    # the hair covers the ear there: solid, or the ear part shows through it as a ghost
    solid = np.clip(ndi.gaussian_filter(shows_ear.astype(np.float32), 1.5) * 1.5, 0, 1)
    for p in hair:
        a = p.rgba[..., 3]
        if (a[shows_ear] > 0.3).any():
            p.rgba = p.rgba.copy()
            p.rgba[..., 3] = np.where(a > 0.3, np.maximum(a, solid), a)
    if covered is None or not os.path.exists(covered):
        return shows_ear
    from mouth_rig import align
    drawn = picture_on_canvas(covered, (H, W), like=picture)
    # line the drawing up on the hair around the ears (the AI may shift the picture a little)
    near = ndi.binary_dilation(under, iterations=ring[1]) & ~ndi.binary_dilation(under, iterations=ring[0]) & (ha > 0.5)
    if near.sum() > 500:
        drawn, _ = align(src, drawn, near)
    # the AI left the ear there (the drawing hardly differs from the picture's ear): see-through's hair stays
    changed = np.linalg.norm(drawn - src, axis=-1) > 0.08
    if changed[shows_ear].mean() < 0.6:
        return shows_ear
    # the whole hair over the ear from the drawing (picking pixels one by one would leave the ear's outline, which
    # is dark like hair), blended into the picture's hair over a few px around it
    inner = ndi.binary_dilation(shows_ear, iterations=pad)
    outer = ndi.binary_dilation(shows_ear, iterations=3 * pad) & (ha > 0.3)
    w = np.maximum(np.clip(ndi.gaussian_filter(inner.astype(np.float32), pad) * 1.2, 0, 1), inner)
    for p in hair:
        m = outer & (p.rgba[..., 3] > 0.3)
        if m.any():
            p.rgba = p.rgba.copy()
            mix = src * (1 - w[..., None]) + drawn * w[..., None]
            p.rgba[..., :3] = np.where(m[..., None], mix, p.rgba[..., :3])
    return outer
