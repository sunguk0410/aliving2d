#!/usr/bin/env python3
"""
Expression art for a parts PSD (runs in seethrough/.venv): the eye / mouth states a
see-through PSD does not have, drawn by OpenAI image edits in the character's own style.

  closed eyes, smiling closed eyes (^ ^), mouth "ah", open smile, small "o" mouth

For each state the face is cropped and enlarged to 1024 px, only the eye (or mouth) area
is opened for editing (mask), the result is aligned back to the picture, and ONLY the
pixels that changed become a new layer. The original mouth becomes the closed mouth.

  python seethrough/expression_art.py in.psd out.psd [--src picture.png] [--only eyes_closed,...]
  key: OPENAI_API_KEY or <repo>/.local/openai.json          -> JSON summary on stdout
"""
import argparse
import base64
import io
import json
import os
import sys
import urllib.error
import urllib.request

import cv2
import numpy as np
from PIL import Image
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer

HERE = os.path.dirname(os.path.abspath(__file__))
ENDPOINT = 'https://api.openai.com/v1/images/edits'
MODEL = 'gpt-image-2.5-sunburst'
CROP = 1024
STYLE = ('Keep the exact same art style, line weight, coloring, shading, eye color, eyelashes and skin tone. '
         'Do not change anything outside the editable area. Do not move the face.')
STATES = {
    # name: (region, layer name, prompt)
    'eyes_closed': ('eyes', 'eye_close', 'Close both eyes gently, relaxed closed eyelids as in a blink (a curved lash line, slightly downward). '),
    'eyes_smile': ('eyes', 'eye_smile', 'Both eyes closed in a happy smile: upward-arched closed eyes like ^ ^, anime style. '),
    'mouth_open': ('mouth', 'mouth_open', 'Open the mouth naturally as if saying "ah", medium open, anime style mouth interior. '),
    'mouth_grin': ('mouth', 'mouth_grin', 'A big open happy smile, mouth open wide with the corners raised, anime style. '),
    'mouth_o': ('mouth', 'mouth_o', 'A small round surprised "o" mouth, slightly open, anime style. '),
    'mouth_smile': ('mouth', 'mouth_smile', 'A gentle, cute closed-mouth smile: lips closed, both corners of the mouth turned up '
                    'softly in a small upward curve, anime style. '),
}
EYE_PARTS = ('eyewhite', 'irides', 'eyelash', 'eyes')


def base(name):
    return name.strip().lower().replace('_', ' ').split('-')[0].rstrip('0123456789 ')


def api_key():
    k = os.environ.get('OPENAI_API_KEY', '').strip()
    if k:
        return k
    with open(os.path.join(os.path.dirname(HERE), '.local', 'openai.json'), encoding='utf-8') as f:
        return json.load(f)['key']


def data_url(img):
    buf = io.BytesIO()
    img.save(buf, 'PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')


def edit(key, image, mask, prompt):
    body = json.dumps({'model': MODEL, 'prompt': prompt, 'size': f'{CROP}x{CROP}', 'quality': 'high', 'background': 'opaque',
                       'output_format': 'png', 'n': 1, 'images': [{'image_url': data_url(image)}], 'mask': {'image_url': data_url(mask)}}).encode()
    req = urllib.request.Request(ENDPOINT, data=body, method='POST', headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as err:
        try:
            msg = json.loads(err.read()).get('error', {}).get('message', '')
        except ValueError:
            msg = ''
        raise RuntimeError(f'OpenAI HTTP {err.code}: {msg[:200]}')
    return Image.open(io.BytesIO(base64.b64decode(data['data'][0]['b64_json']))).convert('RGBA')


def over(rgba, base):
    """GPT can leave parts of the edited area transparent (they read as black in RGB): fill them
    from the original picture."""
    a = np.asarray(rgba)
    if a.shape[-1] == 3:
        return a
    if a.shape[:2] != base.shape[:2]:
        a = cv2.resize(a, (base.shape[1], base.shape[0]), interpolation=cv2.INTER_CUBIC)
    al = a[..., 3:4].astype(np.float32) / 255
    return (a[..., :3] * al + base * (1 - al)).astype(np.uint8)


def load(psd_path):
    psd = PSDImage.open(psd_path)
    W, H = psd.size
    layers = []
    for l in psd:
        if l.is_group():
            continue
        layers.append({'name': l.name, 'left': l.left, 'top': l.top, 'img': np.array(l.topil().convert('RGBA')), 'opacity': l.opacity})
    return W, H, layers


def canvas_alpha(W, H, L):
    a = np.zeros((H, W), np.uint8)
    h, w = L['img'].shape[:2]
    x0, y0 = max(0, L['left']), max(0, L['top'])
    x1, y1 = min(W, L['left'] + w), min(H, L['top'] + h)
    if x1 > x0 and y1 > y0:
        a[y0:y1, x0:x1] = L['img'][y0 - L['top']:y1 - L['top'], x0 - L['left']:x1 - L['left'], 3]
    return a


STATE_LAYERS = ('eye close', 'eye smile', 'mouth open', 'mouth grin', 'mouth o', 'mouth smile')


def composite(W, H, layers, rest=True):
    """Alpha-over of the layers on white. rest=True leaves out the extra states (closed / smiling
    eyes, open mouths) and pose layers, so the picture shows the character as drawn."""
    out = np.full((H, W, 3), 255.0)
    for L in layers:
        if rest and ('@' in L['name'] or base(L['name']) in STATE_LAYERS):
            continue
        h, w = L['img'].shape[:2]
        x0, y0 = max(0, L['left']), max(0, L['top'])
        x1, y1 = min(W, L['left'] + w), min(H, L['top'] + h)
        if x1 <= x0 or y1 <= y0:
            continue
        p = L['img'][y0 - L['top']:y1 - L['top'], x0 - L['left']:x1 - L['left']].astype(np.float32)
        a = p[..., 3:4] / 255 * (L['opacity'] / 255 if L['opacity'] > 1 else L['opacity'])
        out[y0:y1, x0:x1] = p[..., :3] * a + out[y0:y1, x0:x1] * (1 - a)
    return out.astype(np.uint8)


def bbox(mask):
    ys, xs = np.nonzero(mask)
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1) if len(xs) else None


def align(result, orig, keep):
    """Warp `result` onto `orig` (affine, ECC) using only the pixels outside the edited area."""
    a = cv2.cvtColor(orig, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255
    b = cv2.cvtColor(result, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        _, warp = cv2.findTransformECC(a, b, warp, cv2.MOTION_AFFINE, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6),
                                       keep.astype(np.uint8), 5)
    except cv2.error:
        return result, False
    out = cv2.warpAffine(result, warp, (orig.shape[1], orig.shape[0]), flags=cv2.INTER_CUBIC | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
    return out, True


def split_eyes(layer, eyes_mask):
    """One patch over both eyes -> left / right layers, cut halfway between the eyes
    (pixels changed in the bangs between them would otherwise join the two into one piece)."""
    n, lab, stats, cents = cv2.connectedComponentsWithStats(eyes_mask.astype(np.uint8), connectivity=8)
    if n < 3:
        return [layer]
    big = 1 + np.argsort(stats[1:, cv2.CC_STAT_AREA])[::-1][:2]
    mid = int(round((cents[big[0]][0] + cents[big[1]][0]) / 2)) - layer['left']
    out = []
    for side, sl in (('l', slice(0, max(0, mid))), ('r', slice(max(0, mid), None))):
        img = np.zeros_like(layer['img'])
        img[:, sl] = layer['img'][:, sl]
        ys, xs = np.nonzero(img[..., 3] > 3)
        if len(xs):
            x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
            out.append(dict(layer, name=layer['name'] + '-' + side, left=layer['left'] + int(x0), top=layer['top'] + int(y0), img=img[y0:y1, x0:x1].copy()))
    return out or [layer]


def censored(out, ref, region):
    """A flat near-black block inside the edited area that the original does not have."""
    r = region > 0
    if r.sum() < 100:
        return False
    dark = (out.max(-1) < 30) & ~(ref.max(-1) < 60) & r
    if dark.sum() < r.sum() * 0.03:
        return False
    n, _, stats, _ = cv2.connectedComponentsWithStats(dark.astype(np.uint8), connectivity=8)
    return bool(n > 1 and stats[1:, cv2.CC_STAT_AREA].max() > r.sum() * 0.02)


def match_colors(out, ref, keep):
    """Per-channel gain/offset so the edited picture's untouched area matches the original (GPT
    shifts tones slightly; without this the patch shows as a lighter / darker box)."""
    m = keep.astype(bool)
    if m.sum() < 500:
        return out
    o = out.astype(np.float32)
    for c in range(3):
        a, b = o[..., c][m], ref[..., c][m].astype(np.float32)
        g = b.std() / max(1e-3, a.std())
        g = min(1.25, max(0.8, g))
        o[..., c] = (o[..., c] - a.mean()) * g + b.mean()
    return np.clip(o, 0, 255).astype(np.uint8)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('psd')
    ap.add_argument('out')
    ap.add_argument('--src', help='the picture the PSD came from (default: the PSD composite)')
    ap.add_argument('--only', default=','.join(STATES))
    ap.add_argument('--reuse', help='folder with earlier raw GPT outputs (<state>.png): no new API calls for those')
    args = ap.parse_args(argv)
    W, H, layers = load(args.psd)
    cache = args.out + '.raw'   # raw GPT outputs, kept so the cut-out can be redone without paying again
    os.makedirs(cache, exist_ok=True)
    by = {}
    for i, L in enumerate(layers):
        by.setdefault(base(L['name']), []).append(i)
    if 'face' not in by:
        raise SystemExit('얼굴(face) 레이어가 없습니다')
    src = np.asarray(Image.open(args.src).convert('RGB').resize((W, H), Image.LANCZOS)) if args.src else composite(W, H, layers)

    def union(names):
        m = np.zeros((H, W), bool)
        for n in names:
            for i in by.get(n, []):
                m |= canvas_alpha(W, H, layers[i]) > 32
        return m
    face_box = bbox(union(['face']))
    eyes = union(EYE_PARTS)
    mouth = union(['mouth', 'mouth open', 'mouth close'])
    hair = union(['front hair', 'hair'])
    fx0, fy0, fx1, fy1 = face_box
    side = int(max(fx1 - fx0, fy1 - fy0) * 1.35)
    cx, cy = (fx0 + fx1) // 2, (fy0 + fy1) // 2
    ox, oy = cx - side // 2, cy - side // 2
    # face crop (white outside the canvas), enlarged to CROP
    crop = np.full((side, side, 3), 255, np.uint8)
    sx0, sy0, sx1, sy1 = max(0, ox), max(0, oy), min(W, ox + side), min(H, oy + side)
    crop[sy0 - oy:sy1 - oy, sx0 - ox:sx1 - ox] = src[sy0:sy1, sx0:sx1]
    k = CROP / side
    crop_big = cv2.resize(crop, (CROP, CROP), interpolation=cv2.INTER_CUBIC if k > 1 else cv2.INTER_AREA)
    fw = fx1 - fx0

    def region(kind):
        m = np.zeros((H, W), np.uint8)
        if kind == 'eyes':
            b = bbox(eyes)
            if not b:
                return None
            ex = int((b[2] - b[0]) * 0.12) + 4
            ey = int((b[3] - b[1]) * 0.55) + 4
            m[max(0, b[1] - ey):b[3] + ey, max(0, b[0] - ex):b[2] + ex] = 1
        else:
            b = bbox(mouth)
            if not b:
                mx, my = cx, int(fy0 + (fy1 - fy0) * 0.78)
                b = (mx - int(fw * 0.08), my - int(fw * 0.03), mx + int(fw * 0.08), my + int(fw * 0.03))
            mcx, mcy = (b[0] + b[2]) // 2, (b[1] + b[3]) // 2
            hw, hh = max((b[2] - b[0]) // 2 + int(fw * 0.06), int(fw * 0.16)), max((b[3] - b[1]) // 2 + int(fw * 0.05), int(fw * 0.1))
            m[max(0, mcy - hh):mcy + hh, max(0, mcx - hw):mcx + hw] = 1
        return m

    def to_crop(m):
        c = np.zeros((side, side), np.uint8)
        c[sy0 - oy:sy1 - oy, sx0 - ox:sx1 - ox] = m[sy0:sy1, sx0:sx1]
        return cv2.resize(c, (CROP, CROP), interpolation=cv2.INTER_NEAREST)

    made, failed = {}, {}
    new_layers = []
    for state in [s for s in args.only.split(',') if s in STATES]:
        kind, lname, prompt = STATES[state]
        reg = region(kind)
        if reg is None:
            failed[state] = 'no region'
            continue
        rc = to_crop(reg)
        rc_soft = cv2.dilate(rc, np.ones((9, 9), np.uint8))
        mask = np.zeros((CROP, CROP, 4), np.uint8)
        mask[..., 3] = np.where(rc_soft > 0, 0, 255)           # transparent = may change
        raw = os.path.join(args.reuse, state + '.png') if args.reuse else ''
        out = None
        for attempt in range(3):
            try:
                if attempt == 0 and raw and os.path.isfile(raw):
                    cand = np.asarray(Image.open(raw).convert('RGB'))
                else:
                    cand = over(edit(api_key(), Image.fromarray(crop_big), Image.fromarray(mask, 'RGBA'), prompt + STYLE), crop_big)
            except (RuntimeError, OSError, ValueError, KeyError) as err:
                failed[state] = str(err)[:200]
                break
            if cand.shape[:2] != (CROP, CROP):
                cand = cv2.resize(cand, (CROP, CROP), interpolation=cv2.INTER_CUBIC)
            # GPT sometimes paints a black censor bar over the eyes: reject that and draw again
            if censored(cand, crop_big, rc_soft):
                failed[state] = 'black block in the result (attempt %d)' % (attempt + 1)
                continue
            out = cand
            failed.pop(state, None)
            break
        if out is None:
            continue
        Image.fromarray(out).save(os.path.join(cache, state + '.png'))
        keep = cv2.dilate(rc, np.ones((61, 61), np.uint8)) == 0
        out, aligned = align(out, crop_big, keep)
        out = match_colors(out, crop_big, keep)
        old = to_crop((eyes if kind == 'eyes' else mouth).astype(np.uint8))
        hair_c = to_crop(hair.astype(np.uint8))
        # 1) no hair in the patch: the real front hair is drawn on top (and sways); under it, skin
        if hair_c.any():
            hm = cv2.dilate(hair_c, np.ones((5, 5), np.uint8)) * (rc_soft > 0)
            out = cv2.inpaint(out, hm.astype(np.uint8), 7, cv2.INPAINT_TELEA)
        # 2) only around the eyes / mouth themselves, not the whole editable box
        reach = max(9, int(np.sqrt(max(1, old.sum())) * (0.45 if kind == 'eyes' else 0.8)))
        zone = cv2.dilate(old, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * reach + 1, 2 * reach + 1))) * (rc_soft > 0)
        diff = np.abs(out.astype(np.int16) - crop_big.astype(np.int16)).mean(-1)
        changed = np.clip((diff - 14) / 18, 0, 1)
        changed[cv2.dilate(old, np.ones((9, 9), np.uint8)) > 0] = 1          # the old part must be covered
        changed = cv2.morphologyEx((changed > 0.35).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
        if kind == 'mouth':
            # a new mouth is often much bigger than the old one (a laughing D with teeth): take the whole
            # changed blob that touches the old mouth, inside the editable area
            blob = changed * (rc_soft > 0).astype(np.uint8)
            n, lab = cv2.connectedComponents(blob, connectivity=8)
            seed = cv2.dilate(old, np.ones((15, 15), np.uint8)) > 0
            keepl = [l for l in range(1, n) if (seed & (lab == l)).any()]
            zone = np.isin(lab, keepl).astype(np.uint8) if keepl else zone
            zone = cv2.dilate(zone, np.ones((7, 7), np.uint8))
        changed = cv2.dilate(changed, np.ones((5, 5), np.uint8)) * zone
        alpha = cv2.GaussianBlur(changed.astype(np.float32), (9, 9), 0)
        # back to canvas size / position
        small = cv2.resize(np.dstack([out, (alpha * 255).astype(np.uint8)]), (side, side), interpolation=cv2.INTER_AREA)
        canvas = np.zeros((H, W, 4), np.uint8)
        canvas[sy0:sy1, sx0:sx1] = small[sy0 - oy:sy1 - oy, sx0 - ox:sx1 - ox]
        b = bbox(canvas[..., 3] > 3)
        if not b:
            failed[state] = 'nothing changed'
            continue
        x0, y0, x1, y1 = b
        layer = {'name': lname, 'left': x0, 'top': y0, 'img': canvas[y0:y1, x0:x1].copy(), 'opacity': 255, 'kind': kind}
        new_layers += split_eyes(layer, eyes) if kind == 'eyes' else [layer]
        made[state] = {'layer': lname, 'aligned': aligned, 'box': [x0, y0, x1 - x0, y1 - y0]}

    if not new_layers:
        print(json.dumps({'made': made, 'failed': failed, 'written': False}, ensure_ascii=False))
        return 1 if failed else 0
    # order: eye states right after the last eye part, mouth states right after the mouth;
    # the original mouth becomes the closed mouth once there is an open one
    has_open_mouth = any(L['name'] == 'mouth_open' for L in new_layers)
    return write(args.out, W, H, layers, by, new_layers, has_open_mouth, made, failed)


def write(out_path, W, H, layers, by, new_layers, has_open_mouth, made, failed):
    out_layers = []
    last_eye = max([i for n in EYE_PARTS for i in by.get(n, [])] or [len(layers) - 1])
    last_mouth = max(by.get('mouth', []) or by.get('mouth open', []) or [last_eye])
    for i, L in enumerate(layers):
        if has_open_mouth and base(L['name']) in ('mouth', 'mouth open'):
            L = dict(L, name='mouth_close')
        out_layers.append(L)
        if i == last_mouth:
            out_layers += [N for N in new_layers if N['kind'] == 'mouth']
        if i == last_eye:
            out_layers += [N for N in new_layers if N['kind'] == 'eyes']
    new = PSDImage.new('RGBA', (W, H))
    for L in out_layers:
        nl = PixelLayer.frompil(Image.fromarray(L['img'], 'RGBA'), new, L['name'], L['top'], L['left'])
        nl.opacity = L['opacity']
        new.append(nl)
    new.save(out_path)
    print(json.dumps({'made': made, 'failed': failed, 'written': True}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
