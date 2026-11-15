"""Local static server for Capsule Model Studio (npm start).

Serves the v2 model viewer (/ -> /v2/viewer/) from this folder to this PC only:
requests must come from localhost with a matching Host/Origin, dot-files and
Python/batch sources are never served, and only GET/HEAD are allowed (plus one
same-origin POST that installs see-through, below).

see-through (picture -> parts PSD) comes along: on a PC with an NVIDIA GPU the
conversion server is started in the background once it is installed, and the
editor can install it with a button (seethrough/manager.py). --no-seethrough
turns that off.
"""
import argparse
import json
import mimetypes
import os
import subprocess
import sys
import tempfile
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = str(Path(__file__).resolve().parent)
sys.path.insert(0, str(Path(ROOT) / 'seethrough'))
import manager as seethrough  # noqa: E402  (standard library only)
import redraw  # noqa: E402  (OpenAI pose fix before conversion, standard library only)

SEETHROUGH_PORT = seethrough.DEFAULT_PORT


def local_seethrough(port=None):
    """{url, mode, gpu, busy} of a tokenless see-through server on this PC, or None."""
    return seethrough.probe(port or SEETHROUGH_PORT)

for ext, mime in {'.wasm': 'application/wasm', '.data': 'application/octet-stream',
                  '.binarypb': 'application/octet-stream', '.psd': 'application/octet-stream',
                  '.ipynb': 'application/x-ipynb+json', '.json': 'application/json',
                  '.md': 'text/markdown; charset=utf-8', '.js': 'text/javascript'}.items():
    mimetypes.add_type(mime, ext)


class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def same_origin(self):
        host = self.headers.get('Host', '')
        allowed = {f'{name}:{self.server.server_port}' for name in ('localhost', '127.0.0.1', '[::1]')}
        origin = self.headers.get('Origin')
        if host not in allowed or (origin and origin != 'http://' + host):
            self.send_error(403, 'Local same-origin requests only')
            return False
        return True

    def hidden_path(self):
        path = unquote(urlsplit(self.path).path).replace('\\', '/')
        parts = path.split('/')
        return any(p.startswith('.') and p not in ('', '.') for p in parts) or \
            path.lower().rstrip('/').endswith(('.py', '.pyc', '.bat'))

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def do_GET(self):
        if not self.same_origin():
            return
        if urlsplit(self.path).path == '/':
            self.send_response(302)
            self.send_header('Location', '/v2/viewer/')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if urlsplit(self.path).path == '/local-config.json':
            # Probed here (not from the page) so the editor never logs a failed connection.
            return self._json({'seethrough': local_seethrough(), 'setup': self._manager_info(), 'redraw': redraw.key_info()})
        if self.hidden_path():
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        if not self.same_origin():
            return
        if self.hidden_path():
            self.send_error(404)
            return
        super().do_HEAD()

    def _not_allowed(self):
        # Drain a small body first: answering before reading it makes Windows reset the connection.
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            size = 0
        if 0 < size <= 1 << 20:
            self.rfile.read(size)
        self.close_connection = True
        self.send_error(405)

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _manager_info(self):
        m = getattr(self.server, 'seethrough', None)
        return m.info() if m else None

    def _body(self, limit):
        try:
            n = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            n = -1
        if n < 0 or n > limit:
            return None
        return self.rfile.read(n) if n else b''

    def do_POST(self):
        # Writes from the editor page only: 「설치하기」, the OpenAI key, 「AI로 자세 바로잡기」.
        # Browsers always send Origin on fetch POST, so requiring it (and same_origin) keeps other pages out.
        path = urlsplit(self.path).path
        if path not in ('/api/seethrough/install', '/api/redraw', '/api/redraw/key', '/api/expression-art', '/api/pose-image', '/api/pose-merge')                 or not self.headers.get('Origin'):
            return self._not_allowed()
        if not self.same_origin():
            return
        if path == '/api/seethrough/install':
            m = getattr(self.server, 'seethrough', None)
            started = bool(m and m.install())
            return self._json({'started': started, 'setup': self._manager_info()}, 200 if started else 409)
        if path == '/api/redraw/key':
            body = self._body(4096)
            try:
                info = redraw.save_key(json.loads(body or b'{}').get('key', ''))
            except (ValueError, AttributeError) as err:
                return self._json({'error': str(err)}, 400)
            return self._json(info)
        if path == '/api/expression-art':
            return self._expression_art()
        if path in ('/api/pose-image', '/api/pose-merge'):
            return self._pose(path)
        body = self._body(redraw.MAX_IMAGE)
        if not body:
            self.close_connection = True
            return self._json({'error': '그림은 20MB 이하로 보내 주세요'}, 413)
        try:
            png = redraw.redraw(body)
        except RuntimeError as err:
            return self._json({'error': str(err)}, 502)
        self.send_response(200)
        self.send_header('Content-Type', 'image/png')
        self.send_header('Content-Length', str(len(png)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(png)

    def _venv_tool(self, args, files, out_name, timeout=1800):
        """Run a seethrough/*.py tool in the see-through Python with the OpenAI key; returns (info, bytes|None)."""
        try:
            key = redraw._key()
        except (OSError, ValueError, KeyError):
            return {'error': 'OpenAI API 키를 먼저 넣어 주세요'}, None
        sys.path.insert(0, str(Path(ROOT) / 'seethrough'))
        import desktop  # noqa: E402
        py = desktop.venv_python()
        if not os.path.isfile(py):
            return {'error': '그림 도구(see-through)가 설치되어 있지 않습니다. 시작 화면의 「설치하기」를 먼저 해 주세요'}, None
        with tempfile.TemporaryDirectory() as tmp:
            paths = {}
            for name, data in files.items():
                paths[name] = os.path.join(tmp, name)
                with open(paths[name], 'wb') as f:
                    f.write(data)
            out = os.path.join(tmp, out_name)
            cmd = [py] + [paths.get(a, out if a == out_name else a) for a in args]
            env = dict(os.environ, OPENAI_API_KEY=key, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
            try:
                r = subprocess.run(cmd, capture_output=True, env=env, timeout=timeout)
            except subprocess.TimeoutExpired:
                return {'error': '시간이 너무 오래 걸려 멈췄습니다'}, None
            lines = r.stdout.decode('utf-8', 'replace').strip().splitlines()
            try:
                info = json.loads(lines[-1])
            except (ValueError, IndexError):
                return {'error': (r.stderr.decode('utf-8', 'replace').strip().splitlines() or ['알 수 없는 오류'])[-1][-200:]}, None
            if not info.get('written') or not os.path.isfile(out):
                return info, None
            with open(out, 'rb') as f:
                return info, f.read()

    def _send_bytes(self, data, info, ctype='application/octet-stream'):
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Tool-Info', json.dumps(info, ensure_ascii=True)[:4000])
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def _pose(self, path):
        """pose-image: PSD -> picture of the character in that pose (GPT). pose-merge: base PSD + converted
        pose PSD (X-Base-Length = size of the base part of the body) -> base PSD with the pose's arms / props."""
        pose = urlsplit(self.path).query.partition('pose=')[2].split('&')[0]
        if pose not in ('typing', 'writing', 'wave'):
            return self._json({'error': '자세 이름이 올바르지 않습니다'}, 400)
        body = self._body(256 * 1024 * 1024)
        if not body:
            self.close_connection = True
            return self._json({'error': 'PSD를 보내 주세요'}, 400)
        tool = os.path.join(ROOT, 'seethrough', 'pose_art.py')
        if path == '/api/pose-image':
            if body[:4] != b'8BPS':
                return self._json({'error': 'PSD를 보내 주세요'}, 400)
            info, data = self._venv_tool([tool, 'image', 'base.psd', 'out.png', '--pose', pose], {'base.psd': body}, 'out.png', 600)
            return self._send_bytes(data, info, 'image/png') if data else self._json(info, 502)
        try:
            n = int(self.headers.get('X-Base-Length', '0'))
        except ValueError:
            n = 0
        base_psd, var_psd = body[:n], body[n:]
        if base_psd[:4] != b'8BPS' or var_psd[:4] != b'8BPS':
            return self._json({'error': 'PSD 두 개를 보내 주세요'}, 400)
        info, data = self._venv_tool([tool, 'merge', 'base.psd', 'var.psd', 'out.psd', '--pose', pose], {'base.psd': base_psd, 'var.psd': var_psd}, 'out.psd', 600)
        return self._send_bytes(data, info) if data else self._json(info, 502)

    def _expression_art(self):
        """PSD -> PSD with drawn eye / mouth states (seethrough/expression_art.py in the see-through Python)."""
        body = self._body(128 * 1024 * 1024)
        if not body or body[:4] != b'8BPS':
            self.close_connection = True
            return self._json({'error': 'PSD를 보내 주세요'}, 400)
        try:
            key = redraw._key()
        except (OSError, ValueError, KeyError):
            return self._json({'error': 'OpenAI API 키를 먼저 넣어 주세요'}, 400)
        sys.path.insert(0, str(Path(ROOT) / 'seethrough'))
        import desktop  # noqa: E402
        py = desktop.venv_python()
        if not os.path.isfile(py):
            return self._json({'error': '그림 도구(see-through)가 설치되어 있지 않습니다. 시작 화면의 「설치하기」를 먼저 해 주세요'}, 400)
        with tempfile.TemporaryDirectory() as tmp:
            src, dst = os.path.join(tmp, 'in.psd'), os.path.join(tmp, 'out.psd')
            with open(src, 'wb') as f:
                f.write(body)
            env = dict(os.environ, OPENAI_API_KEY=key, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
            try:
                r = subprocess.run([py, os.path.join(ROOT, 'seethrough', 'expression_art.py'), src, dst], capture_output=True, env=env, timeout=1800)
            except subprocess.TimeoutExpired:
                return self._json({'error': '시간이 너무 오래 걸려 멈췄습니다'}, 504)
            lines = r.stdout.decode('utf-8', 'replace').strip().splitlines()
            try:
                info = json.loads(lines[-1])
            except (ValueError, IndexError):
                err = (r.stderr.decode('utf-8', 'replace').strip().splitlines() or ['알 수 없는 오류'])[-1]
                return self._json({'error': '표정 그림을 만들지 못했습니다: ' + err[-200:]}, 502)
            if not info.get('written') or not os.path.isfile(dst):
                return self._json({'error': '표정 그림을 만들지 못했습니다', 'info': info}, 502)
            with open(dst, 'rb') as f:
                data = f.read()
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Expression-Art', json.dumps(info, ensure_ascii=True)[:4000])
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    do_PUT = do_DELETE = do_PATCH = _not_allowed


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--open-browser', action='store_true')
    parser.add_argument('--camera', action='store_true', help='open the editor with the camera on (?cam=1)')
    parser.add_argument('--no-seethrough', action='store_true', help='do not start / offer the see-through conversion server')
    parser.add_argument('--seethrough-port', type=int, default=seethrough.DEFAULT_PORT, help='port of the conversion server (tests)')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('port must be between 1 and 65535')
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    except OSError as error:
        parser.exit(1, f'Cannot start local server on port {args.port}: {error}\nUse --port to select another port.\n')
    url = f'http://127.0.0.1:{args.port}/'
    global SEETHROUGH_PORT
    SEETHROUGH_PORT = args.seethrough_port
    server.seethrough = None if args.no_seethrough else seethrough.Manager(args.port, port=args.seethrough_port)
    print('Capsule Model Studio (v2 viewer): ' + url + 'v2/viewer/')
    if args.open_browser:
        webbrowser.open(url + ('?cam=1' if args.camera else ''))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if server.seethrough:
            server.seethrough.stop()
        server.server_close()


if __name__ == '__main__':
    main()
