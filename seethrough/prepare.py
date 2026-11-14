#!/usr/bin/env python3
"""
Picture -> see-through friendly input (runs in seethrough/.venv).

see-through works best on what its own examples look like: ONE character on
a plain white background, in a 3:4 portrait frame, around 1280 px tall. A
scene (classroom, desk, laptop) makes it guess layers for the background and
props, and their depth order confuses the character's parts.

  1. background removal with an anime character segmentation model
     (ISNet anime-seg, skytnt/anime-seg on Hugging Face, Apache-2.0; ~170 MB,
     downloaded once). A picture that already has transparency keeps its alpha.
  2. keep the main character (largest region + pieces close to its size,
     e.g. a separated hand or hair strand); props and stray bits go
  3. crop to the character with a margin, put it on white in a 3:4 frame,
     scale so the long side is 1280 px

  python seethrough/prepare.py in.png out.png        -> prints a JSON summary
"""
import json
import sys

import cv2
import numpy as np
from PIL import Image

TARGET_H = 1280
ASPECT = 3 / 4          # width / height, like see-through's examples (928x1232)
SEG_SIZE = 1024
_session = None


def segmenter():
    global _session
    if _session is None:
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        path = hf_hub_download('skytnt/anime-seg', 'isnetis.onnx')
        _session = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
    return _session


def character_mask(rgb):
    """0..1 float mask of anime characters (ISNet anime-seg), same size as rgb."""
    h0, w0 = rgb.shape[:2]
    s = SEG_SIZE
    h, w = (s, int(s * w0 / h0)) if h0 > w0 else (int(s * h0 / w0), s)
    ph, pw = s - h, s - w
    x = np.zeros((s, s, 3), np.float32)
    x[ph // 2:ph // 2 + h, pw // 2:pw // 2 + w] = cv2.resize(rgb.astype(np.float32) / 255, (w, h), interpolation=cv2.INTER_AREA)
    m = segmenter().run(None, {'img': x.transpose(2, 0, 1)[None]})[0][0, 0]
    m = m[ph // 2:ph // 2 + h, pw // 2:pw // 2 + w]
    return np.clip(cv2.resize(m, (w0, h0), interpolation=cv2.INTER_LINEAR), 0, 1)


def keep_main(mask):
    """Largest region plus regions at least 5% of it that sit near it; soft edges kept."""
    hard = (mask > 0.5).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(hard, connectivity=8)
    if n <= 1:
        return mask, None
    areas = stats[1:, cv2.CC_STAT_AREA]
    big = 1 + int(np.argmax(areas))
    bx, by, bw, bh = stats[big, :4]
    reach = 0.25 * max(bw, bh)
    keep = np.zeros(n, bool)
    keep[big] = True
    for i in range(1, n):
        if i == big or stats[i, cv2.CC_STAT_AREA] < 0.05 * areas.max():
            continue
        x, y, w, h = stats[i, :4]
        gap_x = max(0, max(bx - (x + w), x - (bx + bw)))
        gap_y = max(0, max(by - (y + h), y - (by + bh)))
        if max(gap_x, gap_y) <= reach:
            keep[i] = True
    region = keep[lab].astype(np.uint8)
    region = cv2.dilate(region, np.ones((5, 5), np.uint8))   # keep the soft edge around kept regions
    return mask * region, (bx, by, bw, bh)


def prepare(src, dst):
    im = Image.open(src)
    im.load()
    rgba = np.array(im.convert('RGBA'))
    rgb = rgba[..., :3]
    has_alpha = rgba[..., 3].min() < 250 and (rgba[..., 3] < 16).mean() > 0.02
    if has_alpha:
        mask, how = rgba[..., 3].astype(np.float32) / 255, 'alpha'
    else:
        mask, how = character_mask(rgb), 'segment'
    raw_cover = float((mask > 0.5).mean())
    mask, _ = keep_main(mask)
    ys, xs = np.nonzero(mask > 0.5)
    if len(xs) < 500:
        raise SystemExit('그림에서 캐릭터를 찾지 못했습니다')
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    bw, bh = x1 - x0, y1 - y0
    margin = int(0.05 * max(bw, bh))
    # frame: 3:4 portrait around the character, character centred
    fh = bh + 2 * margin
    fw = max(bw + 2 * margin, int(round(fh * ASPECT)))
    fh = max(fh, int(round(fw / ASPECT)))
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    ox, oy = int(round(cx - fw / 2)), int(round(cy - fh / 2))
    # composite on white (straight alpha), cut out the frame (outside the picture = white)
    a = mask[..., None]
    white = np.full_like(rgb, 255)
    comp = (rgb.astype(np.float32) * a + white * (1 - a)).astype(np.uint8)
    out = np.full((fh, fw, 3), 255, np.uint8)
    sx0, sy0, sx1, sy1 = max(0, ox), max(0, oy), min(rgb.shape[1], ox + fw), min(rgb.shape[0], oy + fh)
    out[sy0 - oy:sy1 - oy, sx0 - ox:sx1 - ox] = comp[sy0:sy1, sx0:sx1]
    scale = TARGET_H / fh
    res = Image.fromarray(out).resize((int(round(fw * scale)), TARGET_H), Image.LANCZOS if scale < 1 else Image.BICUBIC)
    res.save(dst)
    summary = {'method': how, 'input': [int(rgb.shape[1]), int(rgb.shape[0])], 'output': list(res.size),
               'character_box': [int(x0), int(y0), int(bw), int(bh)], 'kept_fraction': round(float((mask > 0.5).mean()) / max(1e-6, raw_cover), 3),
               'scale': round(scale, 3)}
    return summary


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('usage: prepare.py in.png out.png')
    print(json.dumps(prepare(sys.argv[1], sys.argv[2]), ensure_ascii=False))
