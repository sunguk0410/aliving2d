# Capsule Model Studio

애니풍 캐릭터 그림으로 캡슐(CAPSULE)에서 쓸 2.5D 캐릭터 모델을 만드는 로컬 도구입니다.

```
애니풍 그림 ──(see-through)──▶ 파츠 PSD ──(자동 리깅 + 편집기에서 조정)──▶ 캡슐 모델 묶음 ──(engine/player.js)──▶ 캡슐에서 재생
```

- **자동 리깅**: PSD 레이어 이름(영어·일본어·see-through 출력)을 읽어서 메시 분할, 눈·입 개폐, 머리카락 물리, 기준점(앵커)을 자동으로 만듭니다.
- **편집기** (한국어): 탭 4개로 나뉩니다.
  - **점검**: 리깅 결과를 보고 기준점을 맞춥니다.
  - **움직여 보기**: 표정·자세·카메라로 미리 봅니다. 모델에 저장되지 않습니다.
  - **모델 조정**: 눈·입·흔들림 값을 다듬습니다. 모델에 저장됩니다.
  - **레이어**: 표시·순서·깊이를 바꿉니다.
  - 편집기와 캡슐 플레이어가 같은 엔진(`engine/core.js`)을 쓰므로, 편집기에서 보이는 움직임이 그대로 재생됩니다. 조정한 값은 브라우저에 자동 저장됩니다.
- **내보내기**: 상단의 **캡슐 모델 내보내기**로 `rig.json` + 파츠 PNG + `reactions.json`이 든 ZIP을 저장합니다.
- 전부 로컬에서 동작합니다. 빌드 도구가 필요 없습니다.

## 시작하기

```bash
npm start            # http://127.0.0.1:8000/  (python serve.py)
```

1. 편집기에 파츠 PSD를 놓습니다. 그림만 있으면 아래 see-through 단계로 PSD를 먼저 만듭니다.
2. 점검 → 움직여 보기 → 모델 조정 순서로 확인하고 「캡슐 모델 내보내기」를 누릅니다.
3. ZIP을 `bundles/<이름>/`에 풀고 `http://127.0.0.1:8000/engine/demo/index.html?bundles=<이름>`에서 확인합니다.

CLI로도 만들 수 있습니다.

```bash
node tools/build-bundle.js character.psd bundles/chaerin [--settings chaerin.rig.json]
```

플레이어 API, 묶음 형식, 표정·모션(`reactions.json`) 형식은 [engine/README.md](engine/README.md)를 보세요.

## 그림 → PSD (see-through)

한 장짜리 그림을 파츠별 레이어 PSD로 나누는 데는 [shitagaki-lab/see-through](https://github.com/shitagaki-lab/see-through)(Apache-2.0)를 씁니다. NVIDIA GPU(VRAM 8GB 이상)가 필요합니다.

- **무료 Colab**: `seethrough/see_through_colab.ipynb`를 Colab에 올리고, T4 GPU로 「모두 실행」합니다. 그림을 고르면 PSD가 다운로드되고, 그 PSD를 편집기에 놓으면 됩니다. 편집기 시작 화면에도 같은 안내가 있습니다.
- **GPU 컴퓨터·유료 Colab**: `python seethrough/server.py`로 변환 서버를 열고, 편집기 시작 화면의 「자동 연결」에 연결 코드를 넣으면 그림을 바로 놓을 수 있습니다. 무료 Colab에서는 노트북 밖에서 접속하는 것이 규정상 금지라 이 방식을 쓰지 않습니다.
- see-through 원본은 `third_party/see-through`(git submodule)에 있습니다. 가중치는 실행할 때 Hugging Face에서 받습니다.

## 테스트

```bash
npm run test:node                           # 리거 · 엔진 · 묶음 (Node만)
npm run test:python                         # 로컬 서버 · 변환 서버
CHROME_CHANNEL=chrome npm run test:browser  # 편집기 회귀 테스트 (npm install --no-save playwright 필요)
CHROME_CHANNEL=chrome npm run test:player   # 플레이어 스모크 (npm start 실행 중일 때)
CHROME_CHANNEL=chrome npm run test:seethrough  # 시작 화면 → 가짜 변환 서버 → 리깅 (npm start 실행 중일 때)
```

일부 테스트는 저장소 루트의 샘플 `sample.psd`, `sample2.psd`를 씁니다. 이 그림의 권리는 원작자에게 있어서 저장소에는 넣지 않습니다(`.gitignore`). 테스트하려면 로컬에 두세요.

## 출처와 라이선스

- MIT License (`LICENSE`).
- [Anime2.5DRig](https://github.com/852wa/Anime2.5DRig)(MIT, Copyright (c) 2026 hakoniwa)를 바탕으로 만들었습니다. 원본의 사용 설명(일본어)은 [docs/anime2.5drig-README.ja.md](docs/anime2.5drig-README.ja.md)에 있습니다. 편집기 화면은 캡슐용으로 다시 만들었고(한국어), 원본의 OBS 송출·녹화 기능은 뺐습니다.
- `lib/ag-psd.min.js`: [ag-psd](https://github.com/Agamnentzar/ag-psd), MIT
- `lib/vendor/face_mesh/`: MediaPipe FaceMesh, Apache-2.0 (`lib/vendor/face_mesh/NOTICE.md`)
- `eye_close.psd`, `mouth_close.psd`, `lib/genericparts.js`: 원본에 포함된 범용 감은 눈·다문 입 파츠
