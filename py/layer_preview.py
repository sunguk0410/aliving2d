"""
Previews of the layers see-through split a picture into, for the dashboards (the PSD itself is not served).

  write_layers(job_dir)   work/<job>/layers/{body,head}/NN_<name>.png (each layer cropped to its drawing, at most
                          420 px) + layers/layers.json:
                          {"body": {"size": [w, h], "layers": [{"name", "file", "box": [x, y, w, h], "px"}]}, "head": …, "ears": …}
                          box = where the crop sits on the PSD canvas (for the stacked view), px = drawn pixels.
                          Listed bottom -> top in the artisan's stacking order (artisan.ORDER, the order the rig uses),
                          not see-through's depth guess (which sometimes puts the bangs under the eyes); `depth` = the
                          layer's place in see-through's own order.

  python py/layer_preview.py work/<job>      (jobs made before this existed)
"""
import json
import os
import sys

import numpy as np
from PIL import Image
from psd_tools import PSDImage

sys.path.insert(0, os.path.dirname(__file__))
from artisan import ORDER  # noqa: E402

MAX = 420


def psd_layers(psd_path, out_dir, rel):
    psd = PSDImage.open(psd_path)
    os.makedirs(out_dir, exist_ok=True)
    for f in os.listdir(out_dir):
        if f.endswith('.png'):
            os.remove(os.path.join(out_dir, f))
    out = []
    for i, l in enumerate(l for l in psd.descendants() if l.kind != 'group'):   # bottom -> top
        im = l.topil()
        if im is None:
            continue
        im = im.convert('RGBA')
        a = np.asarray(im)[..., 3]
        a = np.where(a < 8, 0, a)
        px = int((a > 128).sum())
        if px < 50:
            continue
        ys, xs = np.nonzero(a)
        x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
        crop = im.crop((x0, y0, x1, y1))
        s = min(1.0, MAX / max(crop.size))
        if s < 1:
            crop = crop.resize((max(1, round(crop.width * s)), max(1, round(crop.height * s))), Image.LANCZOS)
        fn = f'{i:02d}_{l.name.replace(" ", "_")}.png'
        crop.save(os.path.join(out_dir, fn), optimize=True)
        out.append(dict(name=l.name, file=f'{rel}/{fn}', box=[int(l.left + x0), int(l.top + y0), int(x1 - x0), int(y1 - y0)], px=px,
                        depth=len(out)))
    out.sort(key=lambda d: rank(d['name']))           # stable: unknown names keep see-through's order, on top
    return dict(size=[psd.width, psd.height], layers=out)


def rank(name):
    b = name.rsplit('_', 1)[0] if name.endswith(('_l', '_r')) else name
    return ORDER.index(b) if b in ORDER else len(ORDER)


def write_layers(job_dir):
    res = {}
    # parts.psd: jobs from before the waist-up base (one split of the front picture), shown as the body layers
    # ears.psd: the head drawn again with the hair over the ears (hair_cover.py) - the model's front hair comes from it
    for key, psd in (('body', 'body.psd'), ('head', 'head.psd'), ('ears', 'ears.psd'), ('body', 'parts.psd')):
        p = os.path.join(job_dir, psd)
        if os.path.exists(p) and key not in res:
            res[key] = psd_layers(p, os.path.join(job_dir, 'layers', key), key)
    if res:
        with open(os.path.join(job_dir, 'layers', 'layers.json'), 'w', encoding='utf-8') as f:
            json.dump(res, f, ensure_ascii=False)
    return {k: len(v['layers']) for k, v in res.items()}


if __name__ == '__main__':
    for d in sys.argv[1:]:
        print(d, write_layers(d))
