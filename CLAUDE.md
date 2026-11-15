# Capsule Model Studio — Claude Code 안내 (v2)

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
- 고개 돌리기는 **장인 규칙**(그림 한 장 + 원통 머리 모형). 턴어라운드(AI 3/4 그림 섞기, `morph_views.py`)는 비교 후 쓰지 않기로 함(2026-11-16, 중간 각도 겹침).
- 편집기 파이프라인 단계는 사용자에게 묻지 않고 끝까지 진행, 실패하면 자동으로 대체.

## 구조
| 경로 | 내용 |
|---|---|
| `v2/py/rig.py` | 기준 엔진(Python): 파츠, 변형 격자(`Warp`), 키폼 보간, 불투명도 키폼, 클립·마스크 전용 파츠, PSD 읽기(see-through 옅은 알파 잡티 제거) |
| `v2/py/artisan.py` | 장인 규칙: 좌우 파츠 나누기, 얼굴 기준점, 장인 레이어 순서(see-through 깊이 순서를 믿지 않음), 각도 X·Y 키폼(원통·타원체, 파츠별 깊이 `part_rule`), `build()`가 아래 단계들을 부름 |
| `v2/py/eye_parts.py` | 눈동자 원 완성, 동공·하이라이트 분리 |
| `v2/py/eyes_rig.py` | 시선 `eyeX/eyeY` (흰자로 클립, 하이라이트는 절반만) |
| `v2/py/blink_rig.py` | 깜빡임 `eyeOpenL/R`, 웃는 눈 `eyeSmile`: 피부 눈꺼풀(얼굴 레이어 픽셀, 속눈썹과 같은 격자, 흰자보다 3px 큰 마스크로 클립), 속눈썹 위·아래·쌍꺼풀(`split_lashes_corners`, `follow_line`) |
| `v2/py/drawn_eyes.py` | 그린 웃는 눈: GPT ^ ^ 그림의 선만(진한 씨앗에서 키워 통째로, 앞머리 자리는 제외) + 모델 얼굴 피부, `eyeSmile` 0.8~0.97에서 나타남 |
| `v2/py/mouth_rig.py` | 입 `mouthOpen`, `mouthForm`: GPT 입 벌린 그림 → 입 마스크·입 안·윗입술·아랫입술, 렌즈 모양 중간 키폼, 다문 입 폭의 1.15배로 맞춤 |
| `v2/py/export_bundle.py` | 묶음 v2 쓰기 (`model.json` + `parts/*.png`), CLI |
| `v2/py/gpt_image.py` | OpenAI 이미지 편집(키·모델은 `seethrough/redraw.py`) |
| `v2/py/upscale.py` | Real-ESRGAN anime 6B (패키지 없이 직접 정의, 가중치 `.local/models/`) |
| `v2/py/` 그 밖 | 실험 기록: `exp0_compare.py`, `fit_turn.py`·`turn_check.py`(GPT 목표 그림 맞추기, GPT는 고개 각도를 못 따름), `morph_views.py`(턴어라운드) |
| `v2/engine/engine.js` | 브라우저 엔진(WebGL2): 키폼, 불투명도, 섞기 그룹, 클립 마스크, 마스크 전용 파츠 |
| `v2/viewer/index.html` | 뷰어: 슬라이더, 마우스 따라 보기, 자동 고개 돌리기, 자동 깜빡임(`?blink=0`으로 끔) |
| `v2/bundles/` | 묶음 (캐릭터 그림이라 git 제외) |
| `serve.py` | `npm start` 로컬 서버. `/` → `/v2/viewer/`. see-through 설치·자동 실행(`seethrough/manager.py`) |
| `seethrough/` | see-through 서버·설치(`server.py`, `manager.py`, `desktop.py`), 그림 다듬기 `prepare.py`, GPT `redraw.py`, 공부 자세 `pose_art.py`·`body_only.py`(나중에 v2에 연결), `fix_psd.py`·`expression_art.py`(서버·pose_art가 씀) |
| `engine/tracking.js` | 카메라 손목 → 팔 값 (v1에서 남김, v2 엔진에 다시 연결할 것) |
| `engine/reactions.default.json` | 캡슐 반응표 (v1 표정 이름, v2 파라미터로 다시 매핑할 것) |
| `lib/vendor/` | MediaPipe FaceMesh·Hands 고정 버전 |
| `third_party/see-through` | see-through 원본 (git submodule, Apache-2.0) |

묶음 v2 형식은 `v2/py/export_bundle.py` 맨 위 설명 참고.

## 규칙
- 실행 산출물·실험 결과는 `.local/v2_runs/`(git 제외, 서빙 안 됨). 서버가 점(.) 폴더는 내주지 않으므로 뷰어용 묶음은 `v2/bundles/`.
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
python v2/py/export_bundle.py <psd> v2/bundles/<이름> --src <정면 그림> --mouth-open <입 벌린 그림> --smile-eyes <웃는 눈 그림>
python v2/py/gpt_image.py <그림> <출력> --prompt-file <프롬프트> [--size 1024x1024] [--n 2]
```

## 진행 상황 (v2)
- [x] 실험 0: 얼굴 크롭 업스케일 see-through → 해상도는 오르지만 나누는 단위는 그대로
- [x] 실험 1: 눈 파츠 (원 완성, 동공, 하이라이트)
- [x] 실험 2·3: 키폼 엔진(Python·WebGL2), 고개 돌리기 — GPT 목표 그림 맞추기는 실패(GPT가 정면 쪽으로만 돌림) → 장인 규칙으로 결정
- [x] 시선, 깜빡임(피부 눈꺼풀), 속눈썹 위·아래·쌍꺼풀, 그린 웃는 눈, 입(벌림·웃음)
- [ ] 명령 하나로 도는 파이프라인 + 여러 캐릭터 일괄 시험(일반화 확인) ← 다음
- [ ] 머리카락 다발 + 여러 단 진자 물리, 몸·팔, 아·이·우·에·오, 웃는 눈 ∩ 강화
- [ ] v2용 업로드 화면, 캡슐 연동(플레이어, 카메라 추적, 반응표)

## 관련 프로젝트
- **캡슐 백엔드**: `C:\Users\kkcc4\IdeaProjects\Backend_lab` (Spring). Live2D 모양의 계약: 모델은 `modelJsonUrl` + `scale`/`offsetX`/`offsetY`, 모션 `{group, file}`, 표정 `{name, file}`. 반응별 표정·모션은 DB(`live2d_reaction_maps`). 프론트는 카메라로 사용자의 얼굴과 손(손목 → 팔)을 매 프레임 따라 한다(`docs/specs/api.md` 18번).
