"""GPU-desktop path: origin-limited tokenless server, editor auto-detection (serve.py), desktop.py helpers."""
import argparse
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
import desktop  # noqa: E402
import serve  # noqa: E402
import server as st  # noqa: E402

EDITOR = 'http://127.0.0.1:8000'


def get(port, path, headers=None, method='GET'):
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    c.request(method, path, headers=headers or {})
    r = c.getresponse()
    out = r.status, dict(r.getheaders()), r.read()
    c.close()
    return out


class DesktopServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        args = argparse.Namespace(repo=cls.tmp.name, mode='fake', resolution=0, python=sys.executable,
                                  workdir=os.path.join(cls.tmp.name, 'jobs'), fake_psd=None, fake_seconds=0.1, verbose=False)
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), st.make_handler(st.Converter(args), '', desktop.EDITOR_ORIGINS))
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.editor = ThreadingHTTPServer(('127.0.0.1', 0), serve.Handler)
        threading.Thread(target=cls.editor.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        for s in (cls.httpd, cls.editor):
            s.shutdown()
            s.server_close()
        cls.tmp.cleanup()

    def test_only_the_local_editor_may_call_a_tokenless_server(self):
        code, head, _ = get(self.port, '/health', {'Origin': EDITOR})
        self.assertEqual(code, 200)
        self.assertEqual(head.get('Access-Control-Allow-Origin'), EDITOR)
        code, head, body = get(self.port, '/health', {'Origin': 'https://evil.example'})
        self.assertEqual(code, 403)
        self.assertNotIn('Access-Control-Allow-Origin', head)
        self.assertEqual(get(self.port, '/jobs', {'Origin': 'https://evil.example'}, method='OPTIONS')[0], 403)
        self.assertEqual(get(self.port, '/health')[0], 200, 'non-browser clients (no Origin) still work')

    def test_editor_finds_the_server_through_serve_py(self):
        old = serve.SEETHROUGH_PORT
        try:
            serve.SEETHROUGH_PORT = self.port
            code, _, body = get(self.editor.server_address[1], '/local-config.json', {'Host': f'127.0.0.1:{self.editor.server_address[1]}'})
            self.assertEqual(code, 200)
            found = json.loads(body)['seethrough']
            self.assertEqual(found['url'], f'http://127.0.0.1:{self.port}')
            self.assertEqual(found['mode'], 'fake')
            serve.SEETHROUGH_PORT = 1   # nothing listens there
            code, _, body = get(self.editor.server_address[1], '/local-config.json', {'Host': f'127.0.0.1:{self.editor.server_address[1]}'})
            cfg = json.loads(body)
            self.assertEqual((cfg['seethrough'], cfg['setup']), (None, None))
            self.assertIn('ready', cfg['redraw'])
        finally:
            serve.SEETHROUGH_PORT = old


class DesktopHelperTests(unittest.TestCase):
    def test_requirements_filter_drops_gui_training_and_dev_packages(self):
        text = '-e ./common\nnumpy==2.2.6\nPyQt6==6.9.1\nlpips==0.1.4\nconvnext_perceptual_loss @ git+https://x\ntimm @ git+https://y\n# PyQt6 comment\npytest==8.4.1\n'
        out = desktop.filtered_requirements(text)
        self.assertIn('-e ./common', out)
        self.assertIn('numpy==2.2.6', out)
        self.assertIn('timm @ git+https://y', out)
        for name in ('PyQt6==', 'lpips', 'convnext_perceptual_loss', 'pytest'):
            self.assertNotIn(name, out)

    def test_venv_python_path(self):
        p = desktop.venv_python()
        self.assertTrue(p.startswith(desktop.VENV))
        self.assertTrue(p.endswith('python.exe' if os.name == 'nt' else 'python'))


if __name__ == '__main__':
    unittest.main()


class FakeDesktop:
    REPO, WORKDIR = 'repo', 'jobs'

    def __init__(self, gpu, installed):
        self._gpu, self._installed = gpu, installed

    def gpu(self):
        return self._gpu

    def status(self):
        return {'installed': self._installed}

    def venv_python(self):
        return sys.executable


class ManagerTests(unittest.TestCase):
    def make(self, gpu, installed):
        import manager
        m = manager.Manager(8000, port=1, start=False)
        m._desktop = lambda: FakeDesktop(gpu, installed)
        m._start_server = lambda: m._set('ready')
        return m

    def test_no_gpu_offers_nothing(self):
        m = self.make(None, False)
        m._boot()
        self.assertEqual(m.info()['state'], 'no-gpu')
        self.assertFalse(m.install())

    def test_installed_starts_the_server_by_itself(self):
        m = self.make({'name': 'RTX', 'vram_mb': 8000, 'cc': 8.9}, True)
        m._boot()
        self.assertEqual(m.info()['state'], 'ready')

    def test_not_installed_waits_for_the_button(self):
        m = self.make({'name': 'RTX', 'vram_mb': 8000, 'cc': 8.9}, False)
        m._boot()
        self.assertEqual(m.info()['state'], 'not-installed')
        m._install = lambda: None   # do not really install in tests
        self.assertTrue(m.install())
        self.assertEqual(m.info()['state'], 'installing')
        self.assertFalse(m.install(), 'a second click does not start a second install')


class InstallEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), serve.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.calls = []

        class Stub:
            def install(stub):
                cls.calls.append(1)
                return True

            def info(stub):
                return {'state': 'installing', 'message': '', 'gpu': None}
        cls.httpd.seethrough = Stub()
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def post(self, path, origin):
        h = {'Host': f'127.0.0.1:{self.port}', 'Content-Length': '0'}
        if origin:
            h['Origin'] = origin
        return get(self.port, path, h, method='POST')

    def test_only_the_editor_page_can_start_an_install(self):
        self.assertEqual(self.post('/api/seethrough/install', None)[0], 405, 'no Origin (not a page fetch)')
        self.assertEqual(self.post('/api/seethrough/install', 'https://evil.example')[0], 403)
        self.assertEqual(self.post('/other', f'http://127.0.0.1:{self.port}')[0], 405)
        self.assertEqual(self.calls, [])
        code, _, body = self.post('/api/seethrough/install', f'http://127.0.0.1:{self.port}')
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)['setup']['state'], 'installing')
        self.assertEqual(self.calls, [1])

    def test_local_config_reports_the_setup_state(self):
        code, _, body = get(self.port, '/local-config.json', {'Host': f'127.0.0.1:{self.port}'})
        self.assertEqual(json.loads(body)['setup']['state'], 'installing')


class ResolutionTests(unittest.TestCase):
    def test_per_job_resolution(self):
        args = argparse.Namespace(repo='r', mode='nf4', resolution=0, python='py', workdir=tempfile.mkdtemp(), fake_psd=None, fake_seconds=0, verbose=False)
        conv = st.Converter.__new__(st.Converter)
        conv.args, conv.mode = args, 'nf4'
        job = st.Job('x', args.workdir)
        job.input = 'in.png'
        job.resolution = None
        self.assertNotIn('--resolution', conv.command(job, 'out'))
        job.resolution = 1024
        cmd = conv.command(job, 'out')
        self.assertEqual(cmd[cmd.index('--resolution') + 1], '1024')
        conv.mode = 'blockswap'
        self.assertTrue(conv.command(job, 'out')[1].endswith('inference_psd_blockswap.py'))
