"""
Experiment 0: does see-through give finer face parts from an upscaled face crop?

Compares the eye region of the full-body run (v1) with runs on face crops (A: head + shoulders, B: head),
all shown at the same size: composite, eyewhite, irides, eyelash, plus layer sizes.

  python v2/py/exp0_compare.py <out.png>
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont
from psd_tools import PSDImage

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
RUN = os.path.join(ROOT, '.local', 'v2_runs', 'exp0')
SRC_EYES = (374, 175, 577, 300)          # eye region in the 960x1280 source picture
RUNS = [
    # name, psd, crop box of the input in source coords (square), psd size
    ('v1 전신', os.path.join(ROOT, 'seethrough', '.jobs', '3f5fbcd01d01', 'fixed', 'redrawn_prepared.psd'), (-160, 0, 1120, 1280)),
    ('A 머리+어깨', os.path.join(RUN, 'out_A_headshoulders', 'A_headshoulders.psd'), (214, 40, 734, 560)),
    ('B 머리', os.path.join(RUN, 'out_B_head', 'B_head.psd'), (304, 45, 644, 385)),
]
LAYERS = ['eyewhite', 'irides', 'eyelash', 'eyebrow']
CELL = (520, 320)


def region(psd, box):
    s = psd.width / (box[2] - box[0])
    return tuple(round((v - box[i % 2]) * s) for i, v in enumerate(SRC_EYES)), s


def render(psd, names, r, bg):
    im = Image.new('RGBA', (psd.width, psd.height), bg)
    for l in psd.descendants():
        if l.kind == 'group' or (names and l.name not in names) or (not names and not l.is_visible()):
            continue
        if names is None and l.parent is not psd:
            continue
        im.alpha_composite(l.topil().convert('RGBA'), (l.left, l.top))
    return im.crop(r).resize(CELL, Image.LANCZOS)


def main(out):
    rows = []
    for title, path, box in RUNS:
        if not os.path.exists(path):
            print('missing', path)
            continue
        psd = PSDImage.open(path)
        r, s = region(psd, box)
        cells = [render(psd, None, r, (255, 255, 255, 255))]
        cells += [render(psd, [n], r, (190, 190, 190, 255)) for n in LAYERS]
        eye_w = round((SRC_EYES[2] - SRC_EYES[0]) * s / 2)
        rows.append((f'{title}  (눈 영역 폭 약 {eye_w}px)', cells))
    W = Image.new('RGB', (CELL[0] * (len(LAYERS) + 1), (CELL[1] + 28) * len(rows)), 'white')
    d = ImageDraw.Draw(W)
    try:
        font = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 16)
    except OSError:
        font = None
    for i, (t, cells) in enumerate(rows):
        y = i * (CELL[1] + 28)
        d.text((8, y + 4), t + '   |   ' + ' / '.join(['합성'] + LAYERS), fill='black', font=font)
        for j, c in enumerate(cells):
            W.paste(c.convert('RGB'), (j * CELL[0], y + 28))
    W.save(out)
    print(out)


if __name__ == '__main__':
    main(sys.argv[1])
