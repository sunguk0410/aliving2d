"""serve.py: local static server (editor + player demos)."""
import http.client
import json
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
        code, _, head = self.request('GET', '/')
        self.assertEqual(code, 302)
        self.assertEqual(head['Location'], '/studio/')
        self.assertEqual(self.request('GET', '/viewer/index.html')[0], 200)
        self.assertEqual(self.request('GET', '/studio/index.html')[0], 200)
        code, data, _ = self.request('GET', '/api/v2/jobs')
        self.assertEqual(code, 200)
        self.assertIn('jobs', json.loads(data))
        self.assertEqual(self.request('GET', '/engine/engine.js')[0], 200)
        code, _, head = self.request('GET', '/lib/vendor/face_mesh/face_mesh_solution_simd_wasm_bin.wasm')
        self.assertEqual(code, 200)
        self.assertEqual(head['Content-Type'], 'application/wasm')
        self.assertEqual(head['X-Content-Type-Options'], 'nosniff')

    def test_job_options(self):
        import tempfile
        from unittest import mock
        import serve
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(serve, 'WORK', Path(tmp)):
            d = Path(tmp) / '1116-000000-abcd'
            d.mkdir()
            (d / 'status.json').write_text(json.dumps({'id': d.name, 'state': 'done', 'steps': {}}), encoding='utf-8')
            origin = {'Origin': f'http://127.0.0.1:{self.server.server_port}', 'Content-Type': 'application/json'}
            code, data, _ = self.request('POST', f'/api/v2/jobs/{d.name}/options', b'{"ears": false, "x": 1}', origin)
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(data)['options'], {'ears': False})
            jobs = json.loads(self.request('GET', '/api/v2/jobs')[1])['jobs']
            self.assertEqual(jobs[0]['options'], {'ears': False})
            code, data, _ = self.request('POST', f'/api/v2/jobs/{d.name}/options', b'{"ears": null}', origin)
            self.assertEqual(json.loads(data)['options'], {})
            code, _, _ = self.request('POST', '/api/v2/jobs/nope-job/options', b'{}', origin)
            self.assertEqual(code, 404)

    def test_job_extras_option(self):
        import tempfile
        from unittest import mock
        import serve
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(serve, 'WORK', Path(tmp)):
            d = Path(tmp) / '1116-000000-abcd'
            d.mkdir()
            (d / 'status.json').write_text(json.dumps({'id': d.name, 'state': 'done', 'steps': {}}), encoding='utf-8')
            origin = {'Origin': f'http://127.0.0.1:{self.server.server_port}', 'Content-Type': 'application/json'}
            code, data, _ = self.request('POST', f'/api/v2/jobs/{d.name}/options', b'{"extras": ["arms", "nope", "fx"]}', origin)
            self.assertEqual(json.loads(data)['options'], {'extras': ['arms', 'fx']})
            code, data, _ = self.request('POST', f'/api/v2/jobs/{d.name}/options', '{"name": "  은발  정장 "}'.encode(), origin)
            self.assertEqual(json.loads(data)['options']['name'], '은발 정장')
            jobs = json.loads(self.request('GET', '/api/v2/jobs')[1])['jobs']
            self.assertEqual(jobs[0]['name'], '은발 정장')

    def test_save_expression(self):
        import tempfile
        from unittest import mock
        import serve
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(serve, 'ROOT', tmp):
            b = Path(tmp) / 'bundles' / 'm1'
            b.mkdir(parents=True)
            (b / 'model.json').write_text(json.dumps({'params': [{'id': 'eyeSmile'}], 'expressions': []}), encoding='utf-8')
            origin = {'Origin': f'http://127.0.0.1:{self.server.server_port}', 'Content-Type': 'application/json'}
            body = json.dumps({'name': 'smile', 'label': '웃음', 'params': {'eyeSmile': 0.8, 'other': 1},
                               'model': '../bundles/m1/model.json'}).encode()
            code, data, _ = self.request('POST', '/api/v2/expressions', body, origin)
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(data)['expressions']['smile']['params'], {'eyeSmile': 0.8, 'other': 1.0})
            m = json.loads((b / 'model.json').read_text(encoding='utf-8'))
            self.assertEqual(m['expressions'][0]['params'], {'eyeSmile': 0.8})
            self.assertTrue((b / 'expressions' / 'smile.exp3.json').is_file())
            code, _, _ = self.request('POST', '/api/v2/expressions', b'{"name": "../x", "params": {"a": 1}}', origin)
            self.assertEqual(code, 400)
            code, _, _ = self.request('POST', '/api/v2/expressions', json.dumps(
                {'name': 'smile', 'delete': True, 'model': '../bundles/m1/model.json'}).encode(), origin)
            m = json.loads((b / 'model.json').read_text(encoding='utf-8'))
            self.assertEqual(m['expressions'], [])

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
        self.assertEqual(self.request('GET', '/viewer/index.html')[0], 200, 'server still healthy')


if __name__ == '__main__':
    unittest.main()
