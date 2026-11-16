#!/usr/bin/env python3
"""
see-through on a GPU desktop from the command line. Usually not needed:
`npm start` already starts the conversion server (and the editor has an
「설치하기」 button) - see seethrough/manager.py. Use this for --lan, --check,
or to install from a terminal.

  npm run seethrough                    (= python seethrough/desktop.py)
  python seethrough/desktop.py --check  only show what is installed
  python seethrough/desktop.py --setup-only
  python seethrough/desktop.py --lan    use it from another PC (laptop) on the same network

First run (10-20 minutes, several GB): see-through source (git submodule),
a private Python environment in seethrough/.venv with CUDA PyTorch, and the
inference requirements. The model weights download from Hugging Face on the
first conversion. Later runs start in seconds.

Then: the editor opens (http://127.0.0.1:8000/) and finds this server by
itself; drop a picture on it and the parts PSD is rigged right away.
Only the editor on this PC may use the server (no token, origin check);
--lan switches to a token + connection code instead.
"""
import argparse
import hashlib
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.join(ROOT, 'third_party', 'see-through')
VENV = os.path.join(HERE, '.venv')
WORKDIR = os.path.join(HERE, '.jobs')
STAMP = os.path.join(VENV, '.capsule-setup.json')
TORCH = ['torch==2.8.0', 'torchvision==0.23.0']           # same pins as see-through's README
TORCH_INDEX = 'https://download.pytorch.org/whl/cu128'
EXTRA = ['onnxruntime']                                   # prepare.py: anime character segmentation
# Not needed for inference (GUI, training, dev tools)
SKIP = ['PyQt6', 'PyQt6-Qt6', 'qtpy', 'lpips', 'convnext_perceptual_loss', 'ipykernel', 'pytest', 'Cython', 'wheel']
EDITOR_PORT, SERVER_PORT = 8000, 7860
EDITOR_ORIGINS = [f'http://127.0.0.1:{EDITOR_PORT}', f'http://localhost:{EDITOR_PORT}']


def say(msg=''):
    print(msg, flush=True)


def venv_python():
    return os.path.join(VENV, 'Scripts', 'python.exe') if os.name == 'nt' else os.path.join(VENV, 'bin', 'python')


def filtered_requirements(text):
    """see-through's requirements.txt without the GUI / training / dev packages."""
    out = []
    for line in text.splitlines():
        name = line.strip().split('#')[0].strip()
        base = name.split('@')[0].split('=')[0].split('<')[0].split('>')[0].split('[')[0].strip()
        if base in SKIP:
            continue
        out.append(line)
    return '\n'.join(out) + '\n'


def requirements_hash():
    h = hashlib.sha256()
    for f in ('requirements.txt', 'requirements-inference-bnb.txt'):
        p = os.path.join(REPO, f)
        if os.path.isfile(p):
            with open(p, 'rb') as fh:
                h.update(fh.read())
    h.update(json.dumps([TORCH, TORCH_INDEX, SKIP, EXTRA]).encode())
    return h.hexdigest()[:16]


def run(cmd, cwd=None, check=True):
    say('  $ ' + ' '.join(cmd))
    r = subprocess.run(cmd, cwd=cwd)
    if check and r.returncode != 0:
        raise SystemExit(f'\n실패했습니다 (exit {r.returncode}): {" ".join(cmd[:4])} …\n위 로그를 확인하세요. 다시 실행하면 이어서 합니다.')
    return r.returncode


def gpu():
    sys.path.insert(0, HERE)
    import server  # noqa: E402 - standard library only
    return server.gpu_info()


def link_assets():
    """see-through expects <repo>/assets -> common/assets (README step 4)."""
    dst, src = os.path.join(REPO, 'assets'), os.path.join(REPO, 'common', 'assets')
    if os.path.exists(dst) or not os.path.isdir(src):
        return 'exists' if os.path.exists(dst) else 'missing'
    if os.name == 'nt':
        # a junction needs no admin rights (a symlink does)
        if subprocess.run(['cmd', '/c', 'mklink', '/J', dst, src], capture_output=True).returncode == 0:
            return 'junction'
    else:
        try:
            os.symlink(os.path.join('common', 'assets'), dst)
            return 'symlink'
        except OSError:
            pass
    shutil.copytree(src, dst)
    return 'copy'


def status():
    stamp = None
    if os.path.isfile(STAMP):
        try:
            with open(STAMP, encoding='utf-8') as f:
                stamp = json.load(f)
        except (OSError, ValueError):
            stamp = None
    return {
        'python': platform.python_version(),
        'repo': os.path.isfile(os.path.join(REPO, 'inference', 'scripts', 'inference_psd.py')),
        'venv': os.path.isfile(venv_python()),
        'installed': bool(stamp) and stamp.get('requirements') == requirements_hash(),
        'gpu': gpu(),
    }


def setup(force=False):
    v = sys.version_info
    if v < (3, 10) or v >= (3, 14):
        raise SystemExit(f'Python {platform.python_version()} 로는 안 됩니다. Python 3.12를 설치하고 그 python으로 실행하세요 (3.10~3.13 가능)')
    if not os.path.isfile(os.path.join(REPO, 'inference', 'scripts', 'inference_psd.py')):
        say('① see-through 소스 받기 (git submodule)')
        run(['git', 'submodule', 'update', '--init', '--', 'third_party/see-through'], cwd=ROOT)
    st = status()
    if st['installed'] and not force:
        return
    g = st['gpu']
    if not g:
        say('\n※ NVIDIA GPU를 찾지 못했습니다 (nvidia-smi). 드라이버를 설치했는지 확인하세요. 설치는 계속합니다.')
    if not os.path.isfile(venv_python()) or force:
        say('② 전용 Python 환경 만들기 (seethrough/.venv)')
        run([sys.executable, '-m', 'venv', '--clear', VENV] if force else [sys.executable, '-m', 'venv', VENV])
    py = venv_python()
    run([py, '-m', 'pip', 'install', '-q', '--upgrade', 'pip'])
    say('③ PyTorch (CUDA 12.8) 설치 — 2~3GB')
    run([py, '-m', 'pip', 'install', *TORCH, '--index-url', TORCH_INDEX])
    say('④ see-through 추론에 필요한 패키지 설치')
    req = os.path.join(WORKDIR, 'requirements.capsule.txt')
    os.makedirs(WORKDIR, exist_ok=True)
    with open(os.path.join(REPO, 'requirements.txt'), encoding='utf-8') as f:
        text = filtered_requirements(f.read())
    with open(req, 'w', encoding='utf-8') as f:
        f.write(text)
    # requirements.txt has "-e ./common", so pip runs inside the see-through folder
    run([py, '-m', 'pip', 'install', '-r', req, '-r', 'requirements-inference-bnb.txt'], cwd=REPO)
    how = link_assets()
    say(f'⑤ assets 연결: {how}')
    say('⑥ 그림 다듬기 (배경 지우기) 준비')
    run([py, '-m', 'pip', 'install', '-q', *EXTRA])
    run([py, '-c', 'from huggingface_hub import hf_hub_download; print(hf_hub_download("skytnt/anime-seg", "isnetis.onnx"))'])
    run([py, '-c', 'import torch; print("torch", torch.__version__, "CUDA", torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else "")'])
    with open(STAMP, 'w', encoding='utf-8') as f:
        json.dump({'requirements': requirements_hash(), 'python': platform.python_version(), 'at': time.strftime('%Y-%m-%d %H:%M')}, f)
    say('설치 완료\n')


def port_free(port):
    with socket.socket() as s:
        try:
            s.bind(('127.0.0.1', port))
            return True
        except OSError:
            return False


def start_editor():
    """serve.py on :8000 unless something already listens there (npm start in another window)."""
    if not port_free(EDITOR_PORT):
        say(f'편집기는 이미 열려 있습니다: http://127.0.0.1:{EDITOR_PORT}/')
        return None
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, 'serve.py'), '--port', str(EDITOR_PORT), '--no-seethrough'], cwd=ROOT)
    say(f'편집기: http://127.0.0.1:{EDITOR_PORT}/')
    return proc


def main(argv=None):
    ap = argparse.ArgumentParser(description='see-through on this GPU PC: setup + conversion server + editor')
    ap.add_argument('--check', action='store_true', help='show what is installed and exit')
    ap.add_argument('--setup-only', action='store_true')
    ap.add_argument('--reinstall', action='store_true', help='rebuild seethrough/.venv')
    ap.add_argument('--lan', action='store_true', help='listen on the network with a token (use from a laptop)')
    ap.add_argument('--no-editor', action='store_true', help='do not start the editor / open the browser')
    ap.add_argument('--mode', default='auto', choices=['auto', 'full', 'offload', 'nf4'])
    ap.add_argument('--resolution', type=int, default=0)
    ap.add_argument('--port', type=int, default=SERVER_PORT)
    args = ap.parse_args(argv)

    if args.check:
        st = status()
        g = st['gpu']
        say(json.dumps(st, ensure_ascii=False, indent=1))
        sys.path.insert(0, HERE)
        import server  # noqa: E402
        say('자동 모드: ' + server.pick_mode('auto', g) + (f" ({g['name']} {g['vram_mb']}MB)" if g else ' (GPU 없음)'))
        return 0
    setup(force=args.reinstall)
    if args.setup_only:
        return 0
    if not port_free(args.port):
        raise SystemExit(f'포트 {args.port}을(를) 이미 쓰고 있습니다. 변환 서버가 이미 떠 있지 않은지 확인하세요 (--port로 바꿀 수 있음)')

    editor = None if args.no_editor else start_editor()
    sys.path.insert(0, HERE)
    import server  # noqa: E402
    sargs = ['--repo', REPO, '--python', venv_python(), '--workdir', WORKDIR, '--port', str(args.port), '--mode', args.mode]
    if args.resolution:
        sargs += ['--resolution', str(args.resolution)]
    if args.lan:
        sargs += ['--host', '0.0.0.0']   # random token, printed as a connection code
        say('LAN 모드: 아래 연결 코드의 127.0.0.1을 이 PC의 IP로 바꿔 노트북 편집기에 붙여넣으세요')
    else:
        sargs += ['--token', '']
        for o in EDITOR_ORIGINS:
            sargs += ['--allow-origin', o]
    if editor and not args.lan:
        threading.Timer(2.5, lambda: webbrowser.open(f'http://127.0.0.1:{EDITOR_PORT}/')).start()
    say('그림을 편집기 화면에 놓으면 이 PC의 GPU로 PSD를 만듭니다. 끝내려면 Ctrl+C')
    try:
        server.main(sargs)
    finally:
        if editor:
            editor.terminate()
    return 0


if __name__ == '__main__':
    sys.exit(main())
