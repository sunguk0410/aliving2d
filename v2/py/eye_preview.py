"""
Preview sheet for eye_parts.py output: every part on grey, then a gaze test (iris + pupil + highlights moved,
clipped to the eye white, lashes on top), so the filled-in hidden iris can be judged.

  python v2/py/eye_preview.py <see-through psd> <parts dir> <out.png> [eyeR|eyeL]
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from psd_tools import PSDImage

sys.path.insert(0, os.path.dirname(__file__))
from eye_parts import layer_rgba, over  # noqa: E402

Z = 4


def load(d, eye, k):
    return np.asarray(Image.open(os.path.join(d, f'{eye}_{k}.png'))).astype(np.float32) / 255.0


def shift(a, dx, dy):
    out = np.zeros_like(a)
    h, w = a.shape[:2]
    ys, yd = (slice(0, h - dy), slice(dy, h)) if dy >= 0 else (slice(-dy, h), slice(0, h + dy))
    xs, xd = (slice(0, w - dx), slice(dx, w)) if dx >= 0 else (slice(-dx, w), slice(0, w + dx))
    out[yd, xd] = a[ys, xs]
    return out


def on_grey(a, g=0.75):
    bg = np.concatenate([np.full(a.shape[:2] + (3,), g, np.float32), np.ones(a.shape[:2] + (1,), np.float32)], -1)
    return over(bg, a)


def to_img(a):
    return Image.fromarray((np.clip(a[..., :3], 0, 1) * 255 + 0.5).astype(np.uint8)).resize((a.shape[1] * Z, a.shape[0] * Z), Image.LANCZOS)


def main(psd_path, d, out, eye='eyeR'):
    info = json.load(open(os.path.join(d, 'eyes.json'), encoding='utf-8'))[eye]
    x0, y0, x1, y1 = info['box']
    psd = PSDImage.open(psd_path)
    white = layer_rgba(psd, 'eyewhite')[y0:y1, x0:x1]
    face = layer_rgba(psd, 'face')[y0:y1, x0:x1]
    P = {k: load(d, eye, k) for k in ('iris', 'pupil', 'highlight', 'highlight2', 'lash_upper', 'lash_lower', 'lash_crease')}
    tiles = [('흰자', on_grey(white))]
    tiles += [(k, on_grey(P[k])) for k in P]

    def eye_at(dx, dy, hdx=None, hdy=None):
        hdx = dx // 2 if hdx is None else hdx
        hdy = dy // 2 if hdy is None else hdy
        c = over(face.copy(), white)
        ball = shift(P['iris'], dx, dy)
        ball = over(ball, shift(P['pupil'], dx, dy))
        ball = over(ball, shift(P['highlight2'], dx, dy))
        ball = over(ball, shift(P['highlight'], hdx, hdy))     # highlight moves less (it reflects the light, not the ball)
        ball[..., 3] *= white[..., 3]
        c = over(c, ball)
        for k in ('lash_crease', 'lash_lower', 'lash_upper'):
            c = over(c, P[k])
        return on_grey(c)

    r = info['iris_ellipse'][2]
    m = int(r * 0.45)
    tests = [('정면', eye_at(0, 0)), ('위', eye_at(0, -m)), ('아래', eye_at(0, m)), ('왼쪽', eye_at(-m, 0)), ('오른쪽', eye_at(m, 0))]
    rows = [tiles[:4], tiles[4:], tests[:4], tests[4:]]
    tw, th = to_img(tiles[0][1]).size
    W = Image.new('RGB', (tw * 4, (th + 26) * len(rows)), 'white')
    dr = ImageDraw.Draw(W)
    try:
        font = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 18)
    except OSError:
        font = None
    for i, row in enumerate(rows):
        for j, (t, a) in enumerate(row):
            W.paste(to_img(a), (j * tw, i * (th + 26) + 26))
            dr.text((j * tw + 6, i * (th + 26) + 2), t, fill='black', font=font)
    W.save(out)
    print(out)


if __name__ == '__main__':
    main(*sys.argv[1:])
