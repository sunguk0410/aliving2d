#!/usr/bin/env python3
"""
see-through conversion server: one anime illustration -> parts PSD.

Standard library only, so the same file runs on Colab, on a GPU desktop,
or with --mode fake on a laptop without a GPU (tests, UI work).

  python seethrough/server.py --repo third_party/see-through            # local GPU
  python seethrough/server.py --repo /content/see-through --tunnel      # Colab
  python seethrough/server.py --mode fake --fake-psd sample2.psd        # no GPU
  python seethrough/desktop.py                                          # GPU desktop: setup once, then run (see that file)

The editor (index.html) talks to it with a "connection code": <url>#<token>.

API (all JSON except the PSD downloads; every request needs X-Token unless --token ''):
  GET  /health             {ok, mode, gpu, busy, queued}
  POST /jobs               body = image bytes (PNG/JPEG/WEBP), header X-Filename, optional X-Resolution
                           (1024 fast | 1152 | 1280 high quality; default --resolution) -> 202 {id}
  GET  /jobs/<id>          {id, status: queued|running|done|error, percent, step, log, elapsed, error}
  GET  /jobs/<id>/psd      parts PSD
  GET  /jobs/<id>/depth    per-layer depth PSD (see-through's *_depth.psd), if any
  GET  /jobs/<id>/prepared the cleaned-up picture that was converted (prepare.py), if any

Before conversion the picture is cleaned up for see-through (seethrough/prepare.py:
background removed, character cropped onto white in a 3:4 frame). --no-prepare skips it.
"""
import argparse
import collections
import json
import os
import platform
import re
import secrets
import shutil
import stat
import subprocess
import sys
import threading
import time
import urllib.request
from urllib.parse import unquote
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = 1
MAX_IMAGE_BYTES = 40 * 1024 * 1024
KEEP_JOBS = 8
IMAGE_MAGIC = [(b'\x89PNG\r\n\x1a\n', '.png'), (b'\xff\xd8\xff', '.jpg'), (b'RIFF', '.webp')]
CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64'


def image_ext(data):
    for magic, ext in IMAGE_MAGIC:
        if data.startswith(magic):
            if ext == '.webp' and data[8:12] != b'WEBP':
                continue
            return ext
    return None


def safe_stem(name):
    stem = os.path.splitext(os.path.basename(name or ''))[0]
    stem = re.sub(r'[^\w.-]+', '_', stem, flags=re.ASCII).strip('._')
    return (stem or 'image')[:60]


def gpu_info():
    """{name, vram_mb, cc} of the first NVIDIA GPU, or None."""
    try:
        out = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.total,compute_cap', '--format=csv,noheader,nounits'],
                             capture_output=True, text=True, timeout=15).stdout.strip().splitlines()
    except (OSError, subprocess.SubprocessError):
        return None
    if not out:
        return None
    parts = [p.strip() for p in out[0].split(',')]
    try:
        return {'name': parts[0], 'vram_mb': int(float(parts[1])), 'cc': float(parts[2]) if len(parts) > 2 else 0.0}
    except (ValueError, IndexError):
        return {'name': parts[0], 'vram_mb': 0, 'cc': 0.0}


def pick_mode(mode, gpu):
    """auto -> full (>= 20 GB, bf16-capable), offload (12-20 GB, bf16-capable) or nf4 (8 GB class, or no bf16 such as T4)."""
    if mode != 'auto':
        return mode
    if not gpu:
        return 'nf4'
    if gpu['cc'] and gpu['cc'] < 8.0:
        return 'nf4'
    if gpu['vram_mb'] >= 20000:
        return 'full'
    if gpu['vram_mb'] >= 12000:
        return 'offload'
    return 'nf4'


class Job:
    def __init__(self, name, workdir):
        self.id = uuid.uuid4().hex[:12]
        self.name = safe_stem(name)
        self.dir = os.path.join(workdir, self.id)
        self.status = 'queued'
        self.percent = 0
        self.step = 0          # how many progress bars finished (layers, depth, ...)
        self.phase = 'queued'  # queued | prepare | parts | depth | psd | done | error
        self.log = collections.deque(maxlen=30)
        self.created = time.time()
        self.started = None
        self.finished = None
        self.error = None
        self.psd = None
        self.depth = None
        self.prepared = None
        self.prep_info = None
        self.proc = None

    def to_json(self):
        now = self.finished or time.time()
        phase = self.status if self.status in ('queued', 'done', 'error') else self.phase
        return {'id': self.id, 'name': self.name, 'status': self.status, 'phase': phase, 'percent': self.percent, 'step': self.step,
                'log': list(self.log)[-8:], 'error': self.error,
                'elapsed': round(now - (self.started or self.created), 1), 'queued_for': round((self.started or now) - self.created, 1),
                'has_depth': bool(self.depth), 'has_prepared': bool(self.prepared), 'prepare': self.prep_info}


class Converter:
    """Runs see-through's inference script for one job at a time."""
    PROGRESS = re.compile(r'(\d{1,3})%\|')

    def __init__(self, args):
        self.args = args
        self.gpu = gpu_info() if args.mode != 'fake' else None
        self.mode = pick_mode(args.mode, self.gpu)
        self.jobs = collections.OrderedDict()
        self.queue = collections.deque()
        self.lock = threading.Lock()
        self.wake = threading.Event()
        os.makedirs(args.workdir, exist_ok=True)
        threading.Thread(target=self._worker, daemon=True).start()

    # ---- jobs ----
    RESOLUTIONS = (1024, 1152, 1280)

    def submit(self, data, name, resolution=None, prepare=True):
        ext = image_ext(data)
        if not ext:
            raise ValueError('PNG / JPEG / WEBP 이미지만 받습니다')
        job = Job(name, self.args.workdir)
        job.resolution = resolution if resolution in self.RESOLUTIONS else None
        job.prepare = prepare
        os.makedirs(job.dir, exist_ok=True)
        with open(os.path.join(job.dir, job.name + ext), 'wb') as f:
            f.write(data)
        job.input = os.path.join(job.dir, job.name + ext)
        with self.lock:
            self.jobs[job.id] = job
            self.queue.append(job)
            self._prune()
        self.wake.set()
        return job

    def _prune(self):
        done = [j for j in self.jobs.values() if j.status in ('done', 'error')]
        for j in done[:-KEEP_JOBS] if len(done) > KEEP_JOBS else []:
            self.jobs.pop(j.id, None)
            shutil.rmtree(j.dir, ignore_errors=True)

    def get(self, job_id):
        with self.lock:
            return self.jobs.get(job_id)

    def cancel(self, job_id):
        job = self.get(job_id)
        if not job:
            return False
        with self.lock:
            if job in self.queue:
                self.queue.remove(job)
                job.status, job.error, job.finished = 'error', '취소됨', time.time()
                return True
        if job.status == 'running':
            job.error = '취소됨'
            if job.proc and job.proc.poll() is None:
                job.proc.kill()
        return True

    @property
    def busy(self):
        return any(j.status == 'running' for j in self.jobs.values())

    # ---- worker ----
    def _worker(self):
        while True:
            self.wake.wait(1.0)
            self.wake.clear()
            while True:
                with self.lock:
                    job = self.queue.popleft() if self.queue else None
                if not job:
                    break
                job.status, job.started, job.phase = 'running', time.time(), 'parts'
                try:
                    self._run(job)
                    job.status = 'done'
                except Exception as err:  # noqa: BLE001 - reported to the client
                    job.status, job.error = 'error', job.error or str(err)
                job.finished = time.time()
                print(f'[job {job.id}] {job.status} in {job.finished - job.started:.0f}s' + (f': {job.error}' if job.error else ''), flush=True)

    # NF4 on a T4: the script's default group offload failed with CUBLAS_STATUS_ALLOC_FAILED,
    # so try plain GPU first, then CPU offload, then the script default.
    NF4_ATTEMPTS = [['--no_group_offload'], ['--no_group_offload', '--cpu_offload'], []]

    def attempts(self):
        return len(self.NF4_ATTEMPTS) if self.mode == 'nf4' else 1

    def command(self, job, out, attempt=0):
        a, repo = self.args, self.args.repo
        if self.mode == 'nf4':
            script = os.path.join(repo, 'inference/scripts/inference_psd_quantized.py')
            cmd = [a.python, script] + self.NF4_ATTEMPTS[attempt]
        elif self.mode == 'blockswap':
            # bf16 weights, transformer blocks swapped between CPU and GPU: ~8 GB at 1280
            cmd = [a.python, os.path.join(repo, 'inference/scripts/inference_psd_blockswap.py')]
        else:
            cmd = [a.python, os.path.join(repo, 'inference/scripts/inference_psd.py')]
            if self.mode == 'offload':
                cmd.append('--group_offload')
        cmd += ['--srcp', job.input, '--save_dir', out, '--save_to_psd']
        res = getattr(job, 'resolution', None) or a.resolution
        if res:
            cmd += ['--resolution', str(res)]
        return cmd

    def _run(self, job):
        out = os.path.join(job.dir, 'out')
        if self.mode == 'fake':
            return self._fake(job, out)
        env = dict(os.environ, PYTHONUNBUFFERED='1', PYTHONIOENCODING='utf-8', HF_HUB_DISABLE_SYMLINKS_WARNING='1')
        if getattr(self.args, 'prepare', True) and getattr(job, 'prepare', True):
            self._prepare(job, env)
        for attempt in range(self.attempts()):
            if job.error:
                raise RuntimeError(job.error)
            shutil.rmtree(out, ignore_errors=True)
            cmd = self.command(job, out, attempt)
            job.log.append('$ ' + ' '.join(os.path.relpath(c, self.args.repo) if os.path.isabs(c) and c.startswith(self.args.repo) else c for c in cmd[1:]))
            job.percent, job.step = 0, 0
            job.proc = subprocess.Popen(cmd, cwd=self.args.repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            self._pump(job, job.proc.stdout)
            code = job.proc.wait()
            if code == 0:
                return self._collect(job, out)
            if job.error:
                raise RuntimeError(job.error)
            job.log.append(f'(exit {code}) 다른 방식으로 다시 시도' if attempt + 1 < self.attempts() else f'(exit {code})')
        raise RuntimeError('see-through가 실패했습니다. 로그를 확인하세요')

    def _prepare(self, job, env):
        """Background removal + crop to a see-through friendly picture (prepare.py, in the see-through Python)."""
        dst = os.path.join(job.dir, job.name + '_prepared.png')
        job.phase = 'prepare'
        job.log.append('그림 다듬기: 배경 지우기 · 캐릭터만 잘라 흰 바탕에 놓기')
        r = subprocess.run([self.args.python, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'prepare.py'), job.input, dst],
                           capture_output=True, env=env, timeout=600)
        out = r.stdout.decode('utf-8', 'replace').strip().splitlines()
        if r.returncode != 0 or not os.path.isfile(dst):
            err = (r.stderr.decode('utf-8', 'replace').strip().splitlines() or out or ['?'])[-1]
            job.log.append('그림 다듬기 실패, 원본 그대로 변환합니다: ' + err[-160:])
            return
        try:
            job.prep_info = json.loads(out[-1])
        except (ValueError, IndexError):
            job.prep_info = None
        job.prepared = job.input = dst
        job.log.append('그림 다듬기 완료')

    def _pump(self, job, stream):
        """Read tqdm-style output (\\r updates) and keep percent + last lines."""
        buf, last_pct = b'', 0
        while True:
            chunk = stream.read1(4096) if hasattr(stream, 'read1') else stream.read(4096)
            if not chunk:
                break
            buf += chunk
            parts = re.split(rb'[\r\n]', buf)
            buf = parts.pop()
            for raw in parts:
                line = raw.decode('utf-8', 'replace').strip()
                if not line:
                    continue
                m = self.PROGRESS.search(line)
                if m:
                    pct = int(m.group(1))
                    if pct < last_pct - 50:
                        job.step += 1
                    last_pct = job.percent = pct
                    if job.log and self.PROGRESS.search(job.log[-1]):
                        job.log[-1] = line[-160:]
                        continue
                job.log.append(line[-160:])
                if 'LayerDiff3D done' in line or 'Marigold' in line or 'depth pipeline' in line:
                    job.phase = 'depth'
                elif 'LayerDiff' in line and job.phase in ('queued', 'prepare', 'running'):
                    job.phase = 'parts'
                elif 'Stats saved' in line or 'psd saved' in line.lower():
                    job.phase = 'psd'
                if self.args.verbose:
                    print(f'[job {job.id}] {line}', flush=True)

    def _collect(self, job, out):
        psd = os.path.join(out, job.name + '.psd')
        if not os.path.isfile(psd):
            found = [os.path.join(r, f) for r, _, fs in os.walk(out) for f in fs if f.endswith('.psd') and not f.endswith('_depth.psd')]
            if not found:
                raise RuntimeError('PSD가 만들어지지 않았습니다')
            psd = found[0]
        depth = os.path.splitext(psd)[0] + '_depth.psd'
        job.depth = depth if os.path.isfile(depth) else None
        job.psd = self._fix_psd(job, psd) if self.mode != 'fake' else psd

    def _fix_psd(self, job, psd):
        """Erase hidden paintings that wrongly cover visible parts (fix_psd.py); the PSD as is on failure."""
        src = os.path.join(os.path.splitext(psd)[0], 'src_img.png')
        if not os.path.isfile(src):
            return psd
        job.phase = 'psd'
        fixed_dir = os.path.join(job.dir, 'fixed')
        os.makedirs(fixed_dir, exist_ok=True)
        out = os.path.join(fixed_dir, os.path.basename(psd))
        env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
        try:
            r = subprocess.run([self.args.python, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fix_psd.py'), psd, src, out],
                               capture_output=True, env=env, timeout=600)
        except (OSError, subprocess.SubprocessError) as err:
            job.log.append('PSD 정리 건너뜀: ' + str(err)[-120:])
            return psd
        lines = r.stdout.decode('utf-8', 'replace').strip().splitlines()
        if r.returncode != 0:
            job.log.append('PSD 정리 건너뜀: ' + (r.stderr.decode('utf-8', 'replace').strip().splitlines() or ['?'])[-1][-120:])
            return psd
        try:
            info = json.loads(lines[-1])
        except (ValueError, IndexError):
            return psd
        if info.get('written') and os.path.isfile(out):
            job.log.append('PSD 정리: 가려진 부분을 덮던 그림 지움 ' + ', '.join(f'{k} {v}px' for k, v in info['erased'].items()))
            return out
        job.log.append('PSD 정리: 고칠 곳 없음')
        return psd

    def _fake(self, job, out):
        os.makedirs(out, exist_ok=True)
        steps = max(1, int(self.args.fake_seconds * 10))
        for i in range(steps + 1):
            if job.error:
                raise RuntimeError(job.error)
            job.percent = int(100 * i / steps)
            job.phase = 'parts' if i < steps // 2 else 'depth'
            if i == steps // 2:
                job.step += 1
            job.log.append(f'fake {job.percent}%|')
            time.sleep(self.args.fake_seconds / steps)
        if not self.args.fake_psd:
            raise RuntimeError('--fake-psd 가 지정되지 않았습니다')
        dst = os.path.join(out, job.name + '.psd')
        shutil.copyfile(self.args.fake_psd, dst)
        self._collect(job, out)


def make_handler(conv, token, origins=None):
    """origins: browser origins allowed to call the API (None = any). With no token, a desktop
    server limits itself to the local editor so other web pages cannot use it."""
    origins = set(origins) if origins else None

    class Handler(BaseHTTPRequestHandler):
        server_version = 'capsule-seethrough/%d' % VERSION

        def _origin_ok(self):
            origin = self.headers.get('Origin')
            if origins is None or origin is None or origin in origins:
                return True
            self._json(403, {'error': '이 주소의 페이지에서는 쓸 수 없습니다 (편집기 http://127.0.0.1:8000 에서 여세요)'})
            return False

        def log_message(self, fmt, *a):  # keep Colab output readable
            if conv.args.verbose:
                sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % a))

        def _cors(self):
            origin = self.headers.get('Origin')
            if origins is None:
                self.send_header('Access-Control-Allow-Origin', '*')
            elif origin in origins:
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Token, X-Filename, X-Resolution, X-Prepare')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Access-Control-Expose-Headers', 'Content-Disposition')

        def _json(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self._cors()
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def _authed(self):
            if not token:
                return True
            if secrets.compare_digest(self.headers.get('X-Token', ''), token):
                return True
            self._json(401, {'error': '연결 코드의 토큰이 맞지 않습니다'})
            return False

        def do_OPTIONS(self):
            if not self._origin_ok():
                return
            self.send_response(204)
            self._cors()
            self.send_header('Access-Control-Max-Age', '600')
            self.end_headers()

        def do_GET(self):
            if not self._origin_ok() or not self._authed():
                return
            path = self.path.split('?', 1)[0].rstrip('/')
            if path == '/health':
                return self._json(200, {'ok': True, 'version': VERSION, 'mode': conv.mode, 'gpu': conv.gpu,
                                        'busy': conv.busy, 'queued': len(conv.queue)})
            m = re.fullmatch(r'/jobs/([0-9a-f]{12})(/psd|/depth|/prepared)?', path)
            if not m:
                return self._json(404, {'error': 'not found'})
            job = conv.get(m.group(1))
            if not job:
                return self._json(404, {'error': '작업이 없습니다 (서버가 재시작되었나요?)'})
            if not m.group(2):
                return self._json(200, job.to_json())
            f = {'/psd': job.psd, '/depth': job.depth, '/prepared': job.prepared}[m.group(2)]
            if (m.group(2) != '/prepared' and job.status != 'done') or not f:
                return self._json(409, {'error': '아직 결과가 없습니다'})
            size = os.path.getsize(f)
            self.send_response(200)
            self._cors()
            self.send_header('Content-Type', 'image/png' if m.group(2) == '/prepared' else 'application/octet-stream')
            self.send_header('Content-Length', str(size))
            self.send_header('Content-Disposition', 'attachment; filename="%s"' % os.path.basename(f))
            self.end_headers()
            with open(f, 'rb') as fh:
                shutil.copyfileobj(fh, self.wfile)

        def do_POST(self):
            if not self._origin_ok() or not self._authed():
                return
            if self.path.split('?', 1)[0].rstrip('/') != '/jobs':
                return self._json(404, {'error': 'not found'})
            try:
                n = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                n = -1
            if n <= 0 or n > MAX_IMAGE_BYTES:
                return self._json(413, {'error': '이미지는 40MB 이하로 보내 주세요'})
            data = self.rfile.read(n)
            try:
                try:
                    res = int(self.headers.get('X-Resolution', '0'))
                except ValueError:
                    res = 0
                job = conv.submit(data, unquote(self.headers.get('X-Filename', 'image')), res or None,
                                  prepare=self.headers.get('X-Prepare', '1') != '0')
            except ValueError as err:
                return self._json(400, {'error': str(err)})
            print(f'[job {job.id}] queued {job.name} ({n // 1024} KB, mode {conv.mode})', flush=True)
            return self._json(202, {'id': job.id})

        def do_DELETE(self):
            if not self._origin_ok() or not self._authed():
                return
            m = re.fullmatch(r'/jobs/([0-9a-f]{12})', self.path.split('?', 1)[0].rstrip('/'))
            if not m or not conv.cancel(m.group(1)):
                return self._json(404, {'error': 'not found'})
            return self._json(200, {'ok': True})

    return Handler


def start_tunnel(port, bindir):
    """Cloudflare quick tunnel (no account). Returns the public https URL."""
    exe = shutil.which('cloudflared') or os.path.join(bindir, 'cloudflared')
    if not os.path.isfile(exe):
        if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'AMD64'):
            raise RuntimeError('cloudflared가 없습니다. 설치하거나 --tunnel 없이 실행하세요')
        os.makedirs(bindir, exist_ok=True)
        print('cloudflared 다운로드 중…', flush=True)
        urllib.request.urlretrieve(CLOUDFLARED_URL, exe)
        os.chmod(exe, os.stat(exe).st_mode | stat.S_IEXEC)
    proc = subprocess.Popen([exe, 'tunnel', '--no-autoupdate', '--url', f'http://127.0.0.1:{port}'],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    url_re = re.compile(r'https://[-a-z0-9]+\.trycloudflare\.com')
    deadline = time.time() + 60
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                break
            continue
        m = url_re.search(line)
        if m:
            threading.Thread(target=lambda: [None for _ in proc.stdout], daemon=True).start()   # drain
            return m.group(0)
    raise RuntimeError('터널 주소를 받지 못했습니다')


def main(argv=None):
    ap = argparse.ArgumentParser(description='see-through conversion server (image -> parts PSD)')
    ap.add_argument('--repo', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'third_party', 'see-through'),
                    help='see-through checkout')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=7860)
    ap.add_argument('--token', default=None, help="access token (default: random; '' = no token, local use only)")
    ap.add_argument('--mode', default='auto', choices=['auto', 'full', 'offload', 'blockswap', 'nf4', 'fake'])
    ap.add_argument('--resolution', type=int, default=0, help='LayerDiff resolution (default: script default, 1280)')
    ap.add_argument('--python', default=sys.executable)
    ap.add_argument('--workdir', default=os.path.join(os.path.abspath('.'), 'seethrough_jobs'))
    ap.add_argument('--tunnel', action='store_true', help='expose through a Cloudflare quick tunnel (Colab)')
    ap.add_argument('--fake-psd', default=None, help='--mode fake: PSD returned for every image')
    ap.add_argument('--fake-seconds', type=float, default=3.0)
    ap.add_argument('--no-prepare', dest='prepare', action='store_false', help='convert the picture as is (no background removal / crop)')
    ap.add_argument('--allow-origin', action='append', default=None, metavar='ORIGIN',
                    help='only these browser origins may call the API (repeatable; default: any)')
    ap.add_argument('--verbose', action='store_true')
    args = ap.parse_args(argv)
    args.repo = os.path.abspath(args.repo)
    if os.path.exists(args.python):   # jobs run with cwd = repo, so a relative path would break
        args.python = os.path.abspath(args.python)
    args.workdir = os.path.abspath(args.workdir)
    if args.mode != 'fake' and not os.path.isfile(os.path.join(args.repo, 'inference/scripts/inference_psd.py')):
        ap.error('see-through 저장소가 없습니다: ' + args.repo + ' (git submodule update --init)')
    token = secrets.token_urlsafe(12) if args.token is None else args.token

    conv = Converter(args)
    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(conv, token, args.allow_origin))
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    gpu = conv.gpu
    print(f'see-through 서버: http://{args.host}:{port}  mode={conv.mode}' + (f"  GPU={gpu['name']} {gpu['vram_mb']}MB" if gpu else ''), flush=True)
    base = f'http://127.0.0.1:{port}'
    if args.tunnel:
        base = start_tunnel(port, os.path.join(args.workdir, '.bin'))
    code = base + ('#' + token if token else '')
    print('\n' + '=' * 64 + '\n  연결 코드 (편집기 시작 화면에 붙여넣기)\n\n  ' + code + '\n' + '=' * 64 + '\n', flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print('종료합니다')
        httpd.shutdown()


if __name__ == '__main__':
    main()
