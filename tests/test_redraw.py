"""seethrough/redraw.py and its serve.py endpoints, with a fake OpenAI (no network, no key needed)."""
import base64
import http.client
import io
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'seethrough'))
import redraw  # noqa: E402
import serve  # noqa: E402

PNG = b'\x89PNG\r\n\x1a\n' + b'\0' * 32
OUT = b'\x89PNG\r\n\x1a\nredrawn'


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class RedrawTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = redraw.KEY_FILE
        redraw.KEY_FILE = os.path.join(self.tmp.name, '.local', 'openai.json')

    def tearDown(self):
        redraw.KEY_FILE = self.old
        self.tmp.cleanup()

    def test_key_is_stored_locally_and_only_a_hint_comes_back(self):
        self.assertEqual(redraw.key_info(), {'ready': False, 'hint': ''})
        self.assertRaises(ValueError, redraw.save_key, 'not a key')
        info = redraw.save_key('  sk-test-abcd1234  ')
        self.assertEqual(info, {'ready': True, 'hint': '…1234'})
        self.assertNotIn('sk-test', json.dumps(info))
        self.assertEqual(redraw.save_key(''), {'ready': False, 'hint': ''})

    def test_request_shape_and_result(self):
        redraw.save_key('sk-test-abcd1234')
        seen = {}

        def opener(req, timeout):
            seen['auth'] = req.get_header('Authorization')
            seen['body'] = json.loads(req.data)
            return FakeResponse(json.dumps({'data': [{'b64_json': base64.b64encode(OUT).decode()}]}).encode())
        self.assertEqual(redraw.redraw(PNG, opener=opener), OUT)
        b = seen['body']
        self.assertEqual(seen['auth'], 'Bearer sk-test-abcd1234')
        self.assertEqual((b['model'], b['size'], b['background']), (redraw.MODEL, '960x1280', 'opaque'))
        self.assertTrue(b['images'][0]['image_url'].startswith('data:image/png;base64,'))
        self.assertIn('both arms fully visible', b['prompt'])

    def test_errors_are_explained(self):
        self.assertRaisesRegex(RuntimeError, 'PNG', redraw.redraw, b'GIF89a')
        self.assertRaisesRegex(RuntimeError, '키', redraw.redraw, PNG)
        redraw.save_key('sk-test-abcd1234')

        def denied(req, timeout):
            raise urllib.error.HTTPError(req.full_url, 401, 'no', {}, io.BytesIO(b'{"error":{"message":"bad key"}}'))
        self.assertRaisesRegex(RuntimeError, '키가 맞지 않습니다.*bad key', redraw.redraw, PNG, denied)


class RedrawEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.old = redraw.KEY_FILE
        redraw.KEY_FILE = os.path.join(cls.tmp.name, '.local', 'openai.json')
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), serve.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        redraw.KEY_FILE = cls.old
        cls.tmp.cleanup()

    def call(self, method, path, body=b'', origin=True):
        h = {'Host': f'127.0.0.1:{self.port}', 'Content-Length': str(len(body))}
        if origin:
            h['Origin'] = f'http://127.0.0.1:{self.port}'
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        c.request(method, path, body=body, headers=h)
        r = c.getresponse()
        out = r.status, r.read()
        c.close()
        return out

    def test_key_endpoint_and_config(self):
        self.assertEqual(self.call('POST', '/api/redraw/key', b'{"key":"sk-x-9999"}', origin=False)[0], 405)
        code, body = self.call('POST', '/api/redraw/key', b'{"key":"sk-x-9999"}')
        self.assertEqual((code, json.loads(body)['hint']), (200, '…9999'))
        code, body = self.call('GET', '/local-config.json')
        self.assertEqual(json.loads(body)['redraw'], {'ready': True, 'hint': '…9999'})
        self.assertEqual(self.call('POST', '/api/redraw/key', b'{"key":"oops"}')[0], 400)
        self.assertEqual(self.call('GET', '/.local/openai.json')[0], 404, 'the key file is never served')

    def test_redraw_endpoint_reports_errors(self):
        redraw.save_key('')
        code, body = self.call('POST', '/api/redraw', PNG)
        self.assertEqual(code, 502)
        self.assertIn('키', json.loads(body)['error'])


if __name__ == '__main__':
    unittest.main()


class ExpressionArtEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), serve.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def post(self, body, origin=True):
        h = {'Host': f'127.0.0.1:{self.port}', 'Content-Length': str(len(body))}
        if origin:
            h['Origin'] = f'http://127.0.0.1:{self.port}'
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        c.request('POST', '/api/expression-art', body=body, headers=h)
        r = c.getresponse()
        out = r.status, r.read()
        c.close()
        return out

    def test_only_psds_from_the_editor(self):
        self.assertEqual(self.post(b'8BPS....', origin=False)[0], 405)
        code, body = self.post(b'not a psd')
        self.assertEqual(code, 400)
        self.assertIn('PSD', json.loads(body)['error'])


class ExpressionArtHelperTests(unittest.TestCase):
    def test_split_eyes_cuts_between_the_eyes(self):
        sys.path.insert(0, str(ROOT / 'seethrough'))
        try:
            import numpy as np
            import expression_art as ea
        except ImportError:
            self.skipTest('see-through Python packages (cv2, psd_tools) are not installed here')
        eyes = np.zeros((50, 100), bool)
        eyes[20:30, 10:30] = True
        eyes[20:30, 70:90] = True
        img = np.zeros((20, 90, 4), np.uint8)
        img[..., 3] = 255   # one patch over both eyes and the bridge between them
        parts = ea.split_eyes({'name': 'eye_close', 'left': 5, 'top': 15, 'img': img, 'opacity': 255, 'kind': 'eyes'}, eyes)
        self.assertEqual([p['name'] for p in parts], ['eye_close-l', 'eye_close-r'])
        self.assertEqual(parts[0]['left'] + parts[0]['img'].shape[1], 50)
        self.assertEqual(parts[1]['left'], 50)
