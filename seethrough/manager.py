"""
see-through for the editor server (serve.py): nothing to run by hand.

  - npm start on a PC with an NVIDIA GPU and see-through installed: the
    conversion server starts in the background, limited to this editor
    (no token, origin check) and stops with npm start.
  - Not installed yet: the editor shows an 「설치하기」 button; install()
    runs seethrough/desktop.py --setup-only and then starts the server.
  - A server already listening on the port (npm run seethrough) is used as is.

Standard library only.
"""
import collections
import http.client
import json
import os
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 7860


def probe(port=DEFAULT_PORT):
    """{url, mode, gpu, busy} of a tokenless see-through server on this PC, or None."""
    try:
        c = http.client.HTTPConnection('127.0.0.1', port, timeout=0.5)
        c.request('GET', '/health')
        r = c.getresponse()
        data = json.loads(r.read() or b'null') if r.status == 200 else None
        c.close()
    except (OSError, ValueError, http.client.HTTPException):
        return None
    if not isinstance(data, dict) or not data.get('ok'):
        return None
    return {'url': f'http://127.0.0.1:{port}', 'mode': data.get('mode'), 'gpu': data.get('gpu'), 'busy': bool(data.get('busy'))}


class Manager:
    """States: checking -> no-gpu | not-installed | starting -> ready | error; installing -> starting."""

    def __init__(self, editor_port, port=DEFAULT_PORT, start=True):
        self.editor_port, self.port = editor_port, port
        self.state, self.message, self.gpu = 'checking', '', None
        self.log = collections.deque(maxlen=60)
        self.proc = self.setup_proc = None
        self.lock = threading.Lock()
        self.stopped = False
        if start:
            threading.Thread(target=self._boot, daemon=True).start()

    # ---- helpers (overridable in tests) ----
    def _desktop(self):
        sys.path.insert(0, HERE)
        import desktop  # noqa: E402
        return desktop

    def _set(self, state, message=''):
        with self.lock:
            self.state, self.message = state, message

    def _pump(self, proc, prefix=''):
        for raw in iter(proc.stdout.readline, b''):
            line = raw.decode('utf-8', 'replace').rstrip()
            if line:
                self.log.append(prefix + line[-200:])

    # ---- lifecycle ----
    def _boot(self):
        if probe(self.port):
            self._set('ready', '이미 켜져 있는 변환 서버를 씁니다')
            return
        d = self._desktop()
        self.gpu = d.gpu()
        if not self.gpu:
            self._set('no-gpu')
            return
        if d.status()['installed']:
            self._start_server()
        else:
            self._set('not-installed')

    def _start_server(self):
        d = self._desktop()
        self._set('starting', '변환 서버를 켜는 중')
        origins = [f'http://127.0.0.1:{self.editor_port}', f'http://localhost:{self.editor_port}']
        cmd = [sys.executable, os.path.join(HERE, 'server.py'), '--repo', d.REPO, '--python', d.venv_python(),
               '--workdir', d.WORKDIR, '--port', str(self.port), '--token', '']
        for o in origins:
            cmd += ['--allow-origin', o]
        env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUNBUFFERED='1')
        try:
            self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
        except OSError as err:
            self._set('error', '변환 서버를 켜지 못했습니다: ' + str(err))
            return
        threading.Thread(target=self._pump, args=(self.proc,), daemon=True).start()
        for _ in range(120):
            if self.stopped:
                return
            if probe(self.port):
                self._set('ready')
                threading.Thread(target=self._watch, daemon=True).start()
                return
            if self.proc.poll() is not None:
                break
            time.sleep(0.25)
        self._set('error', '변환 서버가 켜지지 않았습니다' + (f' (포트 {self.port}을 다른 프로그램이 쓰는 중?)' if self.proc.poll() is not None else ''))

    def _watch(self):
        code = self.proc.wait()
        if not self.stopped:
            self._set('error', f'변환 서버가 멈췄습니다 (exit {code})')

    def install(self):
        """Start the one-time setup in the background. Returns False if it cannot start now."""
        with self.lock:
            if self.state not in ('not-installed', 'error') or not self.gpu or self.setup_proc:
                return False
            self.state, self.message = 'installing', '설치 준비 중'
        threading.Thread(target=self._install, daemon=True).start()
        return True

    def _install(self):
        d = self._desktop()
        env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUNBUFFERED='1')
        self.log.clear()
        try:
            self.setup_proc = subprocess.Popen([sys.executable, os.path.join(HERE, 'desktop.py'), '--setup-only'],
                                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=os.path.dirname(HERE))
        except OSError as err:
            self._set('error', '설치를 시작하지 못했습니다: ' + str(err))
            return
        for raw in iter(self.setup_proc.stdout.readline, b''):
            line = raw.decode('utf-8', 'replace').rstrip()
            if not line:
                continue
            self.log.append(line[-200:])
            if line[:1] in '①②③④⑤⑥':
                self._set('installing', line)
        code = self.setup_proc.wait()
        self.setup_proc = None
        if self.stopped:
            return
        if code == 0 and d.status()['installed']:
            self._start_server()
        else:
            self._set('error', '설치에 실패했습니다. 아래 로그를 확인하고 다시 시도하세요')

    def info(self):
        with self.lock:
            out = {'state': self.state, 'message': self.message, 'gpu': self.gpu}
        if out['state'] in ('installing', 'error'):
            out['log'] = list(self.log)[-6:]
        return out

    def stop(self):
        self.stopped = True
        for p in (self.proc, self.setup_proc):
            if p and p.poll() is None:
                try:
                    p.terminate()
                    p.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    p.kill()
