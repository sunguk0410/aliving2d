"""seethrough/server.py in fake mode: HTTP API, auth, jobs, downloads (no GPU needed)."""
import argparse
import http.client
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'seethrough'))
import server as st  # noqa: E402

PNG = b'\x89PNG\r\n\x1a\n' + b'\0' * 64
FAKE_PSD = b'8BPS' + b'\0' * 100


class SeeThroughServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        psd = os.path.join(cls.tmp.name, 'fake.psd')
        with open(psd, 'wb') as f:
            f.write(FAKE_PSD)
        args = argparse.Namespace(repo=cls.tmp.name, mode='fake', resolution=0, python=sys.executable,
                                  workdir=os.path.join(cls.tmp.name, 'jobs'), fake_psd=psd, fake_seconds=0.3, verbose=False)
        cls.conv = st.Converter(args)
        cls.token = 'secret-token'
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), st.make_handler(cls.conv, cls.token))
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, body=None, headers=None, token=True):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        h = dict(headers or {})
        if token:
            h['X-Token'] = self.token
        c.request(method, path, body=body, headers=h)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, dict(r.getheaders()), data

    def wait(self, job_id, until=('done', 'error'), timeout=10):
        end = time.time() + timeout
        while time.time() < end:
            _, _, d = self.request('GET', '/jobs/' + job_id)
            j = json.loads(d)
            if j['status'] in until:
                return j
            time.sleep(0.05)
        self.fail('job did not finish')

    def test_health_and_auth(self):
        code, headers, d = self.request('GET', '/health')
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(d)['mode'], 'fake')
        self.assertEqual(headers.get('Access-Control-Allow-Origin'), '*')
        self.assertEqual(self.request('GET', '/health', token=False)[0], 401)
        self.assertEqual(self.request('GET', '/health', headers={'X-Token': 'wrong'}, token=False)[0], 401)

    def test_cors_preflight_needs_no_token(self):
        code, headers, _ = self.request('OPTIONS', '/jobs', token=False)
        self.assertEqual(code, 204)
        self.assertIn('X-Token', headers.get('Access-Control-Allow-Headers', ''))

    def test_convert_image_to_psd(self):
        code, _, d = self.request('POST', '/jobs', PNG, {'X-Filename': '../../evil name.png', 'Content-Type': 'image/png'})
        self.assertEqual(code, 202)
        job_id = json.loads(d)['id']
        self.assertEqual(self.request('GET', '/jobs/' + job_id + '/psd')[0], 409, 'no PSD before the job is done')
        j = self.wait(job_id)
        self.assertEqual(j['status'], 'done', j)
        self.assertEqual(j['percent'], 100)
        self.assertEqual(j['name'], 'evil_name')
        code, headers, psd = self.request('GET', '/jobs/' + job_id + '/psd')
        self.assertEqual(code, 200)
        self.assertEqual(psd, FAKE_PSD)
        self.assertIn('evil_name.psd', headers.get('Content-Disposition', ''))
        self.assertEqual(self.request('GET', '/jobs/' + job_id + '/depth')[0], 409, 'fake mode has no depth PSD')

    def test_rejects_non_images_and_bad_paths(self):
        self.assertEqual(self.request('POST', '/jobs', b'8BPS not an image')[0], 400)
        self.assertEqual(self.request('POST', '/jobs', b'')[0], 413)
        self.assertEqual(self.request('GET', '/jobs/../../etc/passwd')[0], 404)
        self.assertEqual(self.request('GET', '/jobs/0123456789ab')[0], 404)

    def test_cancel(self):
        code, _, d = self.request('POST', '/jobs', PNG)
        job_id = json.loads(d)['id']
        self.assertEqual(self.request('DELETE', '/jobs/' + job_id)[0], 200)
        j = self.wait(job_id)
        self.assertEqual(j['status'], 'error')
        self.assertEqual(j['error'], '취소됨')

    def test_mode_choice(self):
        self.assertEqual(st.pick_mode('auto', {'name': 'T4', 'vram_mb': 15360, 'cc': 7.5}), 'nf4')
        self.assertEqual(st.pick_mode('auto', {'name': 'L4', 'vram_mb': 23034, 'cc': 8.9}), 'full')
        self.assertEqual(st.pick_mode('auto', {'name': '4070', 'vram_mb': 12282, 'cc': 8.9}), 'offload')
        self.assertEqual(st.pick_mode('auto', {'name': '3060ti', 'vram_mb': 8192, 'cc': 8.6}), 'nf4')
        self.assertEqual(st.pick_mode('full', None), 'full')

    def test_command_line(self):
        conv = st.Converter.__new__(st.Converter)
        conv.args = argparse.Namespace(python='py', repo='/r', resolution=1024)
        job = argparse.Namespace(input='/j/a.png')
        conv.mode = 'nf4'
        self.assertEqual(conv.command(job, '/j/out'), ['py', os.path.join('/r', 'inference/scripts/inference_psd_quantized.py'),
                                                       '--srcp', '/j/a.png', '--save_dir', '/j/out', '--save_to_psd', '--resolution', '1024'])
        conv.mode = 'offload'
        self.assertIn('--group_offload', conv.command(job, '/j/out'))


if __name__ == '__main__':
    unittest.main()
