"""
Expressions, the artisan's way: a few expression parameters on the face, a few expression parts drawn in (the
marks anime faces use, Live2D 表情パーツ), and expressions as sets of parameter values (Live2D .exp3).

Parameters (keyforms on the existing parts)
  browLY / browRY          -1..1   brow down / up (0.09 head radii)
  browLAngle / browRAngle  -1..1   +1 angry (inner end down), -1 sad / worried (inner end up), +-16 deg
  eyeBall                  -1..1   -1 small irises (surprise, fear), +1 a little larger (moved, cute)
  mouthWide                -1..1   the mouth narrower (u, o, pursed) / wider (i, e), about its centre

Parts drawn here (opacity keyed to their parameter, 0 = gone)
  fx blush   cheek    pink cheeks with the short diagonal hatch lines
  fx tears   tear     a tear welling on the lower lid and running down from its outer half
  fx gloom   gloom    blue-purple vertical lines over the upper face and bangs, a cold tint on the skin
  fx sweat   sweat    a big sweat drop at the temple
  fx anger   anger    the red 'popping vein' mark at the upper side of the head

All drawn from the face's own landmarks (eyes, face outline), clipped to the face where they lie on skin, so they
fit any face; they turn with the head like the face (artisan.part_rule).
"""
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

from rig import Part

EXPR_PARAMS = [dict(id='browLY', min=-1, max=1, default=0), dict(id='browRY', min=-1, max=1, default=0),
               dict(id='browLAngle', min=-1, max=1, default=0), dict(id='browRAngle', min=-1, max=1, default=0),
               dict(id='eyeBall', min=-1, max=1, default=0),
               dict(id='cheek', min=0, max=1, default=0), dict(id='tear', min=0, max=1, default=0),
               dict(id='gloom', min=0, max=1, default=0), dict(id='sweat', min=0, max=1, default=0),
               dict(id='anger', min=0, max=1, default=0),
               dict(id='sparkle', min=0, max=1, default=0), dict(id='heartEyes', min=0, max=1, default=0),
               dict(id='blankEyes', min=0, max=1, default=0),
               dict(id='mouthWide', min=-1, max=1, default=0)]

# vowels for lip sync (Live2D artisans: mouth open + mouth form + width), applied over the expression
VOWELS = {'a': {'mouthOpen': 1.0, 'mouthWide': 0.0},
          'i': {'mouthOpen': 0.28, 'mouthWide': 0.75, 'mouthForm': 0.35},
          'u': {'mouthOpen': 0.25, 'mouthWide': -0.8},
          'e': {'mouthOpen': 0.5, 'mouthWide': 0.45},
          'o': {'mouthOpen': 0.7, 'mouthWide': -0.55}}

FX = {'fx blush': 'cheek', 'fx tears': 'tear', 'fx gloom': 'gloom', 'fx sweat': 'sweat', 'fx anger': 'anger'}

# Expressions (Live2D .exp3 = parameter values over the defaults). Names are what the CAPSULE reaction table uses.
EXPRESSIONS = {
    'neutral':    ('기본', {}),
    'smile':      ('미소', {'eyeSmile': 0.35, 'mouthForm': 0.7, 'browLY': 0.15, 'browRY': 0.15}),
    'joy':        ('기쁨', {'eyeSmile': 1.0, 'mouthForm': 1.0, 'mouthOpen': 0.45, 'browLY': 0.35, 'browRY': 0.35,
                           'cheek': 0.35}),
    'laugh':      ('웃음', {'eyeSmile': 1.0, 'mouthForm': 1.0, 'mouthOpen': 0.9, 'browLY': 0.5, 'browRY': 0.5,
                           'browLAngle': -0.3, 'browRAngle': -0.3, 'cheek': 0.5}),
    'shy':        ('부끄러움', {'cheek': 1.0, 'eyeOpenL': 0.8, 'eyeOpenR': 0.8, 'eyeX': 0.5, 'eyeY': -0.45,
                              'mouthForm': 0.25, 'browLAngle': -0.45, 'browRAngle': -0.45, 'browLY': 0.2,
                              'browRY': 0.2}),
    'love':       ('반함', {'eyeBall': 1.0, 'cheek': 0.8, 'eyeSmile': 0.25, 'mouthForm': 0.8, 'mouthOpen': 0.15,
                           'browLAngle': -0.3, 'browRAngle': -0.3, 'browLY': 0.3, 'browRY': 0.3}),
    'angry':      ('화남', {'browLAngle': 1.0, 'browRAngle': 1.0, 'browLY': -0.6, 'browRY': -0.6,
                           'eyeOpenL': 0.72, 'eyeOpenR': 0.72, 'mouthForm': -0.8, 'anger': 1.0}),
    'furious':    ('분노', {'browLAngle': 1.0, 'browRAngle': 1.0, 'browLY': -0.9, 'browRY': -0.9,
                           'eyeOpenL': 0.85, 'eyeOpenR': 0.85, 'eyeBall': -0.6, 'mouthForm': -1.0,
                           'mouthOpen': 0.55, 'anger': 1.0}),
    'pout':       ('삐짐', {'browLAngle': 0.6, 'browRAngle': 0.6, 'browLY': -0.3, 'browRY': -0.3,
                           'eyeOpenL': 0.75, 'eyeOpenR': 0.75, 'eyeX': -0.55, 'mouthForm': -0.6, 'cheek': 0.45}),
    'sad':        ('슬픔', {'browLAngle': -1.0, 'browRAngle': -1.0, 'browLY': 0.2, 'browRY': 0.2,
                           'eyeOpenL': 0.7, 'eyeOpenR': 0.7, 'eyeY': -0.5, 'mouthForm': -0.9}),
    'cry':        ('울음', {'browLAngle': -1.0, 'browRAngle': -1.0, 'browLY': 0.35, 'browRY': 0.35,
                           'eyeOpenL': 0.6, 'eyeOpenR': 0.6, 'eyeY': -0.3, 'mouthForm': -1.0, 'mouthOpen': 0.35,
                           'tear': 1.0, 'cheek': 0.4}),
    'surprised':  ('놀람', {'browLY': 1.0, 'browRY': 1.0, 'browLAngle': -0.3, 'browRAngle': -0.3, 'eyeBall': -1.0,
                           'mouthOpen': 0.7, 'mouthForm': -0.2}),
    'shock':      ('충격', {'browLY': 0.8, 'browRY': 0.8, 'browLAngle': -0.8, 'browRAngle': -0.8, 'eyeBall': -1.0,
                           'mouthOpen': 0.4, 'mouthForm': -0.9, 'gloom': 1.0, 'sweat': 0.8}),
    'scared':     ('무서움', {'browLAngle': -1.0, 'browRAngle': -1.0, 'browLY': 0.6, 'browRY': 0.6, 'eyeBall': -0.8,
                             'mouthForm': -1.0, 'mouthOpen': 0.2, 'gloom': 0.6, 'sweat': 1.0}),
    'troubled':   ('곤란', {'browLAngle': -0.9, 'browRAngle': -0.9, 'browLY': 0.3, 'browRY': 0.3, 'eyeX': 0.4,
                           'mouthForm': 0.3, 'sweat': 1.0}),
    'awkward':    ('어색한 웃음', {'eyeSmile': 0.6, 'browLAngle': -0.8, 'browRAngle': -0.8, 'mouthForm': 0.7,
                                'mouthOpen': 0.15, 'sweat': 1.0}),
    'smug':       ('의기양양', {'eyeOpenL': 0.62, 'eyeOpenR': 0.62, 'browLY': 0.3, 'browRY': 0.3,
                              'browLAngle': 0.3, 'browRAngle': 0.3, 'mouthForm': 1.0, 'eyeY': -0.15}),
    'doubt':      ('의심', {'eyeOpenL': 0.62, 'eyeOpenR': 0.85, 'browLY': -0.5, 'browRY': 0.6, 'browLAngle': 0.6,
                           'browRAngle': -0.2, 'eyeX': -0.4, 'mouthForm': -0.4}),
    'thinking':   ('생각 중', {'eyeX': 0.6, 'eyeY': 0.6, 'browLY': 0.5, 'browRY': -0.1, 'browLAngle': -0.3,
                             'mouthForm': -0.25}),
    'sleepy':     ('졸림', {'eyeOpenL': 0.32, 'eyeOpenR': 0.32, 'browLY': -0.2, 'browRY': -0.2,
                           'browLAngle': -0.4, 'browRAngle': -0.4, 'eyeY': -0.3, 'mouthOpen': 0.1}),
    'winkL':      ('윙크(왼)', {'eyeOpenL': 0.0, 'eyeSmile': 0.3, 'mouthForm': 1.0, 'browLY': -0.2, 'browRY': 0.3}),
    'winkR':      ('윙크(오른)', {'eyeOpenR': 0.0, 'eyeSmile': 0.3, 'mouthForm': 1.0, 'browRY': -0.2, 'browLY': 0.3}),
    'starry':     ('반짝반짝', {'sparkle': 1.0, 'eyeBall': 0.8, 'eyeSmile': 0.15, 'mouthForm': 1.0, 'mouthOpen': 0.35,
                               'browLY': 0.5, 'browRY': 0.5, 'cheek': 0.3}),
    'heart':      ('하트 눈', {'heartEyes': 1.0, 'cheek': 0.9, 'mouthForm': 1.0, 'mouthOpen': 0.3, 'browLY': 0.4,
                             'browRY': 0.4, 'browLAngle': -0.3, 'browRAngle': -0.3}),
    'blank':      ('멍', {'blankEyes': 1.0, 'gloom': 0.7, 'mouthOpen': 0.25, 'mouthForm': -0.5, 'browLY': 0.6,
                         'browRY': 0.6, 'sweat': 0.6}),
    'jito':       ('게슴츠레', {'eyeOpenL': 0.45, 'eyeOpenR': 0.45, 'browLY': -0.4, 'browRY': -0.4,
                              'browLAngle': 0.2, 'browRAngle': 0.2, 'mouthForm': -0.35, 'eyeX': 0.3}),
    'determined': ('의욕', {'browLAngle': 0.7, 'browRAngle': 0.7, 'browLY': -0.2, 'browRY': -0.2, 'eyeBall': 0.3,
                           'mouthForm': 0.6, 'mouthOpen': 0.25}),
}


def eye_boxes(rig, L):
    """Per eye side ('r' = image left, 'l' = image right): (x0, y0, x1, y1) of its white (or lashes)."""
    by = {p.name: p for p in rig.parts}
    out = {}
    for s in ('r', 'l'):
        for n in (f'eyewhite_{s}', f'eyelash_{s}', f'irides_{s}'):
            if n in by:
                ys, xs = np.nonzero(by[n].rgba[..., 3] > 0.4)
                if len(xs) > 30:
                    out[s] = (xs.min(), ys.min(), xs.max(), ys.max())
                    break
    return out


def add_brows(rig, L, R):
    cx = L['cx']
    for p in rig.parts:
        if p.name not in ('eyebrow_l', 'eyebrow_r'):
            continue
        side = 'L' if p.name.endswith('_l') else 'R'          # the character's left brow, like eyeOpenL
        a = p.rgba[..., 3]
        ys, xs = np.nonzero(a > 0.3)
        if len(xs) < 20:
            continue
        bx, by = xs.mean(), ys.mean()
        P = p.warp.rest
        z = np.zeros_like(P)
        dy = 0.09 * R
        p.keys[f'brow{side}Y'] = {-1.0: z + np.float32([0, dy]), 0.0: z, 1.0: z + np.float32([0, -dy])}
        inner = np.sign(cx - bx) or 1.0

        def rot(v):
            t = np.radians(16.0) * v * inner
            x, y = P[..., 0] - bx, P[..., 1] - by
            return np.stack([x * np.cos(t) - y * np.sin(t) - x, x * np.sin(t) + y * np.cos(t) - y], -1).astype(np.float32)
        p.keys[f'brow{side}Angle'] = {-1.0: rot(-1.0), 0.0: z, 1.0: rot(1.0)}


def add_eyeball(rig):
    """Irises and pupils (and their highlights) grow / shrink about the iris centre."""
    for s in ('l', 'r'):
        iris = next((p for p in rig.parts if p.name == f'irides_{s}'), None)
        if iris is None:
            continue
        ys, xs = np.nonzero(iris.rgba[..., 3] > 0.4)
        if len(xs) < 20:
            continue
        c = np.float32([xs.mean(), ys.mean()])
        for p in rig.parts:
            if p.name in (f'irides_{s}', f'pupil_{s}', f'highlight_{s}', f'highlight2_{s}'):
                P = p.warp.rest
                z = np.zeros_like(P)
                k = 0.18 if p.name.startswith(('irides', 'pupil')) else 0.1
                p.keys['eyeBall'] = {-1.0: ((P - c) * -k).astype(np.float32), 0.0: z,
                                     1.0: ((P - c) * (0.6 * k)).astype(np.float32)}


class Canvas:
    """Supersampled RGBA drawing on the rig canvas."""
    def __init__(self, H, W, ss=2):
        self.ss, self.H, self.W = ss, H, W
        self.im = Image.new('RGBA', (W * ss, H * ss), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.im)

    def P(self, pts):
        return [(x * self.ss, y * self.ss) for x, y in pts]

    def done(self):
        a = np.asarray(self.im.resize((self.W, self.H), Image.LANCZOS)).astype(np.float32) / 255
        return a


def soft_ellipse(H, W, cx, cy, rx, ry):
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    r = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2
    return np.exp(-1.6 * r)


def draw_blush(H, W, eyes, face_a, R):
    rgba = np.zeros((H, W, 4), np.float32)
    rgba[..., :3] = (1.0, 0.52, 0.58)
    a = np.zeros((H, W), np.float32)
    c = Canvas(H, W)
    for s, (x0, y0, x1, y1) in eyes.items():
        ew = x1 - x0
        cx, cy = (x0 + x1) / 2, y1 + 0.42 * ew
        a = np.maximum(a, 0.5 * soft_ellipse(H, W, cx, cy, 0.62 * ew, 0.3 * ew))
        # the hatch: 4 short strokes leaning one way
        for i in range(4):
            hx = cx + (i - 1.5) * 0.2 * ew
            c.d.line(c.P([(hx - 0.04 * ew, cy + 0.12 * ew), (hx + 0.06 * ew, cy - 0.12 * ew)]),
                     fill=(225, 80, 100, 210), width=max(2, int(0.022 * ew * c.ss)))
    lines = c.done()
    out = np.zeros_like(rgba)
    la = lines[..., 3]
    out[..., :3] = rgba[..., :3] * (1 - la[..., None]) + lines[..., :3] * la[..., None]
    out[..., 3] = np.clip(a + la * (1 - a), 0, 1) * face_a
    return out


def draw_tears(H, W, eyes, R, cx_face):
    c = Canvas(H, W)
    for s, (x0, y0, x1, y1) in eyes.items():
        ew, eh = x1 - x0, y1 - y0
        outer = x0 if (x0 + x1) / 2 < cx_face else x1
        inward = 1 if outer == x0 else -1
        # a wet line along the lower lid, then a stream from its outer third down the cheek
        lid = [(x0 + ew * t, y1 - 0.06 * eh * np.sin(np.pi * t)) for t in np.linspace(0.05, 0.95, 12)]
        c.d.line(c.P(lid), fill=(150, 210, 255, 210), width=int(0.07 * ew * c.ss), joint='curve')
        sx = outer + inward * 0.25 * ew
        stream = [(sx + inward * 0.04 * ew * np.sin(t * 3), y1 + t * 0.9 * ew) for t in np.linspace(0, 1, 14)]
        c.d.line(c.P(stream), fill=(140, 200, 255, 220), width=int(0.13 * ew * c.ss), joint='curve')
        ex, ey = stream[-1]
        r = 0.1 * ew
        c.d.ellipse(c.P([(ex - r, ey - r), (ex + r, ey + 1.3 * r)]), fill=(140, 200, 255, 230))
        # highlights
        c.d.line(c.P([(sx - inward * 0.012 * ew, y1 + 0.1 * ew), (sx - inward * 0.012 * ew, y1 + 0.45 * ew)]),
                 fill=(255, 255, 255, 230), width=max(2, int(0.02 * ew * c.ss)))
    return c.done()


def draw_gloom(H, W, L, R, face_a, hair_a):
    rgba = np.zeros((H, W, 4), np.float32)
    top = L['top_y'] + 0.25 * (L['eye_y'] - L['top_y'])
    yy = np.arange(H, dtype=np.float32)[:, None]
    fade = np.clip((L['eye_y'] + 0.25 * R - yy) / max(1.0, L['eye_y'] + 0.25 * R - top), 0, 1)
    tint = 0.42 * fade * np.ones((1, W), np.float32)
    c = Canvas(H, W)
    n = 9
    for i in range(n):
        x = L['cx'] + (i - (n - 1) / 2) * 0.17 * R
        y0 = top + (0.05 * R if i % 2 else 0)
        y1 = L['eye_y'] - (0.05 if i % 2 else 0.18) * R
        c.d.line(c.P([(x, y0), (x, y1)]), fill=(70, 60, 150, 200), width=max(2, int(0.012 * R * c.ss)))
    lines = c.done()
    la = lines[..., 3] * fade
    rgba[..., :3] = np.float32([0.35, 0.35, 0.65]) * (1 - la[..., None]) + lines[..., :3] * la[..., None]
    head = np.clip(face_a + (yy < L['eye_y']).astype(np.float32), 0, 1)   # lines run over the bangs too
    skin = face_a * (1 - hair_a)                                        # the cold tint only on visible skin
    rgba[..., 3] = np.clip(tint * skin + la * head * (1 - tint * skin), 0, 1)
    return rgba


def draw_sweat(H, W, L, R, side_x):
    c = Canvas(H, W)
    x, y = side_x, L['top_y'] + 0.55 * (L['eye_y'] - L['top_y'])
    h, w = 0.42 * R, 0.24 * R
    pts = []
    for t in np.linspace(0, 2 * np.pi, 48):
        # a drop: round bottom, pointed top
        px = np.sin(t) * w / 2 * (1 - 0.6 * max(0.0, np.cos(t)) ** 2)
        py = -np.cos(t) * h / 2
        pts.append((x + px, y + py))
    c.d.polygon(c.P(pts), fill=(170, 225, 255, 235), outline=(60, 130, 200, 255), width=max(2, int(0.02 * R * c.ss)))
    c.d.line(c.P([(x - 0.05 * R, y + 0.02 * R), (x - 0.05 * R, y + 0.12 * R)]), fill=(255, 255, 255, 240),
             width=max(2, int(0.03 * R * c.ss)))
    return c.done()


def draw_anger(H, W, L, R, side_x):
    c = Canvas(H, W)
    x, y = side_x, L['top_y'] + 0.3 * (L['eye_y'] - L['top_y'])
    s = 0.17 * R
    col = (225, 30, 45, 255)
    wd = max(3, int(0.045 * R * c.ss))
    for dx, dy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        # each quarter: a bracket bending toward the centre
        cx, cy = x + dx * s, y + dy * s
        box = [(cx - s * 0.8, cy - s * 0.8), (cx + s * 0.8, cy + s * 0.8)]
        start = {(-1, -1): 0, (1, -1): 90, (-1, 1): 270, (1, 1): 180}[(dx, dy)]
        c.d.arc(c.P(box), start, start + 90, fill=col, width=wd)
    return c.done()


def add_fx(rig, L, R):
    H, W = rig.size
    by = {p.name: p for p in rig.parts}
    face_a = by['face'].rgba[..., 3] if 'face' in by else np.ones((H, W), np.float32)
    eyes = eye_boxes(rig, L)
    fys, fxs = np.nonzero(face_a > 0.5)
    fx0, fx1 = (fxs.min(), fxs.max()) if len(fxs) else (L['cx'] - R, L['cx'] + R)
    made = []
    if eyes:
        made.append(('fx blush', draw_blush(H, W, eyes, face_a, R)))
        made.append(('fx tears', draw_tears(H, W, eyes, R, L['cx'])))
    hairs = [p.rgba[..., 3] for p in rig.parts if p.name == 'front hair']
    hair_a = np.max(hairs, 0) if hairs else np.zeros((H, W), np.float32)
    made.append(('fx gloom', draw_gloom(H, W, L, R, face_a, hair_a)))
    made.append(('fx sweat', draw_sweat(H, W, L, R, fx1 + 0.12 * R)))           # the image-right temple
    made.append(('fx anger', draw_anger(H, W, L, R, fx0 + 0.05 * R)))           # the image-left upper head
    # draw order (artisan.ORDER): blush on the skin under the eyes, gloom and tears over the eyes under the
    # bangs, sweat and the anger mark over everything
    eye_bases = ('eyewhite', 'irides', 'pupil', 'highlight', 'eyelash', 'lash', 'eyelid', 'eyemask', 'smileeye')
    for name, rgba in made:
        if (rgba[..., 3] > 0.05).sum() < 20:
            continue
        q = Part(name, rgba.astype(np.float32), None, 60)
        q.opacity[FX[name]] = ([0.0, 1.0], [0.0, 1.0])
        names = [p.name for p in rig.parts]
        if name == 'fx blush':
            at = next((i for i, n in enumerate(names) if n.startswith(eye_bases)), len(names))
        elif name == 'fx tears':
            at = next((i for i, n in enumerate(names) if n == 'front hair'), len(names))
        else:
            at = len(names)
        rig.parts.insert(at, q)


def brows_over_hair(rig, alpha=0.45):
    """Anime faces show the brows through the bangs: a see-through copy of each brow above the front hair
    (same warp and keyforms), so a raised or knitted brow reads even under the hair."""
    names = [p.name for p in rig.parts]
    last_hair = max((i for i, n in enumerate(names) if n == 'front hair'), default=None)
    if last_hair is None:
        return
    copies = []
    for p in rig.parts:
        if p.name in ('eyebrow_l', 'eyebrow_r'):
            q = Part(p.name, p.rgba.copy(), p.depth, 60)
            q.rgba[..., 3] *= alpha
            q.warp, q.keys = p.warp, p.keys          # shared: moves exactly with the brow
            copies.append(q)
    rig.parts[last_hair + 1:last_hair + 1] = copies


def star(c, x, y, r, fill):
    pts = []
    for i in range(8):
        a = np.pi / 4 * i - np.pi / 2
        rr = r if i % 2 == 0 else 0.28 * r
        pts.append((x + rr * np.cos(a), y + rr * np.sin(a)))
    c.d.polygon(c.P(pts), fill=fill)


def heart(c, x, y, s, fill, outline):
    pts = []
    for t in np.linspace(0, 2 * np.pi, 64):
        hx = 16 * np.sin(t) ** 3
        hy = -(13 * np.cos(t) - 5 * np.cos(2 * t) - 2 * np.cos(3 * t) - np.cos(4 * t))
        pts.append((x + hx / 17 * s, y + hy / 17 * s))
    c.d.polygon(c.P(pts), fill=fill, outline=outline, width=max(2, int(0.08 * s * c.ss)))


def add_eye_fx(rig):
    """Per eye, on the iris's own warp and keyforms (they follow the gaze, the eyeball size and the head):
    sparkle stars, heart irises (clipped to the eye white), and blank eyes (the iris fades out)."""
    H, W = rig.size
    for s in ('l', 'r'):
        by = {p.name: p for p in rig.parts}
        iris = by.get(f'irides_{s}')
        if iris is None or f'eyewhite_{s}' not in by:
            continue
        ys, xs = np.nonzero(iris.rgba[..., 3] > 0.4)
        if len(xs) < 30:
            continue
        x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
        cx, cy, r = (x0 + x1) / 2, (y0 + y1) / 2, max(x1 - x0, y1 - y0) / 2
        c = Canvas(H, W)
        heart(c, cx, cy + 0.08 * r, 0.95 * r, (245, 80, 140, 255), (170, 30, 80, 255))
        star(c, cx - 0.32 * r, cy - 0.4 * r, 0.22 * r, (255, 255, 255, 235))
        hearts = c.done()
        c = Canvas(H, W)
        star(c, cx - 0.3 * r, cy - 0.35 * r, 0.42 * r, (255, 255, 255, 250))
        star(c, cx + 0.35 * r, cy + 0.3 * r, 0.22 * r, (255, 255, 255, 235))
        sparks = c.done()
        last = max(i for i, p in enumerate(rig.parts) if p.name.endswith('_' + s) and
                   p.name.startswith(('irides', 'pupil', 'highlight')))
        made = []
        for name, rgba, param in (('fx heart', hearts, 'heartEyes'), ('fx sparkle', sparks, 'sparkle')):
            q = Part(f'{name}_{s}', rgba.astype(np.float32), None, 60)
            q.warp, q.keys = iris.warp, iris.keys
            q.clip = f'eyewhite_{s}'
            q.opacity[param] = ([0.0, 1.0], [0.0, 1.0])
            made.append(q)
        rig.parts[last + 1:last + 1] = made
        for p in rig.parts:
            if p.name.endswith('_' + s) and p.name.startswith(('irides', 'pupil', 'highlight')):
                p.opacity['blankEyes'] = ([0.0, 1.0], [1.0, 0.0])
        # hearts hide the iris under them
        for p in rig.parts:
            if p.name in (f'irides_{s}', f'pupil_{s}', f'highlight_{s}', f'highlight2_{s}'):
                p.opacity['heartEyes'] = ([0.0, 1.0], [1.0, 0.0])


def add_mouth_wide(rig):
    """Every mouth part narrows (-1: 0.6x, a little taller) or widens (+1: 1.3x, a little flatter) about the mouth's
    centre - the closed line and the open drawing alike, so the vowels i / u / e / o come from one drawing."""
    names = ('mouth', 'mouthmask', 'mouth_inner', 'mouth_upper', 'mouth_lower')
    ms = [p for p in rig.parts if p.name in names]
    base = next((p for p in ms if p.name == 'mouth'), None) or (ms[0] if ms else None)
    if base is None:
        return
    ys, xs = np.nonzero(base.rgba[..., 3] > 0.3)
    if len(xs) < 5:
        return
    c = np.float32([xs.mean(), ys.mean()])
    for p in ms:
        P = p.warp.rest
        d = P - c
        z = np.zeros_like(P)
        narrow = np.stack([d[..., 0] * -0.4, d[..., 1] * 0.12], -1).astype(np.float32)
        wide = np.stack([d[..., 0] * 0.3, d[..., 1] * -0.15], -1).astype(np.float32)
        p.keys['mouthWide'] = {-1.0: narrow, 0.0: z, 1.0: wide}


def add_expression_rig(rig, L, R, fx=False):
    """Plain deformations always (brows, mouth width, eye size); fx=True adds the effect parts (blush, tears, gloom,
    sweat, anger, sparkle / heart / blank eyes) and the see-through brows over the bangs."""
    add_brows(rig, L, R)
    add_mouth_wide(rig)
    add_eyeball(rig)
    if fx:
        brows_over_hair(rig)
        add_eye_fx(rig)
        add_fx(rig, L, R)
