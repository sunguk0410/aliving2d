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
# Capsule Model Studio — see-through 변환 서버 (Colab)

그림 한 장을 **파츠 PSD**로 나누는 [see-through](https://github.com/shitagaki-lab/see-through)(Apache-2.0)를 Colab GPU에서 돌리고,
로컬 편집기(`npm start` → http://127.0.0.1:8000/)가 접속할 수 있게 임시 주소를 엽니다.

1. **런타임 → 런타임 유형 변경 → T4 GPU** (무료) 또는 L4/A100
2. **런타임 → 모두 실행** (설치 5~10분, 첫 변환 때 가중치 수 GB 다운로드)
3. 마지막 셀에 나오는 **연결 코드**(`https://….trycloudflare.com#토큰`)를 편집기 시작 화면에 붙여넣기
4. 편집기에 그림을 넣으면 여기서 변환되고, 끝나면 PSD가 편집기로 돌아가 자동 리깅됩니다

마지막 셀은 계속 실행 중이어야 합니다 (멈추면 연결이 끊김). 연결 코드는 실행할 때마다 바뀝니다.
'''),
        code('''
#@title 설정
MODE = "auto"  #@param ["auto", "nf4", "offload", "full"]
#@markdown auto: T4 같은 bf16 미지원·소형 GPU는 nf4(약 8GB), 12~20GB는 offload, 20GB 이상은 full
RESOLUTION = 1280  #@param {type:"integer"}
#@markdown 해상도를 1024로 낮추면 빠르고 메모리를 덜 씁니다
TEST_RUN = True  #@param {type:"boolean"}
#@markdown 서버를 열기 전에 예제 그림으로 한 번 변환해 봅니다 (가중치 다운로드 포함)
''', title=True),
        code('!nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv || echo "GPU가 없습니다: 런타임 유형을 GPU로 바꾸세요"'),
        code(f'''
#@title see-through 설치
import os, subprocess
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
#@title 예제 그림으로 시험 변환 (TEST_RUN)
import glob, time
if TEST_RUN:
    script = "inference/scripts/inference_psd_quantized.py" if MODE in ("auto", "nf4") else "inference/scripts/inference_psd.py"
    extra = "--group_offload" if MODE == "offload" else ""
    t0 = time.time()
    !python {script} --srcp assets/test_image.png --save_dir /content/st_test --save_to_psd --resolution {RESOLUTION} {extra}
    psds = glob.glob("/content/st_test/*.psd")
    print(f"{time.time() - t0:.0f}초", psds or "PSD가 만들어지지 않았습니다 — 위 로그를 확인하세요")
''', title=True),
        code('%%writefile /content/capsule_seethrough_server.py\n' + server),
        code('''
#@title 서버 열기 — 아래 "연결 코드"를 편집기에 붙여넣기 (이 셀은 계속 실행 상태로 둡니다)
!python /content/capsule_seethrough_server.py --repo {REPO} --mode {MODE} --resolution {RESOLUTION} --workdir /content/capsule_jobs --tunnel
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
