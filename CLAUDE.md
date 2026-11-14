# Capsule Model Studio — Claude Code 안내

## 목표
애니풍 캐릭터 그림 한 장 → 파츠 PSD(see-through) → 자동 리깅 → **캡슐(CAPSULE) 앱용 모델 묶음**을 만드는 개인용 로컬 도구. 배포하지 않는다.
- **우선순위는 모델 품질**이다 (팔 움직임, 다양한 표정). 속도보다 품질.
- 표정·모션 이름은 캡슐 백엔드의 이름과 맞출 필요 없음.
- 사용자와의 대화는 한국어. 편집기 UI도 전부 한국어(2026-11-13 캡슐용으로 개편). 필요한 기능만 둔다: OBS 송출·PNG 저장·녹화는 뺐고, 카메라 추적·마이크 립싱크는 남김.

## 구조
| 경로 | 내용 |
|---|---|
| `index.html`, `lib/app.js`, `lib/app.css` | 편집기. 첫 화면은 그림 올리기 카드 하나(이 PC 상태에 따라 업로드 / 설치하기 / Colab 안내, 모델이 열리기 전엔 옆 패널 숨김), 변환 중엔 원본·다듬은 그림과 4단계 진행. 탭 4개(점검 / 움직이기 / 캐릭터 맞춤 / 레이어). 슬라이더는 `app.js`의 `SLIDERS` 표에서 생성, 캐릭터 맞춤 슬라이더는 `TUNE_INFO`(설명 + 잡고 있는 동안 보여 줄 자세). 조정값·모델별 reactions.json은 브라우저에 자동 저장. 변형 수식은 `engine/core.js` 호출 |
| `lib/expressions.js` | reactions.json 검증·정리, 슬라이더 자세 ↔ 표정/모션 키 변환 (DOM 없음) |
| `serve.py` | `npm start` 로컬 정적 서버 (localhost 전용, 읽기 전용 + 설치 버튼용 POST 하나). GPU PC면 see-through 변환 서버도 같이 켬 (`--no-seethrough`로 끔, 테스트는 끔) |
| `lib/rigger.js` | PSD → rig (레이어 이름 해석, 좌우 분리, 머리 가닥, 앵커). DOM 없음, Node 테스트 가능 |
| `lib/psd-worker.js` | 브라우저에서 PSD 파싱 + 리깅 (Web Worker) |
| `engine/core.js` | **변형 엔진 (편집기·플레이어 공용)**. 메시 생성, fadeAlpha, deform, updateSprings |
| `engine/animator.js` | 파라미터 층: 기본값 → 표정 → 대기 동작 → 모션 → 깜빡임·말하기 |
| `engine/tracking.js` | 카메라 손목 → 팔 값 (`CapsuleTracking`). 편집기와 캡슐 프론트 공용 |
| `engine/reactions.default.json` | 기본 표정 18개·모션 12개·반응표. 표정 이름에 `label`(한국어) |
| `engine/player.js` | 캡슐 프론트용 플레이어 `CapsulePlayer` |
| `engine/bundle.js` | 묶음 쓰기 (rig.json, 무손실 PNG, ZIP). 편집기 「캡슐 모델 내보내기」와 CLI 공용 |
| `tools/build-bundle.js` | PSD → 묶음 CLI (`--settings`로 편집기 설정 적용) |
| `engine/demo/` | 플레이어 데모 `index.html?bundles=a,b`, 팔 리깅 확인 페이지 `arms.html?b=sampleA` |
| `seethrough/server.py` | see-through 변환 서버 (그림 → 파츠 PSD). 표준 라이브러리만. Colab·GPU 데스크톱·`--mode fake` 공용. 작업마다 `phase`(prepare/parts/depth/psd)와 `/jobs/<id>/prepared` |
| `seethrough/redraw.py` | 「AI로 자세 바로잡기」: OpenAI 이미지 편집(`gpt-image-2.5-sunburst`, 960×1280)으로 같은 캐릭터를 정면·양팔 자세로 다시 그림. 키는 `.local/openai.json`(git 제외, 서빙 안 함), 편집기는 끝 4자리만 봄. serve.py `POST /api/redraw`, `/api/redraw/key` |
| `seethrough/expression_art.py` | 표정 그림: 얼굴을 잘라 1024로 키운 뒤 눈·입 자리만 GPT로 다시 그림(감은 눈 / 웃는 눈 / 아·웃는·오 입). 색을 원본에 맞추고, 앞머리는 지워 피부로 메우고, 눈·입 둘레만 바뀐 부분을 레이어로. GPT가 남긴 투명 부분은 원본으로 채움(그냥 RGB로 바꾸면 검은 상자). 원본 GPT 결과는 `<out>.raw/`에 남겨 `--reuse`로 다시 자르기 |
| `seethrough/pose_art.py` | 공부 자세: 머리·가슴은 고정하고 팔·소품만 GPT로 → see-through(몸 단계만, `body_only.py`) → `handwear@typing` / `objects@typing`으로 합침 |
| `seethrough/body_only.py` | see-through를 몸 단계만 돌림(얼굴 단계 생략, 원본 수정 없이 함수만 바꿔 끼움). 자세 변환 8.2분 → 4.8분 |
| `seethrough/fix_psd.py` | 변환 후 PSD 정리 (see-through 쪽 Python): 원본 그림과 비교해, 위 파츠의 숨은 부분 그림이 실제로 보이던 아래 파츠를 덮는 큰 영역(예: 셔츠 뒷깃이 목을 덮음)을 위 파츠에서 지움. 눈·입 같은 얼굴 작은 파츠는 건드리지 않음 (리거가 순서를 맞춤) |
| `seethrough/prepare.py` | 변환 전 그림 다듬기 (see-through 쪽 Python): 애니 캐릭터 분할(skytnt/anime-seg ISNet)로 배경 제거 → 주 캐릭터만 → 흰 바탕 3:4, 세로 1280px. see-through 예시 그림과 같은 모양으로 맞춤 |
| `seethrough/manager.py` | `serve.py`가 쓰는 see-through 관리: NVIDIA GPU 확인 → 설치돼 있으면 변환 서버를 자동으로 켬(토큰 없음, 편집기 origin만 허용), 아니면 편집기 「설치하기」 버튼 → `desktop.py --setup-only`. 상태는 `/local-config.json`, 설치는 `POST /api/seethrough/install` |
| `seethrough/desktop.py` | 설치 스크립트 (`seethrough/.venv`에 CUDA PyTorch·의존성). 터미널용 `npm run seethrough` (`--check`, `--lan`: 다른 PC에서 연결 코드로 쓰기) |
| `seethrough/see_through_colab.ipynb` | Colab 노트북. `seethrough/build_colab.py`가 server.py를 끼워 넣어 생성 (server.py 고치면 `npm run build:colab`) |
| `lib/seethrough.js` | 편집기 쪽 클라이언트. 연결 코드 = `<url>#<token>` |
| `lib/vendor/face_mesh`, `lib/vendor/hands` | MediaPipe 고정 버전 (얼굴, 손). 둘은 전역 wasm 로더를 같이 쓰므로 FaceMesh가 돈 뒤 Hands를 초기화 |
| `third_party/see-through` | see-through 원본 (git submodule, Apache-2.0). 가중치는 저장소에 없음, 실행 시 Hugging Face에서 받음 |

묶음 형식: `rig.json`(canvas, anchors, anchorOffsets, settings, layers[]) + `parts/*.png` + `reactions.json`. 자세한 건 `engine/README.md`.

## 규칙
- 엔진 수식을 바꾸면 `tests/equivalence.test.js`가 통과해야 한다. 원본 수식(`tests/fixtures/upstream-deform.js`, 고치지 말 것)과 비트 단위로 같은지 본다. 새 기능은 `Core.DEFAULTS`/`RANGES`에 넣고 **기본값에서는 원본과 같은 결과**가 나오게 하며 `Core.EXTENSIONS`에 등록한다.
- 새 파라미터는 `engine/core.js`의 `DEFAULTS`/`RANGES`와 편집기 `lib/app.js`의 `SLIDERS` 표에 같이 넣는다. 포즈·표정용이면 「움직여 보기」(head/arms) 또는 「표정·모션」(face/face-more/fx) 그룹에 두고 `engine/bundle.js`의 `POSE_KEYS`에도 넣는다(묶음 settings에 구워지지 않게, 표정 저장 대상). 캐릭터 조정값이면 「모델 조정」 그룹(eyes/mouth/physics).
- 효과 레이어(`fade: 'fx'`)는 원본에 없는 레이어라 `tests/equivalence.test.js`에서 건너뛴다. 기본값(0)에서는 안 그려진다.
- 눈 파츠는 리거가 항상 흰자 → 눈동자 → 속눈썹 → 감은 눈 순으로 쌓는다 (see-through가 기울어진 얼굴에서 흰자를 눈동자 위에 두는 일이 있었음).
- 눈 감기 기본은 **피부 눈꺼풀** (`eyeLid` 1, 리거가 흰자·눈동자 모양으로 `eye_lid_l/r`을 얼굴 레이어 색으로 만듦): 눈꺼풀이 위에서 내려오고 위 속눈썹 띠가 내려오며 얇아져 감은 눈 선이 됨(웃으면 ∩, 아래 속눈썹도 합쳐짐). 속눈썹은 리거가 위(`eyelash`) · 아래(`eyelash_lower`) · 쌍꺼풀 선(`eyelash_crease`, 제자리)으로 나눔. 웃는 눈은 아래 속눈썹이 올라가 위와 만나는 변형(나눠졌으면 GPT 웃는 눈 그림은 안 씀). 방향: AI로 상태 그림을 만들지 말고 파츠를 잘게 나누거나 빠진 파츠를 만들어 리깅으로 표정을 냄. 감은 눈 그림은 `eyeLid` 0일 때만 씀. 눈꺼풀 레이어는 `tests/equivalence.test.js`에서 건너뜀.
- 그린 입 모양이 있는 모델(`hasMouthShapes`)은 입을 섞지 않고 하나만 보임 (`Core` `mouthShape`). 없는 모델은 원본과 같음.
- 편집기 파이프라인 단계(자세 바로잡기, 표정·자세 그림)는 사용자에게 묻지 않고 끝까지 진행, 실패하면 자동으로 원본으로.
- 테스트용 `serve.py`는 `--no-seethrough --seethrough-port <빈 포트>`로 띄운다 (사용자의 진짜 변환 서버가 7860에 떠 있을 수 있음).
- `sample.psd`, `sample2.psd`는 원작자 그림이다. **커밋 금지** (`.gitignore`). 테스트용으로 로컬에만 둔다.
- `LICENSE`의 원작자(hakoniwa) 줄은 지우지 않는다.
- 내부 형식 이름(`anime25d-settings`, localStorage `anime25d.*`, `window.Anime25D`)은 호환성 때문에 바꾸지 않는다.

## 명령
```bash
npm start                                   # http://127.0.0.1:8000/ (편집기), /engine/demo/ (플레이어)
npm run test:node                           # 리거·엔진·묶음
npm run test:python                         # 로컬 서버, see-through 서버, desktop.py
npm run seethrough -- --check               # see-through 설치 상태 (보통은 npm start만 켜면 편집기가 설치·실행까지 함)
npm install --no-save playwright@1.49.1     # 브라우저 테스트용 (설치된 Chrome 사용)
CHROME_CHANNEL=chrome npm run test:browser  # 편집기 회귀 (가상 장치 51개 + 실제 PSD·기준점·얼굴 추적)
CHROME_CHANNEL=chrome npm run test:player   # 플레이어 스모크 (npm start 실행 중, DEMO_URL로 ?bundles= 지정 가능)
CHROME_CHANNEL=chrome npm run test:seethrough  # 시작 화면: 그림 → fake 변환 서버(자동으로 찾음) → 리깅 (자체 서버 띄움)
python seethrough/server.py --mode fake --fake-psd sample2.psd --token ''   # GPU 없이 변환 흐름 시험
node tools/build-bundle.js sample2.psd bundles/sampleA   # 데모용 샘플 묶음
```

## 관련 프로젝트
- **캡슐 백엔드**: `C:\Users\kkcc4\IdeaProjects\Backend_lab` (Spring). Live2D 모양의 계약을 쓴다. 모델은 `modelJsonUrl` + `scale`/`offsetX`/`offsetY`, 모션은 `{group, file}`, 표정은 `{name, file}`이다. 어떤 반응에 어떤 표정·모션을 쓸지는 DB(`live2d_reaction_maps`)가 고른다. 아바타는 프론트가 카메라로 사용자의 **얼굴과 손(손목 위치 → 팔 값)**을 매 프레임 따라 한다(`docs/specs/api.md` 18번). 그래서 팔 리깅이 중요하다.
- 예전 폴더 `Anime2.5DRig`, `capsule-rig`는 참고용. 작업은 이 저장소에서만.

## 환경
- 2026-11-14 확인: 지금 작업하는 PC는 **RTX 4060 8GB(cc 8.9), RAM 16GB, Python 3.13** 데스크톱이다 (예전 메모의 "GPU 없는 노트북"과 다름). see-through 자동 모드는 nf4. 노트북에서 작업할 때는 Colab 노트북을 쓴다.

## 진행 상황
- [x] capsule-rig 엔진 통합, 편집기가 공용 엔진 사용, 「캡슐 모델 내보내기」(2026-11-13)
- [x] 팔 리깅 1~3단계 (2026-11-13): 좌우 분리, 어깨·팔꿈치·손목 검출(편집기 앵커로 보정), FK 각도 + 원근 IK(`armLX/LY` 등), 대시보드 `engine/demo/arms.html`. sample2는 팔 뒤 몸통이 채워져 있음 확인. sample.psd는 handwear에 몸통이 섞여 있음 (→ 2026-11-14 잘라 내기로 해결)
- [x] 팔 앞뒤 순서 (2026-11-13): 손이 몸 안쪽으로 오거나 위팔이 카메라 쪽(원근 단축)이면 아래팔을 맨 위에 한 번 더 그림 (`Core.armFront`, 렌더러 꼭짓점 알파). 손이 없는(잘린) 그림은 손을 만들지 않음
- [x] 표정 다양화 (2026-11-14): `eyeSmile`·`mouthWide`·`mouthTri`·`cheekPuff`, 효과 레이어 5종 자동 그림(PSD에 있으면 그것 사용), 기본 표정 18개·모션 12개, 편집기 「표정·모션」 탭에서 만들기·저장(모델별 자동 저장, 내보내기에 포함)
- [x] 카메라 손 추적 (2026-11-14): MediaPipe Hands → `engine/tracking.js` → `armLX/LY/RX/RY`. 손이 없으면 천천히 기본 자세. **실제 손이 나오는 영상으로는 아직 확인 전** (테스트 영상엔 얼굴만)
- [x] 몸통에 섞인 팔 잘라 내기 (2026-11-14): sample.psd도 팔 리그 켜짐. 팔 뒤 몸통 옆면은 경계 색으로 채움 (팔 사이 넓은 구멍은 못 채움)
- [x] 그림 다듬기 + 첫 화면·탭 개편 (2026-11-14): 배경 있는 장면 그림도 캐릭터만 잘라 변환, 눈 파츠 순서 보정, 업로드 카드 첫 화면, 움직여 보기+표정·모션 → 「움직이기」, 모델 조정 → 「캐릭터 맞춤」(설명 + 미리보기 자세), 연결 코드 UI 삭제 (다른 PC의 GPU를 쓰는 길은 이제 없음)
- [x] 자세 바로잡기 + 변환 품질 선택 (2026-11-14): OpenAI로 다시 그린 뒤 원본과 비교해 고르기. 품질 「고화질 1280(기본, 약 20분)」/「빠르게 1024(약 8분, 얼굴이 조금 흐림)」. RTX 4060 실측 파츠 단계 1단계당: NF4 1280 23.2초(8GB 넘침), 1152 12.1초, 1024 6.8초, bf16 block-swap 1280 14.1초지만 전체는 20.8분이라 이득 없음. 실제 OpenAI 호출은 사용자 키로 확인됨(표정·공부 자세 그림)
- [x] 표정 그림·공부 자세 (2026-11-14): GPT 표정 그림(`expression_art.py`), 공부 자세 키보드 치기·필기·손 흔들기(`pose_art.py`, 몸 단계만 변환해 자세당 8.2분 → 4.8분). 변환을 사용자가 돌리는 동안 GPU 작업을 따로 돌리지 말 것(16GB RAM이라 같이 돌면 4배 느려지고 강제 종료됨)
- [x] 눈 파츠 나누기 (2026-11-14): 피부 눈꺼풀 자동 생성, 속눈썹 위·아래·쌍꺼풀 선, 감기·웃는 눈을 변형만으로. 캐릭터 7명으로 확인(머리에 가린 눈, 단순 그림체의 쌍꺼풀 점은 약함)
- [ ] 입 파츠 나누기: 윗입술·아랫입술 선, 입 안·이·혀 파츠(AI로 한 장씩), 말하기·웃기·오 입을 변형으로
- [ ] 편집기 파츠 점검 화면 (파츠별 보기, 다시 만들기, 경계 고치기)
- [x] GPU PC용 see-through (2026-11-14): `npm start`만 켜면 됨. 편집기에 그림을 놓으면 PSD 변환 → 자동 리깅 (처음 한 번 「설치하기」). 이 PC 실측: 설치 ~15분, 그림 한 장 ~20분 (nf4, VRAM 6.7GB)
- [x] see-through 연동 (2026-11-13): 무료 Colab은 노트북 안에서 그림 올리기 → PSD 다운로드 → 편집기에 놓기 (터널 자동 연결은 무료 Colab 규정 위반이라 유료·GPU 컴퓨터용 선택 사항으로만). **실제 Colab GPU 실행은 아직 사용자가 확인 전**
