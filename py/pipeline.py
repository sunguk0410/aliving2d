"""
v2 pipeline: one picture -> model bundle, step by step, every step's result kept in the job folder so a step
can be run again without the ones before it. Like a Live2D artisan's single large base drawing: one waist-up
base picture, split twice - whole (body) and its head enlarged (face in detail) - and put back together.

  prepare   background removal, main character only, white 3:4 (seethrough/prepare.py)
  base      GPT: the same character as a Live2D base illustration: waist-up, frontal, arms a little away from
            the body, hair behind the shoulders, neutral face
  upscale   anime upscaler x2
  body      see-through on the whole base picture -> body PSD. Through the local conversion server when it
            runs (it queues GPU work, so nothing else uses the GPU at the same time), else run directly
  headcrop  square around the head from the body PSD's face, enlarged -> head.png
  head      see-through on head.png -> head PSD (the face in detail)
  mouth     GPT: head.png with the mouth open           } while `head` runs (no GPU)
  smile     GPT: head.png with smiling closed eyes ^ ^   }
  ears      GPT: head.png with the hair over the ears    }
  earsplit  see-through on ears.png, only when an ear peeks out between the locks (hair_cover.ear_peek) or the
            job's option `earCover` is true; `earCover` false skips both
  rig       face rig on the head + body parts, composed into bundle v2 in bundles/<job id> (compose.py)

Job folder: work/<id>/ with input.*, status.json and every step's files.

  python py/pipeline.py <job dir> [--from STEP]
"""
import argparse
import http.client
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
sys.path.insert(0, HERE)

STEPS = [
    ('prepare', '그림 다듬기'),
    ('base', '상반신 원화 (GPT)'),
    ('upscale', '선명하게 키우기'),
    ('body', '몸 파츠 (see-through)'),
    ('headcrop', '머리 크롭'),
    ('head', '얼굴 파츠 (see-through)'),
    ('mouth', '입 벌린 그림 (GPT)'),
    ('smile', '웃는 눈 그림 (GPT)'),
    ('ears', '귀 덮은 머리 그림 (GPT)'),
    ('earsplit', '귀 덮은 머리 파츠 (see-through)'),
    ('rig', '리깅 · 합치기 → 모델'),
]
KEYS = [k for k, _ in STEPS]
# what has to be made again when a step is made again (prepare / base / upscale: everything after them)
DEPENDS = {'body': {'headcrop', 'head', 'mouth', 'smile', 'ears', 'earsplit', 'rig'},
           'headcrop': {'head', 'mouth', 'smile', 'ears', 'earsplit', 'rig'},
           'head': {'rig'}, 'mouth': {'rig'}, 'smile': {'rig'}, 'ears': {'earsplit', 'rig'}, 'earsplit': {'rig'},
           'rig': set()}

PROMPTS = {
    'base': (
        'Redraw this exact same anime character as a Live2D model base illustration (a rigging-ready standing '
        'picture):\n'
        '- waist-up, the whole upper body in the frame with a small margin, centered, plain pure white background\n'
        '- standing straight, body and face toward the viewer (frontal, symmetric, head not tilted), eyes open '
        'looking at the viewer, mouth closed, neutral expression\n'
        '- both arms fully visible, hanging down relaxed and held slightly away from the body (a small gap between '
        'each arm and the waist), hands open and visible, nothing held\n'
        '- the hair falls behind the shoulders or beside the body so it does not cover the arms or the hands; the '
        'bangs stay as they are\n'
        '- keep everything about the character identical: art style, line art, coloring and shading, face, eye '
        'shape and eye color, hairstyle, hair length and color, outfit and accessories\n'
        'No text, no other people, no props.'),
    'mouth': (
        'Redraw this exact same picture with ONE change only: the mouth is open as when saying "ah" (a relaxed, '
        'natural open mouth: about as wide as the closed mouth, a little taller than wide), showing the upper teeth, '
        'the tongue and the inside of the mouth, drawn in the same anime style as the rest of the face.\n'
        'Everything else must stay pixel-identical: the same head position and angle, same face shape and jaw, same '
        'eyes, eyebrows, nose, hair, ears, neck, clothes, lighting, framing and background. Do not move or redraw '
        'anything except the mouth. No text.'),
    'smile': (
        'Redraw this exact same picture with ONE change only: both eyes are closed in a happy smile, drawn as the '
        'classic anime smiling closed eyes "^ ^" - each eye is an upward arch made by the upper eyelashes (the middle '
        'of the arch high, both ends lower), in the same eyelash style and color as now, with the lower lashes '
        'hidden.\nEverything else must stay pixel-identical: same head position and angle, same face, eyebrows, '
        'nose, the mouth stays closed exactly as it is, same hair, ears, neck, clothes, lighting, framing and '
        'background. Do not move or redraw anything except the eyes. No text.'),
    'ears': (
        'Redraw this exact same picture with ONE change only: the ears are completely hidden under the hair. Where an '
        'ear shows now, draw the hair falling over it instead - the same strands continuing down naturally, in the '
        'same hair color, shading and line style, so no part of either ear is visible.\n'
        'Everything else must stay pixel-identical: same head position and angle, same face, eyes, eyebrows, nose, '
        'mouth, the same bangs and the same outline of the hair, neck, clothes, lighting, framing and background. '
        'Do not move or redraw anything except the hair over the ears. No text.'),
}
OUT = {'prepare': 'prepared.png', 'base': 'base.png', 'upscale': 'base_2x.png', 'body': 'body.psd',
       'headcrop': 'head.png', 'head': 'head.psd', 'mouth': 'mouth.png', 'smile': 'smile.png', 'ears': 'ears.png',
       'earsplit': 'ears.psd', 'rig': 'bundle.json'}


class Job:
    def __init__(self, d):
        self.dir = d
        self.id = os.path.basename(os.path.normpath(d))
        self.path = os.path.join(d, 'status.json')
        self.lock = threading.Lock()
        try:
            self.st = json.load(open(self.path, encoding='utf-8'))
        except (OSError, ValueError):
            self.st = {'id': self.id, 'created': time.time()}
        self.st.setdefault('steps', {})
        for k, label in STEPS:
            self.st['steps'].setdefault(k, {'status': 'waiting'})
            self.st['steps'][k]['label'] = label
        # the flow's order first (a job from an older flow may list its steps differently)
        old = self.st['steps']
        self.st['steps'] = {k: old[k] for k in KEYS}
        self.st['steps'].update({k: v for k, v in old.items() if k not in KEYS})

    def f(self, name):
        return os.path.join(self.dir, name)

    def set(self, key, **kw):
        with self.lock:
            self.st['steps'][key].update(kw)
            self.st['updated'] = time.time()
            tmp = self.path + '.tmp'
            json.dump(self.st, open(tmp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
            os.replace(tmp, self.path)

    def top(self, **kw):
        with self.lock:
            self.st.update(kw)
        self.set(KEYS[0])

    def run(self, key, fn):
        if self.st['steps'][key].get('status') == 'done' and os.path.exists(self.f(OUT[key])):
            return True
        self.set(key, status='running', started=time.time(), error=None, note=None)
        try:
            note = fn()
            self.set(key, status='done', finished=time.time(), out=OUT[key], note=note)
            return True
        except Exception as err:  # noqa: BLE001 - shown on the dashboard
            traceback.print_exc()
            self.set(key, status='error', finished=time.time(), error=str(err)[-500:])
            return False


def venv_py():
    return os.path.join(ROOT, 'seethrough', '.venv', 'Scripts' if os.name == 'nt' else 'bin',
                        'python.exe' if os.name == 'nt' else 'python')


def input_file(job):
    for n in os.listdir(job.dir):
        if n.startswith('input.'):
            return job.f(n)
    raise RuntimeError('올린 그림이 없습니다')


def step_prepare(job):
    sys.path.insert(0, os.path.join(ROOT, 'seethrough'))
    import prepare
    info = prepare.prepare(input_file(job), job.f('prepared.png'))
    return None if not isinstance(info, dict) else {k: info[k] for k in list(info)[:4]}


def gpt(job, key, src, size='1024x1024'):
    import gpt_image
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.open(src).convert('RGB').save(buf, 'PNG')
    outs = gpt_image.edit(buf.getvalue(), PROMPTS[key], size, 1)
    open(job.f(OUT[key]), 'wb').write(outs[0])
    if key == 'ears':                               # lined up on the head crop, so its split lines up with head.psd
        from hair_cover import align_covered
        return {'shift': align_covered(src, job.f(OUT[key]))}


def step_upscale(job):
    import upscale
    from PIL import Image
    upscale.upscale(Image.open(job.f('base.png')), 2).save(job.f('base_2x.png'))
    upscale.unload()


def step_headcrop(job):
    from compose import head_box, crop_head
    from PIL import Image
    box = head_box(job.f('body.psd'), Image.open(job.f('base_2x.png')).size)
    json.dump(box, open(job.f('head_box.json'), 'w'))
    crop_head(job.f('base_2x.png'), box, job.f('head.png'))
    return box


SEETHROUGH_PORT = 7860


def server_health():
    try:
        c = http.client.HTTPConnection('127.0.0.1', SEETHROUGH_PORT, timeout=2)
        c.request('GET', '/health')
        r = c.getresponse()
        data = json.loads(r.read() or b'null')
        c.close()
        return data if r.status == 200 and isinstance(data, dict) and data.get('ok') else None
    except (OSError, ValueError, http.client.HTTPException):
        return None


def run_seethrough(src, dst_psd, progress=lambda **kw: None, work=None):
    """see-through on one picture -> PSD. Through the local conversion server when it runs (it queues GPU work),
    else directly here behind a lock file (one GPU job at a time on this PC)."""
    if server_health():
        body = open(src, 'rb').read()
        c = http.client.HTTPConnection('127.0.0.1', SEETHROUGH_PORT, timeout=30)
        c.request('POST', '/jobs', body, {'X-Prepare': '0', 'X-Filename': os.path.basename(src), 'Content-Type': 'image/png'})
        r = c.getresponse()
        data = json.loads(r.read() or b'{}')
        c.close()
        if r.status != 202:
            raise RuntimeError('변환 서버가 거절했습니다: ' + str(data.get('error')))
        sid = data['id']
        while True:
            time.sleep(5)
            c = http.client.HTTPConnection('127.0.0.1', SEETHROUGH_PORT, timeout=10)
            c.request('GET', f'/jobs/{sid}')
            r = c.getresponse()
            st = json.loads(r.read() or b'{}')
            c.close()
            progress(progress=st.get('phase'), percent=st.get('percent'))
            if st.get('status') == 'done':
                break
            if st.get('status') in ('error', 'cancelled'):
                raise RuntimeError('see-through 실패: ' + str(st.get('error')))
        c = http.client.HTTPConnection('127.0.0.1', SEETHROUGH_PORT, timeout=120)
        c.request('GET', f'/jobs/{sid}/psd')
        r = c.getresponse()
        if r.status != 200:
            raise RuntimeError('PSD를 받지 못했습니다')
        with open(dst_psd, 'wb') as fh:
            shutil.copyfileobj(r, fh)
        c.close()
        return {'via': 'server'}
    lock = os.path.join(ROOT, '.local', 'gpu.lock')
    os.makedirs(os.path.dirname(lock), exist_ok=True)
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            break
        except FileExistsError:
            progress(progress='GPU 차례를 기다리는 중')
            time.sleep(10)
    try:
        repo = os.path.join(ROOT, 'third_party', 'see-through')
        out = work or (os.path.splitext(dst_psd)[0] + '_st')
        cmd = [venv_py(), 'inference/scripts/inference_psd_quantized.py', '--no_group_offload', '--srcp', os.path.abspath(src),
               '--save_dir', os.path.abspath(out), '--save_to_psd']
        env = dict(os.environ, PYTHONUNBUFFERED='1', PYTHONIOENCODING='utf-8')
        flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0          # no console window popping up
        with open(os.path.splitext(dst_psd)[0] + '.log', 'w', encoding='utf-8') as log:
            r = subprocess.run(cmd, cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
        if r.returncode != 0:
            log_text = open(os.path.splitext(dst_psd)[0] + '.log', encoding='utf-8', errors='replace').read()
            if 'os error 1455' in log_text or 'paging file' in log_text.lower() or 'CUDA out of memory' in log_text:
                raise RuntimeError('메모리가 부족합니다. 게임 같은 큰 프로그램을 닫고 「여기부터 다시」를 눌러 주세요 '
                                   '(see-through는 RAM·가상 메모리를 많이 씁니다)')
            raise RuntimeError('see-through 실패 (로그 참고: ' + os.path.basename(os.path.splitext(dst_psd)[0]) + '.log)')
        name = os.path.splitext(os.path.basename(src))[0] + '.psd'
        shutil.copy(os.path.join(out, name), dst_psd)
        return {'via': 'direct'}
    finally:
        try:
            os.remove(lock)
        except OSError:
            pass


def step_body(job):
    # the original size: see-through works at its own resolution, a 2x picture only costs memory and time
    # (the face gets its detail from the upscaled head crop)
    return run_seethrough(job.f('base.png'), job.f('body.psd'), lambda **kw: job.set('body', **kw), job.f('st_body'))


def step_head(job):
    return run_seethrough(job.f('head.png'), job.f('head.psd'), lambda **kw: job.set('head', **kw), job.f('st_head'))


def step_earsplit(job):
    # the second picture of the head (Live2D: the hair drawn whole over the ears): the model's hair comes from it
    return run_seethrough(job.f('ears.png'), job.f('ears.psd'), lambda **kw: job.set('earsplit', **kw),
                          job.f('st_ears'))


def options(job):
    try:
        return json.load(open(job.f('options.json'), encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def ear_cover(job):
    """Use the covered-ears drawing? The option `earCover` (true / false), else automatic: only when an ear peeks
    out between the locks (hair_cover.ear_peek, kept in ear_cover.json while head.psd stays the same)."""
    mode = options(job).get('earCover')
    if isinstance(mode, bool):
        return {'cover': mode, 'mode': 'on' if mode else 'off'}
    if not os.path.exists(job.f('head.psd')):
        return {'cover': True, 'mode': 'auto'}
    stamp = os.path.getmtime(job.f('head.psd'))
    try:
        got = json.load(open(job.f('ear_cover.json')))
        if got.get('stamp') == stamp:
            return got
    except (OSError, ValueError):
        pass
    from hair_cover import ear_peek, needs_cover
    peeks = ear_peek(job.f('head.psd'), job.f('head.png'))
    got = {'cover': needs_cover(peeks), 'mode': 'auto', 'peek': peeks, 'stamp': stamp}
    json.dump(got, open(job.f('ear_cover.json'), 'w'))
    return got


def step_rig(job):
    from compose import compose
    have = lambda n: job.f(n) if os.path.exists(job.f(n)) else None
    out = os.path.join(ROOT, 'bundles', job.id)
    if os.path.isdir(out):
        shutil.rmtree(out)
    box = json.load(open(job.f('head_box.json')))
    opts = options(job)
    if not ear_cover(job)['cover']:                 # the picture's own hair over the ears
        have = lambda n, have=have: None if n in ('ears.png', 'ears.psd') else have(n)
    m, info = compose(job.f('body.psd'), job.f('base_2x.png'), job.f('head.psd'), box, job.f('head.png'), out,
                      have('mouth.png'), have('smile.png'), ears=opts.get('ears', True), ears_covered=have('ears.png'),
                      ears_split=have('ears.psd'),
                      extras=opts.get('extras') or [])
    json.dump({'bundle': f'bundles/{job.id}/model.json', 'parts': len(m['parts'])},
              open(job.f('bundle.json'), 'w'))
    try:                                            # layer previews for the dashboards (layer_preview.py)
        from layer_preview import write_layers
        write_layers(job.dir)
    except Exception:  # noqa: BLE001 - previews only
        traceback.print_exc()
    return {'parts': len(m['parts']), 'face_scale': round(info['k'], 3),
            'expressions': len(m.get('expressions', [])), 'motions': len(m.get('motions', [])),
            'arms': bool(m.get('arms'))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dir')
    ap.add_argument('--from', dest='start', default=None, help='run this step and the ones after it again')
    a = ap.parse_args()
    # jobs from before the waist-up base used other step names
    a.start = {'front': 'base', 'parts': 'body'}.get(a.start, a.start)
    if a.start is not None and a.start not in KEYS:
        ap.error('unknown step ' + a.start)
    job = Job(a.dir)
    for k in [k for k in job.st['steps'] if k not in KEYS]:      # steps of the older flow
        del job.st['steps'][k]
    if a.start:
        redo = {a.start}
        if a.start in ('prepare', 'base', 'upscale'):
            redo |= set(KEYS[KEYS.index(a.start):])
        else:
            redo |= DEPENDS.get(a.start, set())
        for k in redo:
            job.st['steps'][k]['status'] = 'waiting'
    job.top(state='running', pid=os.getpid())
    ok = job.run('prepare', lambda: step_prepare(job)) and \
        job.run('base', lambda: gpt(job, 'base', job.f('prepared.png'), '1024x1536')) and \
        job.run('upscale', lambda: step_upscale(job)) and \
        job.run('body', lambda: step_body(job)) and \
        job.run('headcrop', lambda: step_headcrop(job))
    if ok:
        # GPT pictures of the head while see-through splits it (no GPU); the rig works without them if they fail
        drawn = ('mouth', 'smile') + (() if options(job).get('earCover') is False else ('ears',))
        side = [threading.Thread(target=job.run, args=(k, (lambda k=k: gpt(job, k, job.f('head.png'))))) for k in drawn]
        for t in side:
            t.start()
        ok = job.run('head', lambda: step_head(job))
        for t in side:
            t.join()
        # one GPU job at a time: the covered-ears split after the head's; the rig works without it if it fails
        # ... and only when the ear peeks out between the locks (or the option says so)
        if ok:
            try:
                ec = ear_cover(job)
            except Exception:  # noqa: BLE001 - the rig decides again
                traceback.print_exc()
                ec = {'cover': True, 'mode': 'auto'}
            why = {'off': '옵션: 안 씀', 'on': '옵션: 씀'}.get(ec['mode']) or                 ('자동: 귀가 머리 사이로 보여서 씀' if ec['cover'] else '자동: 귀가 드러나 있거나 이미 가려져 있어 원본 머리를 씀')
            for k in ('ears', 'earsplit') if not ec['cover'] else ():
                if k == 'earsplit' or ec['mode'] == 'off':
                    job.set(k, status='skipped', error=None, note={'why': why, 'peek': ec.get('peek')})
            if ec['cover'] and os.path.exists(job.f('ears.png')):
                job.run('earsplit', lambda: step_earsplit(job))
                job.set('earsplit', why=why)
            else:
                job.set('earsplit', why=why)
        ok = ok and job.run('rig', lambda: step_rig(job))
    job.top(state='done' if ok else 'error', pid=None)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'seethrough':      # python pipeline.py seethrough <png> <psd>
        print(json.dumps(run_seethrough(sys.argv[2], sys.argv[3], lambda **kw: print(kw, flush=True))))
    else:
        main()
