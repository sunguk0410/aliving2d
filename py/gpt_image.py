"""
OpenAI image edit with any prompt (same key / model as seethrough/redraw.py).

  python py/gpt_image.py <in.png> <out.png> --prompt-file p.txt [--size 1024x1024] [--n 1]
"""
import argparse
import base64
import io
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'seethrough'))
import redraw  # noqa: E402


def edit(image_bytes, prompt, size='1024x1024', n=1, quality='high', deadline=300, tries=3):
    """Image edit with a hard time limit per attempt (a stalled connection can trickle forever under urllib's
    per-read timeout) and a few retries."""
    import threading
    last = None
    for attempt in range(tries):
        box = {}

        def call():
            try:
                box['out'] = _edit_once(image_bytes, prompt, size, n, quality)
            except Exception as err:  # noqa: BLE001
                box['err'] = err
        t = threading.Thread(target=call, daemon=True)
        t.start()
        t.join(deadline)
        if 'out' in box:
            return box['out']
        last = box.get('err') or TimeoutError(f'OpenAI가 {deadline // 60}분 안에 답하지 않았습니다')
        msg = str(last)
        if 'HTTP 400' in msg or 'HTTP 401' in msg:      # a refused prompt / a bad key: retrying will not help
            break
        print(f'GPT attempt {attempt + 1} failed: {msg[:200]}', file=sys.stderr, flush=True)
    raise RuntimeError(str(last))


def _edit_once(image_bytes, prompt, size, n, quality):
    key = redraw._key()
    mime = redraw.mime_of(image_bytes)
    body = json.dumps({
        'model': redraw.MODEL, 'prompt': prompt, 'size': size, 'quality': quality, 'background': 'opaque',
        'output_format': 'png', 'n': n,
        'images': [{'image_url': 'data:%s;base64,%s' % (mime, base64.b64encode(image_bytes).decode('ascii'))}],
    }).encode('utf-8')
    req = urllib.request.Request(redraw.ENDPOINT, data=body, method='POST',
                                 headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as err:
        raise RuntimeError(f'HTTP {err.code}: {err.read()[:400]!r}')
    return [base64.b64decode(d['b64_json']) for d in data['data']]


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--prompt-file', required=True)
    ap.add_argument('--size', default='1024x1024')
    ap.add_argument('--n', type=int, default=1)
    a = ap.parse_args()
    from PIL import Image
    im = Image.open(a.src).convert('RGB')
    buf = io.BytesIO()
    im.save(buf, 'PNG')
    outs = edit(buf.getvalue(), open(a.prompt_file, encoding='utf-8').read(), a.size, a.n)
    root, ext = os.path.splitext(a.dst)
    for i, b in enumerate(outs):
        p = a.dst if len(outs) == 1 else f'{root}_{i}{ext}'
        open(p, 'wb').write(b)
        print(p)
