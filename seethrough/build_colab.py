#!/usr/bin/env python3
"""
Builds seethrough/see_through_colab.ipynb with seethrough/server.py embedded,
so the notebook needs nothing from this (private) repo.

  python seethrough/build_colab.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SEE_THROUGH_REPO = 'https://github.com/shitagaki-lab/see-through.git'
SEE_THROUGH_COMMIT = 'df019de5129d6c4b406587a14c3501669441a783'   # same as third_party/see-through
# Not needed for inference (GUI, training, dev tools)
SKIP = ['PyQt6', 'PyQt6-Qt6', 'qtpy', 'lpips', 'convnext_perceptual_loss', 'ipykernel', 'pytest', 'Cython', 'wheel']


def md(text):
    return {'cell_type': 'markdown', 'metadata': {}, 'source': text.strip('\n').splitlines(True)}


def code(text, title=None):
    meta = {'cellView': 'form'} if title else {}
    return {'cell_type': 'code', 'metadata': meta, 'execution_count': None, 'outputs': [], 'source': text.strip('\n').splitlines(True)}


def build():
    server = open(os.path.join(HERE, 'server.py'), encoding='utf-8').read()
    skip_re = '|'.join(SKIP)
    cells = [
        md('''
# Capsule Model Studio — 그림 → 파츠 PSD (see-through, Colab)

그림 한 장을 **파츠 PSD**로 나누는 [see-through](https://github.com/shitagaki-lab/see-through)(Apache-2.0)를 Colab 무료 GPU에서 돌립니다.

1. **런타임 → 런타임 유형 변경 → T4 GPU**
2. **런타임 → 모두 실행** (설치 5~10분)
3. ② 셀에 **파일 선택** 버튼이 나오면 그림(PNG/JPG)을 고릅니다. 첫 변환 때는 가중치(수 GB)를 받느라 더 걸립니다
4. 끝나면 **PSD가 자동으로 다운로드**됩니다 → 편집기(`npm start` → http://127.0.0.1:8000/) 화면에 그 PSD를 놓으면 리깅됩니다
5. 다른 그림은 ② 셀만 다시 실행 (▶)

맨 아래 ③은 유료 Colab·GPU 컴퓨터용 자동 연결이라 기본으로 꺼져 있습니다.
'''),
        code('''
#@title 설정
MODE = "auto"  #@param ["auto", "nf4", "offload", "full"]
#@markdown auto: T4 같은 bf16 미지원·소형 GPU는 nf4(약 8GB), 12~20GB는 offload, 20GB 이상은 full
RESOLUTION = 1280  #@param {type:"integer"}
#@markdown 1024로 낮추면 빠르고 메모리를 덜 씁니다
''', title=True),
        code('!nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv || echo "GPU가 없습니다: 런타임 유형을 GPU로 바꾸세요"'),
        code(f'''
#@title ① see-through 설치
import os
REPO = "/content/see-through"
if not os.path.isdir(REPO):
    !git clone -q {SEE_THROUGH_REPO} {{REPO}}
%cd {{REPO}}
!git checkout -q {SEE_THROUGH_COMMIT}
!ln -sfn common/assets assets
!grep -v -E "^({skip_re})([=@ ]|$)" requirements.txt > /tmp/st-requirements.txt
!pip install -q -r /tmp/st-requirements.txt -r requirements-inference-bnb.txt
print("설치 완료")
''', title=True),
        code('''
#@title ② 그림 올리기 → PSD 받기 (다른 그림은 이 셀만 다시 실행)
import glob, os, re, subprocess, time
from google.colab import files

def pick_mode():
    out = subprocess.run(["nvidia-smi", "--query-gpu=memory.total,compute_cap", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True).stdout.split(",")
    try:
        vram, cc = float(out[0]), float(out[1])
    except (ValueError, IndexError):
        vram, cc = 0.0, 0.0
    if MODE != "auto":
        return MODE
    if cc < 8 or vram < 12000:
        return "nf4"
    return "offload" if vram < 20000 else "full"

mode = pick_mode()
script = "inference/scripts/inference_psd_quantized.py" if mode == "nf4" else "inference/scripts/inference_psd.py"
extra = "--group_offload" if mode == "offload" else ""
print(f"모드: {mode} — 그림을 고르세요")
uploaded = files.upload()
for name, data in uploaded.items():
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", os.path.splitext(name)[0]).strip("_") or "image"
    job = f"/content/capsule_jobs/{time.strftime('%H%M%S')}_{stem}"
    os.makedirs(job, exist_ok=True)
    src = os.path.join(job, stem + os.path.splitext(name)[1].lower())
    with open(src, "wb") as f:
        f.write(data)
    print(f"\\n{name}: 변환 시작 ({mode}, 해상도 {RESOLUTION})")
    t0 = time.time()
    !cd {REPO} && python {script} --srcp {src} --save_dir {job}/out --save_to_psd --resolution {RESOLUTION} {extra}
    psds = [p for p in glob.glob(f"{job}/out/*.psd") if not p.endswith("_depth.psd")]
    if not psds:
        print("실패: PSD가 만들어지지 않았습니다 — 위 로그를 확인하세요")
        continue
    print(f"완료 ({time.time() - t0:.0f}초) → {os.path.basename(psds[0])} 다운로드. 편집기 화면에 놓으세요")
    files.download(psds[0])
''', title=True),
        md('''
## ③ (선택) 자동 연결 — 유료 Colab · GPU 컴퓨터용

편집기에 그림을 넣으면 여기로 보내 변환하고 PSD를 바로 돌려받는 방식입니다. 임시 주소(터널)로 노트북 밖에서 접속하기 때문에
**무료 Colab에서는 규정상 금지**("bypassing the notebook UI to interact primarily via a web UI")라 기본으로 꺼 두었습니다.
컴퓨트 단위가 있는 유료 등급에서만 `USE_SERVER`를 켜세요. GPU 컴퓨터에서는 저장소의 `python seethrough/server.py`를 쓰면 됩니다.
'''),
        code('%%writefile /content/capsule_seethrough_server.py\n' + server),
        code('''
#@title 서버 열기 (USE_SERVER를 켠 경우만) — 나오는 "연결 코드"를 편집기에 붙여넣기
USE_SERVER = False  #@param {type:"boolean"}
if USE_SERVER:
    !python /content/capsule_seethrough_server.py --repo {REPO} --mode {MODE} --resolution {RESOLUTION} --workdir /content/capsule_server_jobs --tunnel
else:
    print("자동 연결은 꺼져 있습니다 (무료 Colab에서는 ② 셀을 쓰세요)")
''', title=True),
    ]
    nb = {'cells': cells, 'metadata': {'accelerator': 'GPU', 'colab': {'provenance': [], 'gpuType': 'T4'},
                                       'kernelspec': {'display_name': 'Python 3', 'name': 'python3'},
                                       'language_info': {'name': 'python'}},
          'nbformat': 4, 'nbformat_minor': 0}
    out = os.path.join(HERE, 'see_through_colab.ipynb')
    with open(out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(nb, f, ensure_ascii=False, indent=1)
        f.write('\n')
    return out


if __name__ == '__main__':
    print(build())
