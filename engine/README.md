# capsule-rig 엔진 (engine/)

캡슐(CAPSULE) 캐릭터용 2.5D 엔진과 플레이어입니다. 원래 별도 폴더(`capsule-rig`)였던 것을 이 저장소에 합쳤습니다. **편집기(`index.html`)와 플레이어가 같은 `engine/core.js`를 씁니다**: 편집기에서 보이는 움직임이 곧 캡슐에서 재생되는 움직임입니다.

```
레이어 PSD ──▶ 편집기(index.html)에서 조정 ──「캡슐 모델 내보내기」──▶ 묶음 ZIP ──(engine/player.js)──▶ 캡슐에서 재생
          └──(tools/build-bundle.js, CLI)────────────────────────────▶ 묶음 폴더
```

- PSD 파싱과 리깅은 **만들 때 한 번만** 합니다. 서비스에서는 묶음(`rig.json` + PNG)만 내려받아요.
- 편집기 내보내기에는 앵커 보정, 조정 파라미터(머리 물리 등), 레이어 순서·표시·불투명도·깊이가 들어갑니다. CLI는 `--settings 모델.rig.json`(편집기 점검 탭의 「설정 파일 저장」)으로 같은 결과를 냅니다.
- 캐릭터 하나에 `<canvas>` 하나를 씁니다.

## 폴더 구성

| 경로 | 내용 |
|---|---|
| `engine/core.js` | 변형 엔진 (`fadeAlpha`, `deform`, `updateSprings`, 메시 생성). DOM·WebGL 없음, Node에서도 동작. 편집기와 플레이어 공용 |
| `engine/animator.js` | 파라미터 층 관리: 기본값 → 표정 → 대기 동작 → 모션 → 깜빡임, 말하기 |
| `engine/player.js` | 브라우저 플레이어 (`CapsulePlayer`). WebGL 렌더링, 칸 맞춤, 캡슐용 API |
| `engine/bundle.js` | 묶음 쓰기 (rig.json 생성, 무손실 PNG, ZIP). 편집기와 CLI 공용 |
| `engine/tracking.js` | 카메라 손 추적 → 팔 값 (`CapsuleTracking`). 얼굴 상자 + 손목 점이면 어떤 검출기든 됨 |
| `engine/reactions.default.json` | 기본 표정 18개, 모션 12개(손 흔들기·만세·턱 괴기 포함), 반응표 7종 |
| `engine/demo/` | 스터디룸 데모(`index.html?bundles=a,b`), 표정 시트(`sheet.html`), 모션 필름(`film.html`), 팔 리깅 대시보드(`arms.html?b=sampleA`) |
| `tools/build-bundle.js` | PSD → 묶음 CLI |
| `lib/` | 편집기와 리거 (`rigger.js`, `renderer.js`, `runtime.js` 등). 플레이어도 `lib/runtime.js`, `lib/renderer.js`를 씀 |
| `tests/` | 원본 동일성(`equivalence`), 애니메이터, 묶음, 플레이어 스모크(`capsule-browser.smoke.js`) |

## 빠른 시작

```bash
# 1) 서버 (편집기 + 플레이어 데모)
npm start                                   # http://127.0.0.1:8000/  (편집기)

# 2-a) 편집기에서 PSD 열기 → 조정 → 상단 「캡슐 모델 내보내기」 → ZIP을 bundles/이름/ 에 풀기
# 2-b) 또는 CLI
node tools/build-bundle.js character.psd bundles/chaerin [--settings chaerin.rig.json]

# 3) 플레이어 데모
#    http://127.0.0.1:8000/engine/demo/index.html?bundles=chaerin,sampleA

# 4) 테스트
npm run test:node                           # 리거 · 엔진 · 묶음 (Node만)
CHROME_CHANNEL=chrome npm run test:browser  # 편집기 회귀 테스트 (playwright 필요)
CHROME_CHANNEL=chrome npm run test:player   # 플레이어 스모크 (npm start 실행 중일 때)
```

데모 기본값은 `bundles/sampleA`, `bundles/sampleB`입니다. **샘플 그림의 권리는 원작자에게 있으니 테스트용으로만 쓰고 배포하지 마세요.**

```bash
node tools/build-bundle.js sample2.psd bundles/sampleA
node tools/build-bundle.js sample.psd  bundles/sampleB
```

## 플레이어 API

```html
<script src="lib/runtime.js"></script>
<script src="lib/renderer.js"></script>
<script src="engine/core.js"></script>
<script src="engine/animator.js"></script>
<script src="engine/player.js"></script>
```

```js
const p = await CapsulePlayer.load(canvas, '/characters/chaerin/v1/', {
  focus: 'upper',      // 'upper' 상반신 | 'face' 얼굴 | 'full' 전체
  scale: 1.0,          // live2d_models.scale
  offsetX: 0, offsetY: 0, // live2d_models.offset_x / offset_y (CSS px)
  liveliness: 0.6      // 랜덤 시선 움직임 정도 (0 = 끔)
});

p.react('RETURN', 2);            // 캡슐 trigger_type + 강도
p.setExpression('pout');         // 표정 유지 (기본 표정 변경)
p.setExpression('smile', 2000);  // 2초 동안만, 이후 기본 표정으로
p.play('nod');                   // 한 번 재생하는 모션
p.talk(1500); p.talk(true); p.talk(false);   // LLM 답변 표시 중 입 움직이기
p.setLayer('sweat', 1);          // 차분 레이어 켜기 (reactions.json의 toggles)
p.setAuto('rand', false);        // idle / blink / rand / phys
p.on('reaction', r => console.log(r));
p.destroy();
```

## 배포 묶음 형식

```
bundles/chaerin/
├─ rig.json        # format: "capsule-rig", canvas, anchors, layers[], settings
├─ parts/*.png     # 파츠마다 한 장 (바운딩 박스로 잘림)
└─ reactions.json  # 표정 / 모션 / 반응표
```

- `rig.json`의 `layers[]`에는 위치, 깊이, 그룹(head/body), 물리 종류, 페이드 종류, 좌우, 머리 가닥 정보가 들어 있어요. 메시는 플레이어가 불러올 때 계산합니다(결정적이라 파일에 저장하지 않음).
- `settings`에는 캐릭터별 기본 파라미터를 넣어요. 예: `{ "physAmp": 1.5, "fhAmp": 1.2 }`
- `anchorOffsets`를 넣으면 자동 검출한 기준점을 보정할 수 있어요 (원본 편집기의 기준점 편집과 같은 키).

### 팔 리그

- 리거가 `handwear`를 좌우(`handwear_l`/`handwear_r`, 화면 기준 왼쪽이 L)로 나누고 `anchors.armL`/`armR`에 `{shoulder, elbow, wrist, width, cut, elbowBy}`를 넣습니다. 팔이 화면 밖으로 잘리면 `cut: true`이고 손목은 추정값입니다. 손은 만들지 않습니다.
- `handwear`에 몸통까지 들어 있는 PSD(가운데 띠에 픽셀이 10% 넘게 있음)는 실루엣 안쪽 띠에서 팔과 몸 사이의 선(옷 주름·윤곽선)을 따라 팔을 잘라 냅니다(`carveArms`). 남은 부분은 `topwear` 파츠가 되고, 팔 뒤 몸통 옆면은 경계 색으로 조금 채웁니다. 잘라 낸 파츠는 `carved: true`. 잘라 내지 못하면 예전처럼 팔 리그를 끄고 경고를 남깁니다.
- 파라미터 (모두 0이면 원본과 같은 결과):
  - FK: `armLShoulder`/`armRShoulder` 어깨 회전(도, + = 바깥으로 들기), `armLElbow`/`armRElbow` 팔꿈치(도, + = 몸 안쪽으로 굽힘)
  - IK: `armLX`/`armLY`, `armRX`/`armRY` 손목 목표 = 기본 손목 + (바깥, 위) × 팔 길이. 카메라 손 추적은 이 값을 넣으면 됩니다.
- IK는 팔꿈치를 "두 뼈가 닿을 수 있는 영역 안에서 자연스러운 팔꿈치에 가장 가까운 점"에 둡니다. 닿지 않아 뼈가 짧아지면 카메라 쪽으로 향한 것으로 보고 원근으로 줄여 그립니다. 해가 하나라 팔꿈치가 튀지 않습니다.
- 관절 보정 키: `anchorOffsets.armLShoulder|armLElbow|armLWrist`(R도 같음) `{dx, dy}`.

### 카메라 손 추적 (`engine/tracking.js`)

캡슐 프론트가 카메라로 사용자의 손목을 따라 할 때 쓰는 변환입니다. 편집기 「움직여 보기」의 카메라도 같은 코드를 씁니다 (MediaPipe FaceMesh + Hands).

```js
const arms = CapsuleTracking.createArmTracker();
// 카메라 프레임마다: 좌표는 영상 그대로(좌우 반전 X), x에는 영상 가로세로비를 곱해 둠
const face = CapsuleTracking.faceBoxFromMesh(faceLandmarks, aspect);          // {cx, cy, w, h}
const hands = CapsuleTracking.wristsFromHands(handsResults, aspect);          // [{x, y, label, score}]
arms.update({ face, hands }, performance.now() / 1000);
// 그릴 때마다
player.setParams(CapsuleTracking.armParams(player.model, arms.last));          // armLX/LY/RX/RY
```

- 거울 규칙: 사용자의 오른손(영상 왼쪽)이 아바타의 화면 왼쪽 팔(L)을 움직입니다. 얼굴 추적과 같습니다.
- 사용자 몸 크기는 얼굴에서 추정합니다 (어깨 = 얼굴 중심에서 옆으로 1.4 얼굴 폭, 아래로 1 얼굴 높이 / 팔 길이 = 4 얼굴 폭). 손목의 "어깨 기준 위치 ÷ 팔 길이"를 아바타의 어깨·팔 길이에 그대로 옮깁니다.
- 손이 사라지면 0.25초 기다렸다가 0.6초에 걸쳐 기본 자세로 돌아갑니다 (`presence`). 팔 관절이 없는 모델은 아무 값도 내지 않습니다.

### 표정 파라미터

모두 기본값 0이면 원본과 같은 결과입니다 (「움직여 보기」·「표정·모션」 탭 값이라 `settings`에 구워지지 않음).

| 키 | 범위 | 뜻 |
|---|---|---|
| `eyeSmile` | 0..1 | 눈웃음: 뜬 눈은 아래 눈꺼풀이 호를 그리며 올라가고(흰자가 눈동자를 가림), 감은 눈은 ∩ 모양으로 휨 |
| `mouthWide` | -1..1 | 입 너비 (+ 넓게, − 작고 둥글게. 벌린 입은 좁아지면 세로로 길어짐) |
| `mouthTri` | -1..1 | 벌린 입 세모 (+ ▽, − △) |
| `cheekPuff` | 0..1 | 볼 부풀리기 (얼굴 윤곽이 눈과 입 사이에서 바깥으로) |
| `browAngSym` | -1..1 | (기존) + 화남(안쪽이 내려감), − 걱정·슬픔 |
| `fxBlush` `fxSweat` `fxTears` `fxAnger` `fxGloom` | 0..1 | 효과 레이어 진하기: 홍조, 땀방울, 눈물, 화남 표시(💢), 그늘 세로선 |

효과 레이어(`fade: "fx"`, `fx: "fxBlush"` …)는 리거가 얼굴·눈 기준점에 맞춰 그려 넣습니다(`synthetic: true`). PSD에 `sweat`/`땀`/`汗`, `tears`/`눈물`/`涙`, `anger`/`화남`, `gloom`/`그늘`/`縦線`, `blushfx`/`홍조`/`照れ` 이름의 레이어가 있으면 그림 대신 그 레이어를 씁니다. 땀은 미끄러져 내려오고, 눈물·그늘은 아래로 자라고, 💢는 튀어나오며 나타납니다.

## reactions.json 형식

```jsonc
{
  "expressions": {                       // 유지되는 표정 = 파라미터 목표값
    "pout": { "label": "삐짐",            // 편집기에 보이는 이름 (선택)
              "params": { "eyeOpenL": 0.7, "brow": -0.45, "mouthCForm": -1, "cheekPuff": 1 },
              "layers": { "blush": 1 } } // toggles에 있는 레이어 켜기 (선택)
  },
  "motions": {                           // 한 번 재생하는 동작 = 키프레임
    "nod": {
      "duration": 900, "fadeIn": 120, "fadeOut": 200,
      "mode": "add",                     // add: 대기 동작 위에 더하기 / override: 덮어쓰기
      "tracks": { "angleY": [[0, 0], [220, -0.45, "easeOut"], [900, 0]] },  // [ms, 값, 곡선]
      "events": [{ "t": 300, "talk": 1500 }, { "t": 100, "layer": "sweat", "value": 1 }]
    }
  },
  "reactions": {                         // trigger_type → 후보 (weight로 랜덤)
    "GAZE_AWAY": [
      { "intensity": 1, "motion": "glanceAtUser", "expression": "stare",   "hold": 1600 },
      { "intensity": 3, "motion": "lookDownSulk", "expression": "pout",    "hold": 2600, "then": "softSmile" }
    ]
  },
  "toggles": ["sweat", "blush"]          // 평소에는 숨기고 이벤트/표정으로 켜는 레이어
}
```

곡선: `linear`, `easeIn`, `easeOut`, `easeInOut`(기본), `step`. 강도가 정확히 없으면 그보다 낮은 것 중 가장 가까운 강도를 씁니다.

## 원본에서 바뀐 점 (깎은 부분)

| 변경 | 이유 |
|---|---|
| 전역 상태 → 캐릭터별 `Model` 객체 | 한 화면에 여러 캐릭터 |
| PSD 실시간 파싱 → 빌드 시 묶음 생성 | 로딩 속도, 서비스 배포 |
| 카메라, 마이크, OBS, 녹화, 편집 UI 제거 | 캡슐 플레이어에 불필요 |
| 표정 / 모션 / 반응표 / 말하기 / 토글 레이어 추가 | 캡슐 상황 반응 |
| **`mouthCForm`** (다문 입 휘기) 추가 | 원본은 다문 입 모양을 못 바꿔서 삐짐 입이 불가능했음. 기본값 0이면 원본과 동일 |
| 입 레이어 메시 세분화 (최소 12×4) | 작은 입을 휠 때 가운데가 꺾이던 문제 |
| 표정 파라미터 `eyeSmile`·`mouthWide`·`mouthTri`·`cheekPuff`, 효과 레이어 `fx*` | 눈웃음·세모 입·볼 부풀리기·홍조·땀·눈물·💢·그늘. 기본값 0이면 원본과 동일 |
| 팔 리그 (FK + IK), 몸통에 섞인 팔 잘라 내기 | 손 흔들기·만세 같은 모션, 카메라 손 추적 |
| 칸 맞춤 (`focus`, `scale`, `offset`) | 스터디룸 칸 크기에 맞추기 |

`tests/equivalence.test.js`는 원본 `app.js`의 함수 원문(`tests/fixtures/upstream-deform.js`)을 같은 입력으로 돌리고, **모든 꼭짓점이 비트 단위로 같은지** 확인합니다(300프레임, 물리 포함). 엔진 수식을 고칠 때는 이 테스트가 통과하는지 꼭 보세요. 의도적인 확장은 `Core.EXTENSIONS`에 등록하고 기본값을 0으로 둡니다.

## 캡슐 DB와의 대응

| 지금 테이블 | 이 엔진에서 |
|---|---|
| `live2d_models` (`storage_prefix`, `model_json_path`, `scale`, `offset_x/y`) | 그대로 사용 가능. 진입 파일이 `rig.json`. 이름은 `character_models` 등 엔진 중립으로 바꾸는 걸 권장 |
| `live2d_motions` (`.motion3.json` 경로) | `reactions.json`의 `motions` 키 |
| `live2d_expressions` (`.exp3.json` 경로) | `reactions.json`의 `expressions` 키 |
| `live2d_reaction_maps` (트리거, 강도, 모션, 표정, weight) | 구조 그대로. `reactions.json`의 `reactions`로 내보내거나, API로 받아서 `react()` 대신 `play()` + `setExpression()` 호출 |

## 알려진 한계와 다음 단계

- **팔 앞뒤 순서**: 팔 레이어는 그려진 대로 몸통 뒤에 있고, 손이 몸 안쪽으로 오거나 위팔이 카메라 쪽을 향하면 아래팔만 맨 위에 한 번 더 그립니다(`Core.armFront`, 팔꿈치 가중치를 꼭짓점 알파로 사용).
- **손**: 손이 없는 그림(팔이 화면 밖으로 잘림)은 손을 만들지 않으므로, 팔을 들면 잘린 끝이 보입니다.
- **큰 고개 돌림**: 깊이 기반 패럴랙스라 ±20도 정도가 자연스러운 한계.
- **표정 차분**: `^^` 눈웃음, 눈물, 땀은 PSD에 레이어를 추가하고 `toggles`로 켜는 방식이 들어가 있어요. 레이어를 AI로 생성하는 도구는 아직 없음.
- **눈썹이 앞머리에 가려지는 그림**에서는 눈썹 표정이 잘 안 보여요.
- WebGL 컨텍스트를 캐릭터마다 하나씩 씁니다. 3명까지는 문제없지만, 더 많아지면 컨텍스트 하나에 모으는 작업이 필요해요.

## 라이선스

- 저장소 전체: MIT (`LICENSE`). 원본 Anime2.5DRig, Copyright (c) 2026 hakoniwa.
- `tests/fixtures/upstream-deform.js`: 원본 `lib/app.js`(커밋 7ddbd99)의 변형 함수 사본. 동일성 테스트의 기준이라 고치지 않습니다.
- `lib/ag-psd.min.js`: ag-psd, MIT
