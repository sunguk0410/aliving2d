"""serve.py: local static server (editor + player demos)."""
import http.client
import socket
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from serve import Handler, ThreadingHTTPServer  # noqa: E402


class ServeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        conn.request(method, path, body, headers or {})
        response = conn.getresponse()
        code, data, head = response.status, response.read(), response.msg
        conn.close()
        return code, data, head

    def test_static_files(self):
        self.assertEqual(self.request('GET', '/')[0], 200)
        self.assertEqual(self.request('GET', '/lib/app.js')[0], 200)
        code, _, head = self.request('GET', '/lib/vendor/face_mesh/face_mesh_solution_simd_wasm_bin.wasm')
        self.assertEqual(code, 200)
        self.assertEqual(head['Content-Type'], 'application/wasm')
        code, _, head = self.request('GET', '/seethrough/see_through_colab.ipynb')
        self.assertEqual(code, 200)
        self.assertEqual(head['X-Content-Type-Options'], 'nosniff')

    def test_hidden_files_are_not_served(self):
        for path in ('/.git/config', '/serve.py', '/.gitignore', '/seethrough/server.py',
                     '/%2Egit/config', '/serve%2Epy', '/%2Egitignore', '/SERVE.PY'):
            self.assertEqual(self.request('GET', path)[0], 404, path)
            self.assertEqual(self.request('HEAD', path)[0], 404, path)

    def test_local_same_origin_only(self):
        self.assertEqual(self.request('GET', '/', headers={'Host': 'attacker.example'})[0], 403)
        self.assertEqual(self.request('GET', '/', headers={'Origin': 'https://example.com'})[0], 403)

    def test_read_only(self):
        for method in ('POST', 'PUT', 'DELETE'):
            self.assertEqual(self.request(method, '/index.html', b'x')[0], 405, method)

    def test_garbage_does_not_kill_the_server(self):
        with socket.create_connection(('127.0.0.1', self.server.server_port), timeout=3) as sock:
            sock.sendall(b'\x16\x03\x01 garbage\r\n\r\n')
            data = b''
            while len(data) < 65536:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
            self.assertIn(b'400', data)
        self.assertEqual(self.request('GET', '/')[0], 200, 'server still healthy')


if __name__ == '__main__':
    unittest.main()
