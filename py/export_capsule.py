"""
Export for the capsule app: one zip that plays on its own.

  <name>/model/        the bundle (model.json, parts/, expressions/, motions/ ...)  -> modelJsonUrl = model/model.json
  <name>/engine/       engine.js + player.js (WebGL2, no Cubism SDK) + reactions.default.json
  <name>/index.html    a page that plays the model (breathing, blinking, looking around, the reaction buttons)
  <name>/README.txt    how the capsule front uses it

  python py/export_capsule.py bundles/<name> out.zip
"""
import io
import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = ('engine.js', 'player.js', 'reactions.default.json')

README = """Aliving2D 모델 - 캡슐용 묶음

여는 법
  이 폴더를 아무 정적 서버로 열고 index.html 을 엽니다 (파일을 바로 열면 브라우저가 model.json 을 못 읽습니다).
  예: python -m http.server 8000  ->  http://127.0.0.1:8000/index.html

캡슐 프런트에 넣기
  <script src="engine/engine.js"></script>
  <script src="engine/player.js"></script>
  const p = await CapsuleV2Player.create(canvas, 'model/model.json', { reactions: 'engine/reactions.default.json' });
  p.track({ ParamAngleX: .., ParamAngleY: .., ParamEyeLOpen: .. })   // 카메라 값 (Live2D 표준 ID, Live2D 단위)
  p.react(trigger_type, intensity)                                    // 백엔드 반응
  p.setExpression(name) / p.playMotion(name) / p.talk(ms) / p.lookAt(x, y)

모델 계약 (백엔드)
  modelJsonUrl = .../model/model.json   표정 = model.json 의 expressions[].name   모션 = motions[].name
  이 형식은 Cubism .moc3 가 아니라 Aliving2D 자체 형식입니다. Live2D SDK 없이 engine.js 로 그립니다.
"""


def page(name):
    """player/index.html, pointed at the files in the zip."""
    s = open(os.path.join(ROOT, 'player', 'index.html'), encoding='utf-8').read()
    s = s.replace('../engine/', 'engine/')
    s = re.sub(r"q\.get\('model'\) \|\| '[^']*'", "q.get('model') || 'model/model.json'", s)
    s = s.replace('<title>캡슐 플레이어 시험</title>', f'<title>{name}</title>')
    return s


def make_zip(bundle, name=None):
    """The zip as bytes."""
    bundle = os.path.abspath(bundle)
    if not os.path.exists(os.path.join(bundle, 'model.json')):
        raise FileNotFoundError('model.json 이 없습니다: ' + bundle)
    name = re.sub(r'[^\w.-]+', '_', name or os.path.basename(bundle)) or 'model'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for dirpath, _, files in os.walk(bundle):
            for f in files:
                full = os.path.join(dirpath, f)
                rel = os.path.relpath(full, bundle).replace('\\', '/')
                # PNGs are already compressed
                z.write(full, f'{name}/model/{rel}', zipfile.ZIP_STORED if f.endswith('.png') else zipfile.ZIP_DEFLATED)
        for f in ENGINE:
            z.write(os.path.join(ROOT, 'engine', f), f'{name}/engine/{f}')
        z.writestr(f'{name}/index.html', page(name))
        z.writestr(f'{name}/README.txt', README)
    return buf.getvalue()


if __name__ == '__main__':
    data = make_zip(sys.argv[1])
    open(sys.argv[2], 'wb').write(data)
    m = json.load(open(os.path.join(sys.argv[1], 'model.json'), encoding='utf-8'))
    print(sys.argv[2], f'{len(data) / 1e6:.1f} MB', len(m['parts']), 'parts')
