"""Local static server for Capsule Model Studio (npm start).

Serves the v2 dashboard (/ -> /v2/studio/) and model viewer from this folder to this PC only:
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
import re
import subprocess
import sys
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = str(Path(__file__).resolve().parent)
sys.path.insert(0, str(Path(ROOT) / 'seethrough'))
import manager as seethrough  # noqa: E402  (standard library only)
import redraw  # noqa: E402  (the OpenAI key, standard library only)

SEETHROUGH_PORT = seethrough.DEFAULT_PORT

# v2 dashboard jobs: one folder per picture (v2/py/pipeline.py writes status.json and every step's files there)
WORK = Path(ROOT) / 'v2' / 'work'
EXTRAS = ('physics', 'arms', 'body', 'fx', 'presets')     # v2/py/artisan.py EXTRAS
JOB_ID = __import__('re').compile(r'[0-9]{4}-[0-9]{6}-[0-9a-f]{4}|[a-z0-9_-]{1,40}')
STEP_KEYS = ('prepare', 'base', 'upscale', 'body', 'headcrop', 'head', 'mouth', 'smile', 'rig',
             'front', 'parts')   # the last two: jobs from before the waist-up base


def pid_alive(pid):
    if not pid:
        return False
    if os.name == 'nt':
        r = subprocess.run(['tasklist', '/FI', f'PID eq {int(pid)}', '/NH'], capture_output=True, text=True)
        return str(int(pid)) in r.stdout
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


def v2_jobs():
    out = []
    if WORK.is_dir():
        for d in WORK.iterdir():
            f = d / 'status.json'
            if f.is_file():
                try:
                    j = json.loads(f.read_text(encoding='utf-8'))
                except (OSError, ValueError):
                    continue
                if j.get('state') in ('running', 'starting') and j.get('pid') and not pid_alive(j['pid']):
                    j['state'] = 'error'          # the pipeline process is gone (closed, crashed)
                    j['dead'] = True
                    for s in (j.get('steps') or {}).values():
                        if s.get('status') == 'running':
                            s['status'], s['error'] = 'error', '작업 프로세스가 꺼졌습니다 (여기부터 다시 눌러 주세요)'
                try:
                    j['options'] = json.loads((d / 'options.json').read_text(encoding='utf-8'))
                except (OSError, ValueError):
                    j['options'] = {}
                if j['options'].get('name'):         # renamed on a dashboard
                    j['name'] = j['options']['name']
                out.append(j)
    out.sort(key=lambda j: j.get('created', 0), reverse=True)
    return out


def v2_start(job_dir, start=None):
    """Run the pipeline for a job folder in the see-through Python, in the background (survives this request)."""
    sys.path.insert(0, str(Path(ROOT) / 'seethrough'))
    import desktop  # noqa: E402
    py = desktop.venv_python()
    if not os.path.isfile(py):
        raise RuntimeError('그림 도구(see-through)가 설치되어 있지 않습니다')
    cmd = [py, str(Path(ROOT) / 'v2' / 'py' / 'pipeline.py'), str(job_dir)] + (['--from', start] if start else [])
    log = open(job_dir / 'pipeline.log', 'a', encoding='utf-8')
    env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
    if os.name != 'nt':
        subprocess.Popen(cmd, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, env=env, start_new_session=True)
        return
    # npm runs this server inside a Windows job object that is closed (with every process in it) when npm stops;
    # break away from it so a 40-minute pipeline survives restarting the server
    # CREATE_NO_WINDOW, not DETACHED_PROCESS: a detached process has no console, so every console program it
    # starts (the venv python, see-through) would open its own window; a hidden console is shared instead
    base = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    try:
        subprocess.Popen(cmd, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, env=env,
                         creationflags=base | 0x01000000)          # CREATE_BREAKAWAY_FROM_JOB
    except OSError:
        subprocess.Popen(cmd, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, env=env, creationflags=base)


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
            self.send_header('Location', '/v2/studio/')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if urlsplit(self.path).path == '/api/v2/jobs':
            return self._json({'jobs': v2_jobs(), 'seethrough': local_seethrough(), 'openai': redraw.key_info()})
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

    def _bundle_of(self, model_url):
        """'../bundles/<id>/model.json' (as the editor knows it) -> the bundle folder, or None."""
        m = re.fullmatch(r'(?:\.\./|/?v2/)?bundles/([A-Za-z0-9_-]{1,40})/model\.json(?:\?.*)?', model_url or '')
        if not m:
            return None, None
        d = Path(ROOT) / 'v2' / 'bundles' / m.group(1)
        return (d, m.group(1)) if (d / 'model.json').is_file() else (None, None)

    def _edit(self, what):
        """The editor's 「요청」 panel (seethrough/model_edit.py): plan = a request in words -> actions,
        scale = keyforms of one parameter x factor, undo = the model.json before the last scale."""
        import model_edit
        try:
            got = json.loads(self._body(65536) or b'{}')
        except ValueError:
            return self._json({'error': '잘못된 요청'}, 400)
        d, mid = self._bundle_of(got.get('model'))
        if d is None:
            return self._json({'error': '모델을 찾지 못했습니다'}, 404)
        if what == 'undo':
            return self._json({'undone': model_edit.undo(str(d))})
        if what == 'scale':
            pid, f = got.get('param'), got.get('factor')
            if not isinstance(pid, str) or not re.fullmatch(r'\w{1,40}', pid) or not isinstance(f, (int, float)) or not 0.3 <= f <= 2.0:
                return self._json({'error': '잘못된 값'}, 400)
            return self._json({'parts': model_edit.scale(str(d), pid, float(f))})
        text = got.get('request')
        if not isinstance(text, str) or not text.strip():
            return self._json({'error': '요청이 비어 있습니다'}, 400)
        if not redraw.key_info()['ready']:
            return self._json({'error': 'OpenAI API 키가 없습니다'}, 409)
        job = {}
        jd = WORK / mid
        try:
            st = json.loads((jd / 'status.json').read_text(encoding='utf-8'))
            opts = json.loads((jd / 'options.json').read_text(encoding='utf-8')) if (jd / 'options.json').is_file() else {}
            job = {'rerig': (st.get('steps', {}).get('head') or {}).get('status') == 'done', 'id': mid,
                   'extras': opts.get('extras', []), 'ears': opts.get('ears', True)}
        except (OSError, ValueError):
            pass
        model = json.loads((d / 'model.json').read_text(encoding='utf-8'))
        try:
            out = model_edit.plan(text, model, got.get('history') or [], job)
        except Exception as err:  # noqa: BLE001 - shown in the panel
            return self._json({'error': str(err)[:400]}, 502)
        out['job'] = job.get('id') if job.get('rerig') else None
        return self._json(out)

    def _save_expression(self):
        """An expression the user set with the sliders: {name, label?, params: {id: value}, model?} or
        {name, delete: true}. Kept in v2/expressions.user.json (every model built later gets it) and, with model =
        'v2/bundles/<id>/model.json', written into that bundle at once (model.json + expressions/<name>.exp3.json)."""
        try:
            got = json.loads(self._body(65536) or b'{}')
        except ValueError:
            return self._json({'error': '잘못된 요청'}, 400)
        name = got.get('name')
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', name):
            return self._json({'error': '이름은 영문·숫자·_·- 40자까지'}, 400)
        delete = got.get('delete') is True
        params = got.get('params') or {}
        if not delete and (not isinstance(params, dict) or not params or len(params) > 200 or not all(
                isinstance(k, str) and re.fullmatch(r'\w{1,40}', k) and isinstance(v, (int, float)) and abs(v) < 1e3
                for k, v in params.items())):
            return self._json({'error': '잘못된 파라미터'}, 400)
        label = str(got.get('label') or name)[:40]
        f = Path(ROOT) / 'v2' / 'expressions.user.json'
        try:
            table = json.loads(f.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            table = {'format': 'capsule-user-expressions', 'expressions': {}}
        ex = table.setdefault('expressions', {})
        if delete:
            ex.pop(name, None)
        else:
            ex[name] = {'label': label, 'params': {k: round(float(v), 4) for k, v in params.items()}}
        f.write_text(json.dumps(table, ensure_ascii=False, indent=1), encoding='utf-8')
        bundle = got.get('model')
        mm = re.fullmatch(r'(?:\.\./|/?v2/)?bundles/([A-Za-z0-9_-]{1,40})/model\.json', bundle or '')
        if mm:
            d = Path(ROOT) / 'v2' / 'bundles' / mm.group(1)
            mf = d / 'model.json'
            if mf.is_file():
                model = json.loads(mf.read_text(encoding='utf-8'))
                ids = {q['id'] for q in model.get('params', [])}
                lst = [e for e in model.get('expressions', []) if e.get('name') != name]
                fn = f'expressions/{name}.exp3.json'
                if delete:
                    (d / fn).unlink(missing_ok=True)
                else:
                    vals = {k: round(float(v), 4) for k, v in params.items() if k in ids}
                    (d / 'expressions').mkdir(exist_ok=True)
                    (d / fn).write_text(json.dumps({
                        'Type': 'Live2D Expression', 'FadeInTime': 0.3, 'FadeOutTime': 0.3,
                        'Parameters': [{'Id': k, 'Value': v, 'Blend': 'Overwrite'} for k, v in vals.items()]},
                        ensure_ascii=False, indent=1), encoding='utf-8')
                    lst.append({'name': name, 'label': label, 'file': fn, 'params': vals})
                model['expressions'] = lst
                mf.write_text(json.dumps(model, separators=(',', ':')), encoding='utf-8')
        return self._json({'expressions': ex})

    def _body(self, limit):
        try:
            n = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            n = -1
        if n < 0 or n > limit:
            return None
        return self.rfile.read(n) if n else b''

    def do_POST(self):
        # Writes from the dashboard pages only: see-through 「설치하기」, the OpenAI key, /api/v2/*.
        # Browsers always send Origin on fetch POST, so requiring it (and same_origin) keeps other pages out.
        path = urlsplit(self.path).path
        if path.startswith('/api/v2/') and self.headers.get('Origin'):
            if not self.same_origin():
                return
            return self._v2_post(path)
        if path not in ('/api/seethrough/install', '/api/redraw/key') or not self.headers.get('Origin'):
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
        return self._not_allowed()

    def _v2_post(self, path):
        import re
        import secrets
        import time as _time
        if path == '/api/v2/jobs':
            body = self._body(40 * 1024 * 1024)
            if not body:
                self.close_connection = True
                return self._json({'error': '그림은 40MB 이하로 보내 주세요'}, 413)
            ext = {bytes([0x89]) + b'PNG': 'png', bytes([0xFF, 0xD8, 0xFF]): 'jpg', b'RIFF': 'webp'}
            kind = next((e for sig, e in ext.items() if body.startswith(sig)), None)
            if not kind:
                return self._json({'error': 'PNG / JPG / WEBP 그림만 올릴 수 있습니다'}, 400)
            jid = _time.strftime('%m%d-%H%M%S') + '-' + secrets.token_hex(2)
            d = WORK / jid
            d.mkdir(parents=True)
            (d / f'input.{kind}').write_bytes(body)
            name = unquote(self.headers.get('X-Name', '') or jid)[:60]
            (d / 'status.json').write_text(json.dumps({'id': jid, 'name': name, 'created': _time.time(),
                                                       'state': 'starting', 'input': f'input.{kind}', 'steps': {}}, ensure_ascii=False), encoding='utf-8')
            try:
                v2_start(d)
            except RuntimeError as err:
                return self._json({'error': str(err)}, 409)
            return self._json({'id': jid}, 202)
        m = re.fullmatch(r'/api/v2/jobs/([A-Za-z0-9_-]{1,40})/rerun', path)
        if m and JOB_ID.fullmatch(m.group(1)):
            d = WORK / m.group(1)
            start = urlsplit(self.path).query.partition('from=')[2].split('&')[0] or None
            if not (d / 'status.json').is_file() or (start and start not in STEP_KEYS):
                return self._json({'error': '작업이 없습니다'}, 404)
            st = json.loads((d / 'status.json').read_text(encoding='utf-8'))
            if st.get('state') in ('running', 'starting') and pid_alive(st.get('pid')):
                return self._json({'error': '아직 진행 중입니다'}, 409)
            try:
                v2_start(d, start)
            except RuntimeError as err:
                return self._json({'error': str(err)}, 409)
            return self._json({'id': m.group(1)}, 202)
        if path == '/api/v2/expressions':
            return self._save_expression()
        if path in ('/api/v2/edit/plan', '/api/v2/edit/scale', '/api/v2/edit/undo'):
            return self._edit(path.rsplit('/', 1)[1])
        m = re.fullmatch(r'/api/v2/jobs/([A-Za-z0-9_-]{1,40})/options', path)
        if m and JOB_ID.fullmatch(m.group(1)):
            # per-job rig options, in their own file (the running pipeline rewrites status.json)
            d = WORK / m.group(1)
            if not (d / 'status.json').is_file():
                return self._json({'error': '작업이 없습니다'}, 404)
            try:
                got = json.loads(self._body(4096) or b'{}')
            except ValueError:
                return self._json({'error': '잘못된 옵션'}, 400)
            f = d / 'options.json'
            try:
                opts = json.loads(f.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                opts = {}
            for k in ('ears',):                    # true / false, or null = automatic
                if k in got and (got[k] is None or isinstance(got[k], bool)):
                    if got[k] is None:
                        opts.pop(k, None)
                    else:
                        opts[k] = got[k]
            if isinstance(got.get('name'), str):         # the name shown on the dashboards (rename)
                nm = ' '.join(got['name'].split())[:60]
                if nm:
                    opts['name'] = nm
                else:
                    opts.pop('name', None)
            if 'extras' in got and isinstance(got['extras'], list):   # artisan.EXTRAS the model gets on top
                opts['extras'] = sorted({x for x in got['extras'] if x in EXTRAS})
            f.write_text(json.dumps(opts), encoding='utf-8')
            return self._json({'options': opts})
        m = re.fullmatch(r'/api/v2/jobs/([A-Za-z0-9_-]{1,40})/stop', path)
        if m and JOB_ID.fullmatch(m.group(1)):
            d = WORK / m.group(1)
            f = d / 'status.json'
            if not f.is_file():
                return self._json({'error': '작업이 없습니다'}, 404)
            st = json.loads(f.read_text(encoding='utf-8'))
            pid = st.get('pid')
            if pid and pid_alive(pid):
                # the pipeline was started by this server (v2_start); stop it and what it started
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/PID', str(int(pid)), '/T', '/F'], capture_output=True)
                else:
                    os.kill(int(pid), 9)
            st['state'], st['pid'] = 'error', None
            for s in (st.get('steps') or {}).values():
                if s.get('status') == 'running':
                    s['status'], s['error'] = 'error', '멈춤 버튼으로 멈췄습니다'
            f.write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding='utf-8')
            return self._json({'stopped': True})
        return self._json({'error': 'not found'}, 404)

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
    print('Capsule Model Studio: ' + url + 'v2/studio/')
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
