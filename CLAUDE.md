# Aliving2D — Claude Code 안내

## 목표
애니풍 캐릭터 그림 한 장 → **Live2D 장인의 작업 순서를 AI·규칙으로 따라가는** 자동 리깅 → 캡슐(CAPSULE) 앱용 모델. 개인용 로컬 도구, 배포하지 않음.
- 목표 품질은 **Live2D 수작업 쇼케이스 모델**. 가장 중요한 것은 고개 돌릴 때의 자연스러움, 그다음 눈 디테일, 머리카락 흔들림, 표정.
- 사용자와의 대화는 한국어. 비용·시간 제한은 없지만 **GPU는 이 PC(RTX 4060 8GB, RAM 16GB)만** 쓴다. 클라우드 GPU 제안 금지. OpenAI·비전 LLM 같은 GPU 없는 API는 써도 됨.
- 설계 문서: https://claude.ai/artifact/UuXijAnwywxPTXWUYhwsGp (Claude Docs)
- v1(편집기, 공식 기반 엔진, see-through 레이어 그대로 리깅)은 **태그 `v1-final`**에. 2026-11-16 v2로 전환하며 v1 코드는 지움.

## 원칙
- **장인 과정을 따른다**: 파츠 나누기·그려 넣기 → 표정 → 기본 움직임 → 얼굴 각도 XY → 물리. 근거 자료는 설계 문서의 출처(Live2D 공식, 925·乾物ひもの 노트).
- **범용 원칙으로만 규칙을 만든다** (특정 캐릭터의 숫자에 맞추지 말 것. 시험 캐릭터 "채린이"에 특화되면 안 됨): 선은 끊기지 않는 하나의 파츠 / 속눈썹은 가까운 눈꺼풀 선을 따른다(눈 앞머리·눈꼬리 기준) / 눈꺼풀은 자기 속눈썹과 같은 격자로 붙어 움직인다 / 입꼬리는 뾰족하다.
- **보이는 픽셀은 모델 자신의 레이어에서**: AI 그림에서는 그 상태에만 있는 선·모양을 가져오고, 피부 같은 바탕은 모델의 얼굴 레이어를 쓴다(이음새 방지).
- **그림에 없는 상태는 GPT가 같은 얼굴로 그린 그림**(입 벌림, 웃는 눈 ^ ^)에서 가져와 파츠로 쓴다 = Live2D 描き目.
- 고개 돌리기는 **장인 규칙**(그림 한 장 + 원통 머리 모형). 턴어라운드(AI 3/4 그림 섞기)는 비교 후 쓰지 않기로 함(2026-11-16, 중간 각도 겹침). 실험 스크립트는 2026-11-17에 지움(기록은 git `v1-final`·`9783f51`).
- 편집기 파이프라인 단계는 사용자에게 묻지 않고 끝까지 진행, 실패하면 자동으로 대체.

## 구조
| 경로 | 내용 |
|---|---|
| `py/rig.py` | 기준 엔진(Python): 파츠, 변형 격자(`Warp`), 키폼 보간, 불투명도 키폼, 클립·마스크 전용 파츠, PSD 읽기(see-through 옅은 알파 잡티 제거) |
| `py/artisan.py` | 장인 규칙: 좌우 파츠 나누기, 얼굴 기준점, 장인 레이어 순서(see-through 깊이 순서를 믿지 않음), 각도 X·Y 키폼(원통·타원체, 파츠별 깊이 `part_rule`), `build()`가 아래 단계들을 부름 |
| `py/eye_parts.py` | 눈동자 원 완성, 동공·하이라이트 분리 |
| `py/eyes_rig.py` | 시선 `eyeX/eyeY` (흰자로 클립, 하이라이트는 절반만) |
| `py/blink_rig.py` | 깜빡임 `eyeOpenL/R`, 웃는 눈 `eyeSmile`: 피부 눈꺼풀(얼굴 레이어 픽셀, 속눈썹과 같은 격자, 흰자보다 3px 큰 마스크로 클립), 속눈썹 위·아래·쌍꺼풀(`split_lashes_corners`, `follow_line`) |
| `py/drawn_eyes.py` | 그린 웃는 눈: GPT ^ ^ 그림의 선만(진한 씨앗에서 키워 통째로, 앞머리 자리는 제외) + 모델 얼굴 피부, `eyeSmile` 0.8~0.97에서 나타남 |
| `py/mouth_rig.py` | 입 `mouthOpen`, `mouthForm`: GPT 입 벌린 그림 → 입 마스크·입 안·윗입술·아랫입술, 렌즈 모양 중간 키폼, 다문 입 폭의 1.15배로 맞춤 |
| `py/eyewhite_fill.py` | see-through가 흰자 레이어를 안 주면 그려 넣기: 눈동자 중심 위의 가장 가까운 선(위 속눈썹)과 아래 첫 선(아래 속눈썹) 사이 + 눈동자, 색은 원본의 흰 부분을 부드럽게 퍼뜨림 |
| `py/source_paint.py` | 쉬는 상태에서 보이는 픽셀은 원본 그림 색으로 다시 칠함 (see-through 다시 그리기 오류 보정) |
| `py/hair_rig.py` | 머리카락 흔들림: 레이어는 자르지 않음(사용자 결정, 머리결대로 못 자르면 통째로). 폭을 따라 겹치는 흔들림 구역(합이 1) + 구역마다 두 단 진자 물리 |
| `py/face_expr.py` | 표정: 눈썹 `browLY/RY`·`browLAngle/RAngle`, 눈동자 크기 `eyeBall`, 입 너비 `mouthWide`(모음 `VOWELS` 아·이·우·에·오 = 벌림·모양·너비 조합, model.json `vowels`), 효과 파츠(홍조 `cheek`, 눈물 `tear`, 어두운 세로선 `gloom`, 땀 `sweat`, 분노 마크 `anger`, 반짝 `sparkle`, 하트 눈 `heartEyes`, 흰 눈 `blankEyes`), 앞머리 위 반투명 눈썹, 표정 프리셋 27개 `EXPRESSIONS` → `expressions/*.exp3.json` |
| `py/motions.py` | 모션 20개(대기·말하기·끄덕·두 번 끄덕·힐끔·갸웃하며 말하기·두리번·반짝 깨기·고개 돌리기·도리도리·인사·시무룩·깜짝·손 흔들기·만세·박수·기지개·생각·수줍음·신남) → `motions/*.motion3.json` (Live2D motion3, 선형 구간). 팔을 머리 위로 올릴 땐 `arc()`로 곧은 팔이 옆을 지나 원을 그림 |
| `py/body_rig.py` | 고개 기울이기 `angleZ`(목 위 축), 몸 `bodyX/bodyY/bodyZ`, 숨쉬기 `breath`: 허리(하의 맨 위)를 축으로 위치만 보고 키폼, 목 위는 통째로(머리는 몸에 실림) |
| `py/arm_rig.py` | 팔: `handwear`를 좌우 팔로, 중심선 따라 어깨·팔꿈치(43%)·손목(80%), 회전 디포머 가중치(어깨 → 팔꿈치). `armLX/armLY/armRX/armRY` = 손목 위치(팔 길이 단위, `engine/tracking.js`와 같은 값) → 엔진 IK(`solveArm`), 손목 `handL/handR`(손은 아래팔 회전의 35%를 되돌려 늘어짐) |
| `py/cloth_rig.py` | 옷·손 물리: 치마 `swaySkirt`(허리띠 고정, 밑단 흔들림, 몸 Z/X/Y로 진자), 손 늦게 따라오기 `handLag<s>`(엔진이 손목 각도에 더함) |
| `py/compose.py` | 계획 B 합치기: 상반신 PSD(몸) + 머리 크롭 PSD(얼굴, 고해상도) → 한 모델 |
| `py/pipeline.py` | 명령 하나 파이프라인: 다듬기 → GPT 상반신 원화 → 업스케일 → 몸 see-through → 머리 크롭 → 얼굴 see-through(+입·웃는 눈 GPT) → 리깅. `--from <단계>` |
| `py/render_bundle.py` | 묶음을 Python으로 그려 보기(엔진과 같은 규칙). `--sheet`로 주요 자세 한 장 |
| `studio/index.html` | 대시보드(`/`): 업로드, 단계 진행, 여기부터 다시, 멈추기, 작업별 옵션(귀 자동/보이기/숨기기), 뷰어, **파츠 분리 보기**(몸·얼굴 see-through 레이어 3D 펼치기·목록, 리깅 파츠) |
| `py/export_bundle.py` | 묶음 v2 쓰기 (`model.json` + `parts/*.png`), CLI |
| `py/gpt_image.py` | OpenAI 이미지 편집(키·모델은 `seethrough/redraw.py`) |
| `py/upscale.py` | Real-ESRGAN anime 6B (패키지 없이 직접 정의, 가중치 `.local/models/`) |
| `engine/engine.js` | 브라우저 엔진(WebGL2): 키폼, 불투명도, 섞기 그룹, 클립 마스크, 마스크 전용 파츠, 머리카락 진자 물리(`step`), 팔 회전 디포머 + IK(`model.ARMS`는 tracking.js용) |
| `engine/player.js` | **캡슐용 플레이어**(UI 없음): `CapsuleV2Player.create(canvas, modelJsonUrl, {reactions})` → 혼자 숨쉬기·깜빡임·대기 모션·두리번, `react(trigger, intensity)`, `setExpression`, `playMotion`, `talk(ms)`, `track({ParamAngleX…})`(카메라 값, Live2D ID), `trackArms`, `lookAt`. 층 순서는 뷰어와 같음. 시험 페이지 `player/` (`?react=GREETING`) |
| `viewer/index.html` | 뷰어: 표정·모션 버튼, 대기 모션 상시(더하기, `?idle=0`), 아이우에오, 반응 시험, 슬라이더, 마우스 따라 보기, 자동 고개 돌리기, 자동 깜빡임(표정의 눈 뜸에 곱함), 숨쉬기, 손 흔들기, **카메라로 따라 하기**(FaceMesh → `lib/face-features.js`, Hands → `engine/tracking.js` → 팔). 주소 옵션 `?expr=`, `?motion=`, `?set=id:값,…`, `?blink=0`, `?breath=0` |
| `bundles/` | 묶음 (캐릭터 그림이라 git 제외) |
| `serve.py` | `npm start` 로컬 서버. `/` → `/studio/`(대시보드), `/api/v2/jobs`. see-through 설치·자동 실행(`seethrough/manager.py`) |
| `seethrough/` | see-through 서버·설치(`server.py`, `manager.py`, `desktop.py`), 그림 다듬기 `prepare.py`, OpenAI 키 `redraw.py`, 변환 후 PSD 정리 `fix_psd.py`(서버가 씀). v1의 표정 그림·공부 자세·Colab, 대회용 Studio·Editor(요청 패널)는 2026-11-17에 지움 |
| `engine/tracking.js` | 카메라 손목 → 팔 값 (v1에서 남김, v2 엔진에 다시 연결할 것) |
| `engine/reactions.default.json` | 캡슐 반응표 v2: trigger → 모션·표정 이름(내용은 모델 묶음 안), hold·talk·then·intensity·weight. 뷰어의 '반응 시험'으로 재생 |
| `lib/vendor/` | MediaPipe FaceMesh·Hands 고정 버전 |
| `third_party/see-through` | see-through 원본 (git submodule, Apache-2.0) |

묶음 v2 형식은 `py/export_bundle.py` 맨 위 설명 참고.

## 확인 방법
- 브라우저 없이: `python py/render_bundle.py <묶음> out.png --sheet`
- 실제 엔진: 테스트 서버(`serve.py --port 8765 --no-seethrough --seethrough-port 7999`) + 헤드리스 Chrome `--use-angle=swiftshader --enable-unsafe-swiftshader --screenshot … "…/viewer/index.html?model=…&expr=joy"`

## 규칙
- 실행 산출물·실험 결과는 `.local/v2_runs/`(git 제외, 서빙 안 됨). 서버가 점(.) 폴더는 내주지 않으므로 뷰어용 묶음은 `bundles/`.
- see-through는 `seethrough/.venv`의 Python으로 `third_party/see-through`에서 `inference/scripts/inference_psd_quantized.py --no_group_offload --srcp <그림> --save_dir <폴더> --save_to_psd` (약 20분/장). 얼굴은 해상도가 품질을 정하므로 머리 크롭을 업스케일해서 돌리는 게 좋음(실험 0).
- **GPU 작업은 한 번에 하나**. 사용자의 변환 서버(7860)가 돌고 있으면 기다릴 것(16GB RAM이라 같이 돌면 느려지고 죽음).
- 테스트용 `serve.py`는 `--no-seethrough --seethrough-port <빈 포트>`로.
- 패키지 설치가 막혀 있을 수 있음(자동 모드). 필요한 건 직접 구현하거나 가중치만 받기.
- `sample.psd`, `sample2.psd`는 원작자 그림. **커밋 금지**.
- `LICENSE`의 원작자(hakoniwa) 줄은 지우지 않는다.

## 명령
```bash
npm start                 # http://127.0.0.1:8000/ (v2 뷰어)
npm test                  # Python: 로컬 서버, see-through 서버, desktop.py
python py/export_bundle.py <psd> bundles/<이름> --src <정면 그림> --mouth-open <입 벌린 그림> --smile-eyes <웃는 눈 그림>
python py/gpt_image.py <그림> <출력> --prompt-file <프롬프트> [--size 1024x1024] [--n 2]
```

## 진행 상황 (v2)
- [x] 실험 0: 얼굴 크롭 업스케일 see-through → 해상도는 오르지만 나누는 단위는 그대로
- [x] 실험 1: 눈 파츠 (원 완성, 동공, 하이라이트)
- [x] 실험 2·3: 키폼 엔진(Python·WebGL2), 고개 돌리기 — GPT 목표 그림 맞추기는 실패(GPT가 정면 쪽으로만 돌림) → 장인 규칙으로 결정
- [x] 시선, 깜빡임(피부 눈꺼풀), 속눈썹 위·아래·쌍꺼풀, 그린 웃는 눈, 입(벌림·웃음)
- [x] 명령 하나로 도는 파이프라인 + 대시보드 (두 번째 캐릭터로 일반화 확인: 흰자 없는 경우, 가려진 이마 피부, 귀 자동)
- [x] 머리카락 다발 + 두 단 진자 물리, 몸 X/Y/Z·숨쉬기
- [x] 팔: 어깨·팔꿈치 회전 디포머 + 손목 IK (손은 아래팔에 붙음)
- [x] 표정 27개(파라미터 + 효과 파츠), 모션 12개, 고개 기울이기, 손목, 뷰어 카메라 추적(실제 카메라로는 아직 확인 못 함)
- [x] 깜빡임: 위 속눈썹에 붙은 '쌍꺼풀' 조각은 속눈썹으로(`crease_apart`), 눈꺼풀 피부는 가닥 지운 피부(`clean_skin`); 아·이·우·에·오(입 너비)
- [x] 웃는 눈: 변형 눈꺼풀이 만나는 선을 GPT ^ ^ 그림의 아치 아랫선에 맞춤(`drawn_eyes.fit_smile_line`, 겹선 방지)
- [x] 캡슐 플레이어 `engine/player.js` (반응표 v2, 카메라 값 Live2D ID)
- [ ] v2용 업로드 화면, 캡슐 연동(플레이어, 카메라 추적, 반응표)

## 캡슐 연동 메모
- v2 묶음은 Cubism `.moc3`가 아니라 자체 형식이라, 캡슐 프런트는 `engine/engine.js`(WebGL2)로 그려야 함. `modelJsonUrl`은 묶음의 `model.json`.
- 엔진의 `set/get`이 Live2D 표준 ID(`ParamAngleX/Y/Z`, `ParamEyeLOpen/ROpen`, `ParamMouthOpenY`, `ParamBodyAngleX` …)를 Live2D 단위로 받음(`CapsuleV2.LIVE2D`) → 기존 추적 코드 그대로. 팔은 `model.ARMS` + `tracking.js armParams`.
- 프런트는 `engine.js` + `player.js`만 넣으면 됨: `CapsuleV2Player.create(canvas, modelJsonUrl, {reactions})`, 매 프레임 `track({...})`, 반응이 오면 `react(trigger_type, intensity)`.
- 반응: `live2d_reaction_maps`의 motion · expression 이름 = 묶음의 `motions[].name` · `expressions[].name` (기본표 `engine/reactions.default.json`).

## 관련 프로젝트
- **캡슐 백엔드**: `C:\Users\kkcc4\IdeaProjects\Backend_lab` (Spring). Live2D 모양의 계약: 모델은 `modelJsonUrl` + `scale`/`offsetX`/`offsetY`, 모션 `{group, file}`, 표정 `{name, file}`. 반응별 표정·모션은 DB(`live2d_reaction_maps`). 프론트는 카메라로 사용자의 얼굴과 손(손목 → 팔)을 매 프레임 따라 한다(`docs/specs/api.md` 18번).
