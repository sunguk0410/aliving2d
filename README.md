# Capsule Model Studio

애니풍 캐릭터 그림으로 캡슐(CAPSULE)에서 쓸 2.5D 캐릭터 모델을 만드는 로컬 도구입니다.

```
애니풍 그림 ──(see-through)──▶ 파츠 PSD ──(자동 리깅 + 편집기에서 조정)──▶ 캡슐 모델 묶음 ──(engine/player.js)──▶ 캡슐에서 재생
```

- **자동 리깅**: PSD 레이어 이름(영어·일본어·see-through 출력)을 읽어서 메시 분할, 눈·입 개폐, 머리카락 물리, 기준점(앵커)을 자동으로 만듭니다.
- **편집기**: 앵커, 파라미터, 레이어 순서와 깊이를 미리 보면서 조정합니다. 편집기와 캡슐 플레이어가 같은 엔진(`engine/core.js`)을 쓰므로 편집기에서 보이는 움직임이 그대로 재생됩니다.
- **내보내기**: 「書き出し」의 **캡슐 모델 내보내기**로 `rig.json` + 파츠 PNG + `reactions.json`이 든 ZIP을 저장합니다.
- 전부 로컬에서 동작합니다. 빌드 도구가 필요 없습니다.

## 시작하기

```bash
npm start            # http://127.0.0.1:8000/  (python obs_server.py)
```

1. 편집기에서 파츠 분리된 PSD를 열거나 드래그합니다.
2. 앵커와 파라미터를 조정하고 「캡슐 모델 내보내기」를 누릅니다.
3. ZIP을 `bundles/<이름>/`에 풀고 `http://127.0.0.1:8000/engine/demo/index.html?bundles=<이름>`에서 확인합니다.

CLI로도 만들 수 있습니다.

```bash
node tools/build-bundle.js character.psd bundles/chaerin [--settings chaerin.rig.json]
```

플레이어 API, 묶음 형식, 표정·모션(`reactions.json`) 형식은 [engine/README.md](engine/README.md)를 보세요.

## 그림 → PSD (see-through)

한 장짜리 그림을 파츠별 레이어 PSD로 나누는 데는 [shitagaki-lab/see-through](https://github.com/shitagaki-lab/see-through)(Apache-2.0)를 씁니다. NVIDIA GPU(VRAM 8GB 이상)가 필요하므로 Colab이나 GPU가 있는 PC에서 실행합니다. 연동 스크립트는 준비 중입니다.

## 테스트

```bash
npm run test:node                           # 리거 · 엔진 · 묶음 (Node만)
npm run test:python                         # 로컬 서버
CHROME_CHANNEL=chrome npm run test:browser  # 편집기 회귀 테스트 (npm install --no-save playwright 필요)
CHROME_CHANNEL=chrome npm run test:player   # 플레이어 스모크 (npm start 실행 중일 때)
```

일부 테스트는 저장소 루트의 샘플 `sample.psd`, `sample2.psd`를 씁니다. 이 그림의 권리는 원작자에게 있어서 저장소에는 넣지 않습니다(`.gitignore`). 테스트하려면 로컬에 두세요.

## 출처와 라이선스

- MIT License (`LICENSE`).
- [Anime2.5DRig](https://github.com/852wa/Anime2.5DRig)(MIT, Copyright (c) 2026 hakoniwa)를 바탕으로 만들었습니다. 원본의 사용 설명(일본어)은 [docs/anime2.5drig-README.ja.md](docs/anime2.5drig-README.ja.md)에 있습니다. 편집기 화면 대부분은 아직 원본의 일본어 그대로입니다.
- `lib/ag-psd.min.js`: [ag-psd](https://github.com/Agamnentzar/ag-psd), MIT
- `lib/vendor/face_mesh/`: MediaPipe FaceMesh, Apache-2.0 (`lib/vendor/face_mesh/NOTICE.md`)
- `eye_close.psd`, `mouth_close.psd`, `lib/genericparts.js`: 원본에 포함된 범용 감은 눈·다문 입 파츠
