"""
Edits a v2 model from a request in plain words (the editor's 「요청」 panel). Standard library only (serve.py).

  plan(request, model, history, job)  the user's OpenAI key -> {'reply': str, 'actions': [...]}, actions the editor
                                      carries out:
      set_params       {params: {id: value}}             pose / face now (preview)
      save_expression  {name, label, params}              kept as an expression (serve.py /api/v2/expressions)
      play_motion      {name}
      scale_param      {param, factor}                    how far a parameter moves the model (keyforms x factor)
      set_options      {extras?: [...], ears?: bool}      rig options -> the rig step runs again (1-2 min)
  scale(bundle_dir, param, factor)    rewrites model.json (backup first), keyform displacements x factor
  undo(bundle_dir)                    puts the last backup back
"""
import glob
import json
import os
import shutil
import time
import urllib.error
import urllib.request

import redraw

ENDPOINT = 'https://api.openai.com/v1/chat/completions'
MODEL = 'gpt-5.4-mini'
EXTRAS = {'physics': '머리카락·치마 흔들림 (물리)', 'body': '몸 회전·숨쉬기', 'arms': '팔 (어깨·팔꿈치·손목)',
          'fx': '효과 파츠 (홍조·눈물·땀·분노 마크·하트/반짝 눈)', 'presets': '기본 표정 27개 세트'}
PNAME = {'angleX': '고개 좌우', 'angleY': '고개 위아래', 'angleZ': '고개 기울이기', 'eyeX': '시선 좌우', 'eyeY': '시선 위아래',
         'eyeOpenL': '왼눈 뜨기', 'eyeOpenR': '오른눈 뜨기', 'eyeSmile': '눈웃음 (1 = ^ ^)', 'mouthOpen': '입 벌리기',
         'mouthForm': '입꼬리 (-1 시무룩 … 1 웃음)', 'mouthWide': '입 너비', 'browLY': '왼 눈썹 높이', 'browRY': '오른 눈썹 높이',
         'browLAngle': '왼 눈썹 각도 (+ 화남)', 'browRAngle': '오른 눈썹 각도', 'eyeBall': '눈동자 크기', 'cheek': '홍조',
         'tear': '눈물', 'gloom': '어두운 세로선', 'sweat': '땀', 'anger': '분노 마크', 'sparkle': '반짝 눈', 'heartEyes': '하트 눈',
         'blankEyes': '흰 눈', 'bodyX': '몸 좌우 회전', 'bodyY': '몸 앞뒤', 'bodyZ': '몸 기울이기', 'breath': '숨',
         'armLX': '왼팔 X', 'armLY': '왼팔 Y', 'armRX': '오른팔 X', 'armRY': '오른팔 Y', 'handL': '왼손목', 'handR': '오른손목'}

SYSTEM = """너는 Live2D 방식 2D 캐릭터 모델을 고치는 리깅 도우미다. 고객의 요청을 아래 동작들로 바꿔 JSON으로만 답한다.
{"reply": "고객에게 한국어로 1~2문장: 무엇을 했는지", "actions": [ ... ]}
동작:
- {"type":"set_params","params":{"<id>":값}}  지금 얼굴·자세를 바꿔 보여 줌 (미리보기). 값은 각 파라미터 범위 안.
- {"type":"save_expression","name":"영문소문자_이름","label":"한국어 이름","params":{...}}  표정으로 저장. 표정은 얼굴 파라미터만 (angle/body/arm/breath 제외). 표정을 만들라는 요청이면 set_params와 save_expression을 같이 낸다.
- {"type":"play_motion","name":"<모션 이름>"}  있는 모션만.
- {"type":"scale_param","param":"<id>","factor":0.5~1.8}  그 파라미터가 모델을 움직이는 정도를 키우거나 줄임 (예: 고개가 더 많이 돌아가게 = angleX 1.3). 키폼이 있는 파라미터만.
- {"type":"set_options","extras":[...],"ears":true/false}  리깅을 다시 해야 하는 기능 켜기/끄기. extras는 켜 둘 전체 목록. 바꾸려는 것만 넣는다.
규칙: 모델에 없는 파라미터·모션은 쓰지 않는다. 할 수 없는 요청이면 actions를 비우고 reply에 이유와 대안을 쓴다. 과하지 않게, 애니 캐릭터답게 자연스러운 값을 고른다."""


def describe(model, job):
    keyed = {}
    for p in model.get('parts', []):
        for pid in list(p.get('keys', {})) + list(p.get('opacity', {})):
            keyed[pid] = keyed.get(pid, 0) + 1
    params = [{'id': p['id'], '이름': PNAME.get(p['id'], p['id']), 'min': p['min'], 'max': p['max'], 'default': p.get('default', 0),
               '키폼': p['id'] in keyed} for p in model.get('params', []) if not p.get('hidden')]
    return {
        '파라미터': params,
        '표정': [e['name'] + ' (' + e.get('label', '') + ')' for e in model.get('expressions', [])],
        '모션': [m['name'] + ' (' + m.get('label', '') + ')' for m in model.get('motions', []) if m.get('group') != 'Idle'],
        '리깅 옵션': {'켜진 extras': (job or {}).get('extras', []), '귀': (job or {}).get('ears', True), '선택지': EXTRAS,
                   '다시 리깅 가능': bool((job or {}).get('rerig'))},
    }


def plan(request, model, history=None, job=None, timeout=60):
    msgs = [{'role': 'system', 'content': SYSTEM},
            {'role': 'system', 'content': '이 모델: ' + json.dumps(describe(model, job), ensure_ascii=False)}]
    for h in (history or [])[-6:]:
        if h.get('role') in ('user', 'assistant') and isinstance(h.get('content'), str):
            msgs.append({'role': h['role'], 'content': h['content'][:2000]})
    msgs.append({'role': 'user', 'content': request[:2000]})
    body = json.dumps({'model': MODEL, 'messages': msgs, 'response_format': {'type': 'json_object'}}).encode()
    req = urllib.request.Request(ENDPOINT, body, {'Authorization': 'Bearer ' + redraw._key(), 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'OpenAI {e.code}: ' + e.read().decode('utf-8', 'replace')[:300]) from None
    out = json.loads(data['choices'][0]['message']['content'] or '{}')
    return clean(out, model, job)


def clean(out, model, job):
    """Only what this model has, in range: the editor carries the actions out as they come."""
    ranges = {p['id']: (p['min'], p['max']) for p in model.get('params', []) if not p.get('hidden')}
    keyed = {pid for p in model.get('parts', []) for pid in list(p.get('keys', {})) + list(p.get('opacity', {}))}
    motions = {m['name'] for m in model.get('motions', [])}
    clip = lambda pid, v: max(ranges[pid][0], min(ranges[pid][1], float(v)))
    acts = []
    for a in out.get('actions') or []:
        t = a.get('type') if isinstance(a, dict) else None
        if t in ('set_params', 'save_expression'):
            ps = {k: clip(k, v) for k, v in (a.get('params') or {}).items() if k in ranges and isinstance(v, (int, float))}
            if t == 'save_expression':
                ps = {k: v for k, v in ps.items() if not k.startswith(('angle', 'body', 'arm', 'hand', 'breath'))}
                name = ''.join(c for c in str(a.get('name', '')).lower().replace(' ', '_') if c.isalnum() or c in '_-')[:40]
                if ps and name:
                    acts.append({'type': t, 'name': name, 'label': str(a.get('label') or name)[:40], 'params': ps})
            elif ps:
                acts.append({'type': t, 'params': ps})
        elif t == 'play_motion' and a.get('name') in motions:
            acts.append({'type': t, 'name': a['name']})
        elif t == 'scale_param' and a.get('param') in keyed and isinstance(a.get('factor'), (int, float)):
            acts.append({'type': t, 'param': a['param'], 'factor': max(0.5, min(1.8, float(a['factor'])))})
        elif t == 'set_options' and (job or {}).get('rerig'):
            o = {}
            if isinstance(a.get('extras'), list):
                o['extras'] = sorted({x for x in a['extras'] if x in EXTRAS})
            if isinstance(a.get('ears'), bool):
                o['ears'] = a['ears']
            if o:
                acts.append({'type': t, **o})
    return {'reply': str(out.get('reply') or '')[:600], 'actions': acts}


def scale(bundle_dir, param, factor):
    f = os.path.join(bundle_dir, 'model.json')
    model = json.load(open(f, encoding='utf-8'))
    shutil.copy(f, f + time.strftime('.bak-%Y%m%d-%H%M%S'))
    n = 0
    for p in model['parts']:
        k = p.get('keys', {}).get(param)
        if k:
            k['disp'] = [[round(x * factor, 3) for x in d] for d in k['disp']]
            n += 1
    with open(f, 'w', encoding='utf-8') as fh:
        json.dump(model, fh, separators=(',', ':'))
    return n


def undo(bundle_dir):
    baks = sorted(glob.glob(os.path.join(bundle_dir, 'model.json.bak-*')))
    if not baks:
        return False
    shutil.move(baks[-1], os.path.join(bundle_dir, 'model.json'))
    return True
