"""
The OpenAI key and image-edit endpoint shared by py/gpt_image.py (pipeline pictures) and serve.py.
Standard library only.

The API key lives in <repo>/.local/openai.json on this PC only (git-ignored, never served);
the editor only ever sees its last four characters.
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY_FILE = os.path.join(ROOT, '.local', 'openai.json')
ENDPOINT = 'https://api.openai.com/v1/images/edits'
MODEL = 'gpt-image-2.5-sunburst'   # the API's current default (gpt-image-1 was shut down 2026-10-23)


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
