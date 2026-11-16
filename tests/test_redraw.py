"""seethrough/redraw.py (the OpenAI key) and its serve.py endpoint (no network, no key needed)."""
import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'seethrough'))
import redraw  # noqa: E402
import serve  # noqa: E402

PNG = b'\x89PNG\r\n\x1a\n' + b'\0' * 32
OUT = b'\x89PNG\r\n\x1a\nredrawn'


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


if __name__ == '__main__':
    unittest.main()
