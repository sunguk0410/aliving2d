#!/usr/bin/env python3
"""
see-through with the BODY pass only (runs in seethrough/.venv, cwd = the see-through repo).

LayerDiff3D draws a picture twice: a body pass (hair, neck, topwear, handwear, objects, ...) and
a head pass (face, eyes, mouth, ...). Study-pose pictures only need the arms and the props, so the
head pass - half of the time - is skipped; its parts are written as empty layers so the rest of
see-through (depth, PSD assembly) runs unchanged. The see-through sources are not modified: this
loads inference_psd_quantized.py, swaps run_layerdiff, then runs its own main block.

  python seethrough/body_only.py <the usual inference_psd_quantized.py arguments>
"""
import os
import sys
import textwrap

SCRIPT = os.path.join('inference', 'scripts', 'inference_psd_quantized.py')
MARK = "if __name__ == '__main__':"
HEAD_TAGS = ['headwear', 'face', 'irides', 'eyebrow', 'eyewhite', 'eyelash', 'eyewear', 'ears', 'earwear', 'nose', 'mouth']
BODY_TAGS = ['front hair', 'back hair', 'head', 'neck', 'neckwear', 'topwear', 'handwear', 'bottomwear', 'legwear', 'footwear', 'tail', 'wings', 'objects']


def run_layerdiff_body(pipeline, imgp, save_dir, seed, num_inference_steps, resolution):
    import numpy as np
    import os.path as osp
    import torch
    from PIL import Image
    from utils.cv import center_square_pad_resize
    saved = osp.join(save_dir, osp.splitext(osp.basename(imgp))[0])
    os.makedirs(saved, exist_ok=True)
    input_img = np.array(Image.open(imgp).convert('RGBA'))
    fullpage = center_square_pad_resize(input_img, resolution, return_pad_info=True)[0]
    Image.fromarray(fullpage).save(osp.join(saved, 'src_img.png'))
    rng = torch.Generator(device=pipeline.unet.device).manual_seed(seed)
    out = pipeline(strength=1.0, num_inference_steps=num_inference_steps, batch_size=1, generator=rng, guidance_scale=1.0,
                   prompt=BODY_TAGS, negative_prompt='', fullpage=fullpage, group_index=0)
    for rst, tag in zip(out.images, BODY_TAGS):
        Image.fromarray(rst).save(osp.join(saved, f'{tag}.png'))
    empty = Image.fromarray(np.zeros((resolution, resolution, 4), np.uint8))
    for tag in HEAD_TAGS:
        empty.save(osp.join(saved, f'{tag}.png'))
    print('  body pass only (head parts left empty)', flush=True)


def main():
    path = os.path.abspath(SCRIPT)
    src = open(path, encoding='utf-8').read()
    i = src.index(MARK)
    defs, body = src[:i], textwrap.dedent(src[i + len(MARK):])
    sys.argv[0] = path
    sys.path.insert(0, os.path.dirname(path))
    ns = {'__name__': 'seethrough_body_only', '__file__': path}
    exec(compile(defs, path, 'exec'), ns)
    ns['run_layerdiff'] = run_layerdiff_body
    exec(compile(body, path, 'exec'), ns)


if __name__ == '__main__':
    main()
