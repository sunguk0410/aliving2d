"""
AI redraw before conversion (OpenAI image edits): the same character, standing upright,
facing forward, both arms visible, on white. Standard library only (used by serve.py).

The API key lives in <repo>/.local/openai.json on this PC only (git-ignored, never served);
the editor only ever sees its last four characters.
"""
import base64
import json
import os
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY_FILE = os.path.join(ROOT, '.local', 'openai.json')
ENDPOINT = 'https://api.openai.com/v1/images/edits'
MODEL = 'gpt-image-2.5-sunburst'   # the API's current default (gpt-image-1 was shut down 2026-10-23)
SIZE = '960x1280'                    # 3:4 portrait like see-through's examples; both divisible by 16
MAX_IMAGE = 20 * 1024 * 1024

PROMPT = (
    'Redraw this exact same character as a clean character reference illustration.\n'
    'Keep EVERYTHING about the character identical: art style, line art, shading and coloring style, '
    'face, eye shape and eye color, expression style, hairstyle, hair length and hair color, outfit, accessories and colors.\n'
    'Change only the pose and framing:\n'
    '- standing upright, body and face toward the viewer, head straight (not tilted)\n'
    '- both arms fully visible, relaxed and slightly away from the body, both hands visible and not hidden\n'
    '- hair falls behind the shoulders or beside the body, not covering the arms or the chest much\n'
    '- show the character from the head to the thighs, centered, with a little margin around\n'
    '- exactly one character, plain pure white background, no desk, no props, no text, no other people\n'
)


def key_info():
    try:
        with open(KEY_FILE, encoding='utf-8') as f:
            key = json.load(f).get('key', '')
    except (OSError, ValueError):
        key = ''
    return {'ready': bool(key), 'hint': ('…' + key[-4:]) if key else ''}


def _key():
    with open(KEY_FILE, encoding='utf-8') as f:
        return json.load(f)['key']


def save_key(key):
    key = (key or '').strip()
    if not key:
        try:
            os.remove(KEY_FILE)
        except OSError:
            pass
        return key_info()
    if not key.startswith('sk-') or len(key) > 300 or any(c.isspace() for c in key):
        raise ValueError('OpenAI API 키 형식이 아닙니다 (sk-로 시작)')
    os.makedirs(os.path.dirname(KEY_FILE), exist_ok=True)
    with open(KEY_FILE, 'w', encoding='utf-8') as f:
        json.dump({'key': key}, f)
    return key_info()


def mime_of(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if data.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'image/webp'
    return None


def redraw(image, opener=urllib.request.urlopen):
    """Picture bytes -> redrawn PNG bytes. Raises RuntimeError with a Korean message."""
    mime = mime_of(image)
    if not mime:
        raise RuntimeError('PNG / JPG / WEBP 그림만 다시 그릴 수 있습니다')
    if len(image) > MAX_IMAGE:
        raise RuntimeError('그림이 너무 큽니다 (20MB 이하)')
    try:
        key = _key()
    except (OSError, ValueError, KeyError):
        raise RuntimeError('OpenAI API 키를 먼저 넣어 주세요')
    body = json.dumps({
        'model': MODEL, 'prompt': PROMPT, 'size': SIZE, 'quality': 'high', 'background': 'opaque', 'output_format': 'png', 'n': 1,
        'images': [{'image_url': 'data:%s;base64,%s' % (mime, base64.b64encode(image).decode('ascii'))}],
    }).encode('utf-8')
    req = urllib.request.Request(ENDPOINT, data=body, method='POST',
                                 headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    try:
        with opener(req, timeout=300) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as err:
        try:
            msg = json.loads(err.read()).get('error', {}).get('message', '')
        except (ValueError, AttributeError):
            msg = ''
        hint = {401: 'API 키가 맞지 않습니다', 429: '요청 한도나 잔액을 확인해 주세요', 400: '요청이 거절됐습니다'}.get(err.code, 'OpenAI 오류')
        raise RuntimeError(f'{hint} (HTTP {err.code}) {msg[:200]}'.strip())
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        raise RuntimeError('OpenAI에 연결하지 못했습니다: ' + str(err)[:160])
    try:
        return base64.b64decode(data['data'][0]['b64_json'])
    except (KeyError, IndexError, TypeError, ValueError):
        raise RuntimeError('OpenAI 응답에 그림이 없습니다')
