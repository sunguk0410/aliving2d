# Capsule Model Studio — Claude Code 안내

## 목표
애니풍 캐릭터 그림 한 장 → 파츠 PSD(see-through) → 자동 리깅 → **캡슐(CAPSULE) 앱용 모델 묶음**을 만드는 개인용 로컬 도구. 배포하지 않는다.
- **우선순위는 모델 품질**이다 (팔 움직임, 다양한 표정). 속도보다 품질.
- 표정·모션 이름은 캡슐 백엔드의 이름과 맞출 필요 없음.
- 사용자와의 대화는 한국어. 편집기 UI는 원본의 일본어가 대부분이고 새로 추가한 UI는 한국어.

## 구조
| 경로 | 내용 |
|---|---|
| `index.html`, `lib/app.js` | 편집기 (원본 Anime2.5DRig). 변형 수식은 직접 갖지 않고 `engine/core.js`를 호출 |
| `lib/rigger.js` | PSD → rig (레이어 이름 해석, 좌우 분리, 머리 가닥, 앵커). DOM 없음, Node 테스트 가능 |
| `lib/psd-worker.js` | 브라우저에서 PSD 파싱 + 리깅 (Web Worker) |
| `engine/core.js` | **변형 엔진 (편집기·플레이어 공용)**. 메시 생성, fadeAlpha, deform, updateSprings |
| `engine/animator.js` | 파라미터 층: 기본값 → 표정 → 대기 동작 → 모션 → 깜빡임·말하기 |
| `engine/player.js` | 캡슐 프론트용 플레이어 `CapsulePlayer` |
| `engine/bundle.js` | 묶음 쓰기 (rig.json, 무손실 PNG, ZIP). 편집기 「캡슐 모델 내보내기」와 CLI 공용 |
| `tools/build-bundle.js` | PSD → 묶음 CLI (`--settings`로 편집기 설정 적용) |
| `engine/demo/` | 플레이어 데모 `index.html?bundles=a,b`, 팔 리깅 확인 페이지 `arms.html?b=sampleA` |
| `seethrough/server.py` | see-through 변환 서버 (그림 → 파츠 PSD). 표준 라이브러리만. Colab·GPU 데스크톱·`--mode fake` 공용 |
| `seethrough/see_through_colab.ipynb` | Colab 노트북. `seethrough/build_colab.py`가 server.py를 끼워 넣어 생성 (server.py 고치면 `npm run build:colab`) |
| `lib/seethrough.js` | 편집기 쪽 클라이언트. 연결 코드 = `<url>#<token>` |
| `third_party/see-through` | see-through 원본 (git submodule, Apache-2.0). 가중치는 저장소에 없음, 실행 시 Hugging Face에서 받음 |

묶음 형식: `rig.json`(canvas, anchors, anchorOffsets, settings, layers[]) + `parts/*.png` + `reactions.json`. 자세한 건 `engine/README.md`.

## 규칙
- 엔진 수식을 바꾸면 `tests/equivalence.test.js`가 통과해야 한다. 원본 수식(`tests/fixtures/upstream-deform.js`, 고치지 말 것)과 비트 단위로 같은지 본다. 새 기능은 `Core.DEFAULTS`/`RANGES`에 넣고 **기본값에서는 원본과 같은 결과**가 나오게 하며 `Core.EXTENSIONS`에 등록한다.
- 새 파라미터는 편집기 슬라이더(`index.html` + `lib/app.js`의 `P`, `sliders`)와 `engine/core.js`의 `DEFAULTS`/`RANGES`에 같이 넣는다. 포즈·표정용이면 `engine/bundle.js`의 `POSE_KEYS`에도 넣는다(묶음 settings에 구워지지 않게).
- `sample.psd`, `sample2.psd`는 원작자 그림이다. **커밋 금지** (`.gitignore`). 테스트용으로 로컬에만 둔다.
- `LICENSE`의 원작자(hakoniwa) 줄은 지우지 않는다.
- 내부 형식 이름(`anime25d-settings`, `anime25d-relay-v2`, localStorage `anime25d.*`)은 호환성 때문에 바꾸지 않는다.

## 명령
```bash
npm start                                   # http://127.0.0.1:8000/ (편집기), /engine/demo/ (플레이어)
npm run test:node                           # 리거·엔진·묶음
npm run test:python                         # 로컬 서버
npm install --no-save playwright@1.49.1     # 브라우저 테스트용 (설치된 Chrome 사용)
CHROME_CHANNEL=chrome npm run test:browser  # 편집기 회귀 (47개 + OBS + 얼굴 추적)
CHROME_CHANNEL=chrome npm run test:player   # 플레이어 스모크 (npm start 실행 중, DEMO_URL로 ?bundles= 지정 가능)
CHROME_CHANNEL=chrome npm run test:seethrough  # 시작 화면: 그림 → fake 변환 서버 → 리깅 (npm start 실행 중)
python seethrough/server.py --mode fake --fake-psd sample2.psd --token ''   # GPU 없이 변환 흐름 시험
node tools/build-bundle.js sample2.psd bundles/sampleA   # 데모용 샘플 묶음
```

## 관련 프로젝트
- **캡슐 백엔드**: `C:\Users\kkcc4\IdeaProjects\Backend_lab` (Spring). Live2D 모양의 계약을 쓴다. 모델은 `modelJsonUrl` + `scale`/`offsetX`/`offsetY`, 모션은 `{group, file}`, 표정은 `{name, file}`이다. 어떤 반응에 어떤 표정·모션을 쓸지는 DB(`live2d_reaction_maps`)가 고른다. 아바타는 프론트가 카메라로 사용자의 **얼굴과 손(손목 위치 → 팔 값)**을 매 프레임 따라 한다(`docs/specs/api.md` 18번). 그래서 팔 리깅이 중요하다.
- 예전 폴더 `Anime2.5DRig`, `capsule-rig`는 참고용. 작업은 이 저장소에서만.

## 환경
- 이 노트북: Intel 내장 그래픽, RAM 7.5GB, **NVIDIA GPU 없음** → see-through(VRAM 8~16GB 필요)는 여기서 못 돌린다. 계획: Colab 노트북 → 나중에 사용자의 GPU 데스크톱. 실행 위치를 바꿔 끼울 수 있게 만든다.

## 진행 상황
- [x] capsule-rig 엔진 통합, 편집기가 공용 엔진 사용, 「캡슐 모델 내보내기」(2026-11-13)
- [x] 팔 리깅 1~3단계 (2026-11-13): 좌우 분리, 어깨·팔꿈치·손목 검출(편집기 앵커로 보정), FK 각도 + 원근 IK(`armLX/LY` 등), 대시보드 `engine/demo/arms.html`. sample2는 팔 뒤 몸통이 채워져 있음 확인. sample.psd는 handwear에 몸통이 섞여 팔 리그 꺼짐
- [x] 팔 앞뒤 순서 (2026-11-13): 손이 몸 안쪽으로 오거나 위팔이 카메라 쪽(원근 단축)이면 아래팔을 맨 위에 한 번 더 그림 (`Core.armFront`, 렌더러 꼭짓점 알파). 손이 없는(잘린) 그림은 손을 만들지 않음
- [ ] 표정 다양화: 눈웃음·입 모양 파라미터, 홍조·땀·눈물 같은 효과 자동 배치, 편집기에서 표정·모션을 만들어 `reactions.json`으로 저장
- [x] see-through 연동 (2026-11-13): 편집기 시작 화면에 그림을 넣으면 변환 서버(Colab 노트북)로 PSD를 만들어 바로 리깅. **실제 Colab GPU 실행은 아직 사용자가 확인 전**
