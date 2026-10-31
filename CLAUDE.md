# 프로젝트 메모

## 규칙
- 고1 "AI 앱 개발 프로젝트" 발표 과제다. 사용자는 코드 수준 설명을 하지 않으므로 코드 스타일은 작업하기 편한 쪽으로 정한다. 주석·문서는 한국어.
- AI 모델(MediaPipe, UniGaze)은 입력 처리에만 쓴다. 보정 회귀·떨림 필터·대상 선택·입 벌리기 클릭은 직접 구현한 코드로 유지하고 외부 라이브러리나 API로 바꾸지 않는다.
- 개발은 Arch Linux + Hyprland, 시연은 Windows 학교 PC + Chrome. OS별 차이는 `backend/camera.py`와 setup/start 스크립트에만 둔다. Windows 동작은 깨지 않는다.
- 순수 로직은 `extension/core.js`에 두고 `tests/core.test.cjs`에 테스트를 추가한다.
- 변경 후 두 명령이 통과해야 한다:
  - `node --test tests/core.test.cjs tests/worker.test.cjs`
  - `.venv/bin/python -m unittest discover -s tests -p 'test_*.py'` (카메라 선택 출력이 섞여 나오는 것은 정상. 마지막 `OK`만 확인)
- 작업이 끝난 후 사용자가 확인할 방법을 알려준 뒤 git 커밋한 후 git 커밋했다고 간단히 명시적으로 사용자에게 알려준다. `git add -A` 대신 바꾼 파일만 add한다(편집기 임시 파일이 섞인 적이 있다).
- 기능을 바꾸면 이 파일의 지도·상수 표와 README의 해당 부분도 같이 고친다.

## 전체 흐름
```
웹캠 ─ backend/camera.py (LatestCamera: 별도 스레드, 최신 프레임만)
     → backend/tracker.py Tracker.read()
         MediaPipe FaceMesh(478점) → 눈 열림(EyeState)·입 벌림(MouthState)  [backend/gestures.py]
         → 얼굴 정규화(solvePnP, 224×224) → UniGaze-B ONNX (별도 스레드, int8 기본) → gaze [yaw, pitch] rad
     → backend/server.py  WebSocket /ws  (127.0.0.1:8765, 새 카메라 프레임마다 frame 전송, 640×480 약 30fps)
     → extension/worker.js (서비스 워커: 소켓 1개, 현재 탭 하나에만 붙임, 보정 저장)
     → extension/content.js (페이지에 주입: 보정 화면, 커서, 대상 선택, 클릭)
         순수 계산은 extension/core.js (GazeCore), DOM 후보 수집은 extension/dom.js (GazeDOM)
```
- 시스템 마우스는 움직이지 않는다. 클릭은 `GazeDOM.press`: pointerdown·mousedown → `focus()` → pointerup·mouseup → `click()`.
- iframe 속 요소: 모든 프레임에 manifest `content_scripts`로 core·dom·`frame.js`가 들어간다. content.js `askFrames`가 `frameRelay`로 워커에 부탁 → 워커가 `chrome.tabs.sendMessage(..., {frameId})`로 frame.js에 `frameCollect`/`frameClick` 전달. 좌표는 iframe 내용 왼쪽 위만큼 옮기고, id는 content.js가 `e`+번호로 다시 붙인다(Jev 형식).
- 입을 2초 넘게 벌렸다 다물면(`MouthClick`/`Blink`의 `result === 'long'`) content.js `setMode('menu')`. 메뉴·탭·키보드 버튼은 shadow DOM `#overlay`의 `<button>`이고 `candidates()`가 페이지 요소와 같은 후보로 넣는다(`overlay: true`, 누르면 `element.click()`). 메뉴·탭 화면이면 그 버튼만 후보. 스크롤 모드는 대상 선택 대신 보이지 않는 끝내기 버튼(`scrollExit`)이 입 클릭 대상.
- 가상 키보드: 조합 중인 단어의 누른 키(`kb.jamo`)를 es-hangul `assemble`로 글자로 만들고, `textChange`로 바뀐 끝부분만 `GazeDOM.type`(execCommand delete/insertText)으로 고친다. 추천은 `words/*.json`을 `disassemble`한 자모 앞부분으로 찾는다(`suggest`).
- 대상 선택 기본은 `NearestSelector`(로컬). `USE_JEV = true`면 후보를 서버 → TypeSafe Jev API(`backend/jev.py`)로 보내 고른다.
- 클릭 기본은 입 벌리기(`MouthClick`). `CLICK_MODE = 'eyes'`면 양눈 감기(`Blink`).

## 파일 지도
| 파일 | 내용 |
|---|---|
| `backend/server.py` | FastAPI. `/health`, `/demo`(demo.html), `/ws`. origin(`chrome-extension://`)·토큰 검사, 세션 1개만(`active`), `calibrationLog` → `logs/pursuit.jsonl` 추가, `choose` → jev. 실행 시 카메라 선택 후 토큰 출력. 토큰은 `runtime.json` |
| `backend/tracker.py` | `Tracker`: 프레임 → payload. `model_path`(GAZE_INT8), `thread_count`(CPU_THREADS), `face_tensor`(RGB+ImageNet 정규화), `face_warp`/`normalize_face`(ETH-XGaze 6점 템플릿, 머리 roll/pitch/yaw/거리), `iris_offset`, `eye_ratio`. 눈 감는 중·얼굴 잃음 뒤 250ms는 시선 결과 버림(`gaze_blocked_until`), 500ms 넘은 결과도 버림 |
| `backend/gestures.py` | `EyeState`(개인별 뜬 눈 기준 = 80분위, 감는 중/감음/다시 뜸 히스테리시스, `openness`), `mouth_ratio`, `MouthState`(MAR 히스테리시스) |
| `backend/camera.py` | `open_capture`(Windows DSHOW / Linux V4L2), `find_cameras`, `pick_camera`, `choose_camera`(여러 대면 터미널에서 묻고 `CAMERA_INDEX` 환경변수 설정), `LatestCamera` |
| `backend/jev.py` | `build_request`(후보 1~8개 검증, `none` 선택지 포함), `choose`(1.5초 타임아웃) |
| `extension/manifest.json` | MV3, 권한 activeTab·scripting·storage·power, 모든 http/https 호스트, 모든 프레임에 core·dom·frame.js, `words/*.json`은 web_accessible_resources |
| `extension/worker.js` | 세션 상태(`enabled`, `activeTab`, `context`, `savedCalibration`). `start`/`stop`/`attach`/`detach`/`followFocusedTab`, 소켓 `connect`와 재연결(`retrySocket`), 페이지 재시도(`retryPage`), iframe 중계(`frameRelay`), 탭 고르기(`listTabs`/`switchTab`), 탭·창 이벤트, 화면 꺼짐 방지(`chrome.power`) |
| `extension/content.js` | 페이지 쪽 전부: 상수(`USE_JEV`, `CLICK_MODE`, `CLICK_DRIFT`, 보정 시간), shadow DOM UI(보정 화면·커서·초록 테두리·정보 패널), 9점 보정(`showPoint`→`calibrate`→`finishPoint`→`learn`→`judge`→`finishCalibration`), `frame()`(메인 루프), `candidates`·`askFrames`(iframe 후보 비동기로 받아 `frameItems`에 둠)·`unchanged`, `chooseNearest`, `click`, `showTimer`(입 벌림 진행 고리 `#timer`, 입 클릭 모드만), 필터 순환(F), ESC 중지. 메뉴·모드: `setMode`, `render`(모드마다 `#overlay`를 새로 그림), 스크롤(`aimScroll`·`scrollStep` rAF), 탭(`openTabs`·`switchTab`), 키보드(`keyboardView`, `KEY_ROWS`, `kb` 상태, `typingTarget`·`compose`·`typeKey`·`backspace`·`pickWord`, `loadWords`·`refreshWords`), `focusin`이거나 시선 클릭 뒤 초점이 입력칸이면 키보드 자동 표시(`autoKeyboard`, 이미 초점 있는 칸은 focusin이 안 나서 `click()`에서도 연다) |
| `extension/core.js` | `GazeCore`: 보정 점·순서, `gazeRecord`, `medianGaze`, `fitPoints`/`fit`/`predict`(정규화 1차 회귀 + LOO 교차검증, 16점 이상이면 2차 후보), `Blink`, `MouthClick`, `mouthPhase`(지금 다물면 wait/click/menu), `MovingAverage`, `ExponentialSmoothing`, `FixationFilter`, `jitter`, `NearestSelector`, `eyeRange`/`eyeSize`, `correctDrift`, `distanceToRect`, `suggest`(자모 앞부분 추천), `textChange`(조합 글자 바꿀 끝부분), `scrollSpeed` |
| `extension/dom.js` | `GazeDOM.collect`(클릭 가능한 요소 → 시선에서 가까운 8개), `unchanged`(클릭 직전 위치·href 그대로인지), `available`(elementFromPoint로 가려짐 검사), `regions`(링크·제목은 텍스트 줄 단위 사각형), `press`(마우스 이벤트 순서로 클릭), `editable`, `type`(execCommand로 지우기·넣기), `enter`(keydown → 처리 안 되면 폼 제출/줄바꿈), `scroller`(시선 아래 스크롤 상자) |
| `extension/vendor/es-hangul.js` | es-hangul 2.4.0의 `assemble`·`disassemble`만 묶은 IIFE(전역 `Hangul`). 워커가 content.js보다 먼저 주입. 다시 만드는 명령은 README 출처 |
| `extension/words/ko.json`, `en.json` | 추천 단어 각 2만 개(빈도순). `scripts/build_words.py`로 생성, manifest `web_accessible_resources` |
| `extension/frame.js` | 맨 위가 아닌 프레임에서만 동작. `frameCollect`(그 프레임 좌표로 후보 반환), `frameClick`(id로 `unchanged` 확인 후 `press`) |
| `extension/popup.html`, `popup.js` | 토큰 입력, 시작/다시 보정/중지, 상태·마지막 점 오차, "화면에 정보 표시" 스위치(`showInfo`), "입력칸을 누르면 키보드 표시"(`autoKeyboard`, 기본 켜짐) |
| `demo.html` | 시연·테스트 페이지(`/demo`) |
| `vendor/unigaze.py` | UniGaze-B(ViT-B/16)를 torch만으로 다시 쓴 것. 설치 때 ONNX 변환에만 사용 |
| `scripts/download_models.py` | 가중치 받기 → `models/unigaze_b16.onnx`, `unigaze_b16_int8.onnx` |
| `scripts/build_words.py` | FrequencyWords에서 추천 단어 목록 만들기 |
| `scripts/check_cpu.py` | 카메라 없이 모델 로딩·속도 점검(setup.ps1 마지막에 실행) |
| `scripts/check_camera.py` | 카메라·얼굴·시선 출력 확인 |
| `setup.ps1`/`setup.sh`, `start.ps1`/`start.sh` | uv로 Python 3.11 venv, CPU torch, requirements, 모델 변환 / 서버 실행 |

## 테스트 파일
| 파일 | 대상 |
|---|---|
| `tests/core.test.cjs` | core.js 전부(클릭 판정·메뉴용 long, 회귀, 필터, 선택기, 보정 순서·중앙값, 드리프트, 눈 크기, 추천, 조합 글자 바꾸기, 스크롤 속도) |
| `tests/worker.test.cjs` | worker.js를 가짜 `chrome`·WebSocket·타이머로 `vm`에서 실행(`harness()`). 탭 전환, 재연결, 보정 저장/폐기, 초점 처리, iframe 중계, 탭 고르기(`listTabs`/`switchTab`) |
| `tests/test_backend.py` | jev 요청, `/health`, `/demo`, 소켓 인증·정리, 보정 기록 저장, cancel |
| `tests/test_gestures.py`, `test_normalization.py`, `test_tracker_async.py`, `test_camera.py` | 눈·입 판정, 얼굴 정규화·머리 각도·텐서, 느린 모델이 눈 프레임을 막지 않는지, 카메라 선택 |
| `tests/browser.cjs` | 선택 사항. Playwright로 demo.html에 content.js를 주입하는 통합 테스트(기본 Chrome 경로가 Windows). 자동 실행 대상 아님. 보정 뒤 Jev `choose`를 기다리는 옛 내용이라 `USE_JEV = false`인 지금은 그 단계에서 실패한다 |

## 메시지
서버 ↔ 워커 (`/ws`, JSON)
- 워커 → 서버: 처음 `{type:'auth', token}` (5초 안). 이후 `choose`, `calibrationLog`, `cancel`(이전 탭 Jev 요청 취소), `stop`.
- 서버 → 워커: `status {message}`, `frame {...}`, `selection {requestId, id, error?}`, `error {error, recoverable?}`. 토큰·origin이 틀리면 close 1008.
- `frame` 필드: `valid, time(ms, 촬영 시각), eyesReady, closing, closed, openness, mouthOpen, mar, ear`. 시선이 나온 프레임에만 `gaze [yaw, pitch], gazeTime, captureAgeMs, inferenceMs, headRoll, headDistance(mm), headPitch, headYaw, iris`. 실패 시 `error`/`gazeError`.

워커 ↔ 페이지 (`chrome.tabs.sendMessage` / `runtime.sendMessage`, 모두 `context`(UUID)로 오래된 페이지 메시지를 거른다)
- 워커 → 페이지: `start {context, calibration}`, `suspend`, 그리고 서버 메시지(`status`, `frame`, `selection`)를 그대로 전달.
- 페이지 → 워커: `calibrated {model, layout}`, `calibrationInvalid`, `recalibrate`, `choose`, `calibrationLog`, `uiStatus`, `stop {reason}`, `listTabs`(→ 이 창의 http/https 탭 `[{id, title, url, active}]`), `switchTab {tabId}`(→ true/false), `frameRelay {frameId, request}`(request는 `frameCollect {x, y, radius}` → 후보 배열, `frameClick {id}` → true/false만 허용).
- 워커 → frame.js: `frameRelay`의 request를 그대로 해당 `frameId`에만 보낸다. 워커가 탭 전체로 보내는 다른 메시지에는 frame.js가 답하지 않는다.
- 팝업 → 워커(sender.tab 없음): `getStatus`, `start {tabId, token}`, `stop`, `recalibrate {tabId}`.

저장소(`chrome.storage.local`): `pairingToken`, `showInfo`, `autoKeyboard`, `calibration {model, layout}`.
- 저장된 보정은 `layout`(content.js `geometry()` = 창 크기·위치·devicePixelRatio·확대)과 `model.method`(`CALIBRATION_METHOD`)가 같을 때만 다시 쓴다. 시선 모델이나 보정 방식을 바꾸면 `CALIBRATION_METHOD` 문자열을 바꿔 예전 보정을 버리게 한다.

## 조정 값 위치
| 값 | 위치 | 현재 |
|---|---|---|
| 입 벌림/다뭄 MAR | `backend/gestures.py` `MOUTH_OPEN_MAR`/`MOUTH_CLOSED_MAR` | 0.20 / 0.12 |
| 눈 감는 중/감음/다시 뜸(뜬 눈 대비) | `backend/gestures.py` `EYE_CLOSING`/`EYE_CLOSED`/`EYE_REOPEN` | 0.60 / 0.50 / 0.62 |
| 입 클릭 시간·쿨다운 | `extension/core.js` `MOUTH_MIN_MS`/`MOUTH_MAX_MS`/`MOUTH_COOLDOWN_MS` | 500 / 2000 / 800ms (MAX 넘으면 메뉴) |
| 스크롤 띠·속도 | `extension/core.js` `SCROLL_BAND`/`SCROLL_MIN_PX`/`SCROLL_MAX_PX` | 화면 위·아래 25% / 초당 150~1200px |
| 키보드·메뉴 크기 | `extension/content.js` 스타일 `.keys{height}`, `#overlay button{font}` | 화면 75% (시선 상하 정확도가 낮아 키를 세로로 길게) / 글자 4.4vh |
| 탭 카드 수, 추천 수 | `extension/content.js` `TABS_PER_PAGE`, `core.js` `suggest`의 `count` | 8 / 5 |
| 눈 클릭 시간 | `extension/core.js` `Blink` 안 숫자 | 600~2000ms, 쿨다운 800 |
| 선택 머무름·끈적임 | `extension/core.js` `DWELL_MS`/`SWITCH_MARGIN_PX` | 300ms / 30px |
| 보정 점·순서 | `extension/core.js` `CALIBRATION_POINTS`/`CALIBRATION_ORDER` | 3×3(10/50/90%), ㄹ자 왕복 18번 |
| 보정 시간 | `extension/content.js` `POINT_SETTLE_MS`/`POINT_COLLECT_MS`/`POINT_MIN_RECORDS`/`POINT_TIMEOUT_MS` | 800 / 800ms / 3개 / 2100ms |
| 보정 첫 점 대기 | `extension/content.js` `CALIBRATION_LEAD_MS` (켜자마자 축소 애니메이션 0.8초 뒤 이만큼 더 기다린 다음, 첫 시선 결과에서 첫 점 시계 시작) | 500ms |
| 보정 통과 기준 | `extension/content.js` `judge()`의 `rms > .15` | 화면 비율 0.15 |
| 후보 탐색 반경 | `extension/content.js` `candidates()` | 100~240px, 모델 오차에 비례 |
| 떨림 필터 목록·기본 | `extension/content.js` `filterChoices`, `filterIndex` | 기본 응시 고정(120px, 3, 30) |
| 드리프트 보정 | `extension/core.js` `DRIFT_GAIN`/`DRIFT_MAX_SIZE_PX`, 켜기는 content.js `CLICK_DRIFT` | 0.5 / 200px, 꺼짐 |
| 눈 크기 경고 여유 | `extension/core.js` `EYE_MARGIN` | 0.05 |
| 시선 모델·스레드·카메라 | `.env` `GAZE_INT8`, `CPU_THREADS`, `CAMERA_INDEX`, `CAMERA_INTRINSICS`, `TYPESAFE_API_KEY` | int8, 자동(코어 절반, 2~8), 0 |

## 함정
- content.js는 탭마다 `executeScript`로 주입되고 `__gazeInstalled`로 한 번만 설치된다. 확장을 새로고침해도 이미 열린 탭에는 옛 스크립트가 남으므로 페이지도 새로고침해야 한다.
- Linux(Hyprland)에서는 팝업을 여는 것만으로 창 초점이 `WINDOW_ID_NONE`이 된다. 그래서 보정 중에는 초점을 따지지 않고(worker `calibrating()`, content `unfocused`), 팝업의 다시 보정은 `tabId`를 직접 받는다.
- UniGaze 출력은 [pitch, yaw]지만 tracker가 [yaw, pitch]로 바꿔 보낸다. 보정·기록은 모두 [좌우, 위아래] 기준.
- 회귀 입력은 시선 각도 2개뿐이다. 홍채·머리 값은 기록과 패널 표시용이다(입력으로 넣으면 9점에서 과적합했다).
- 서버는 동시에 세션 1개만 받는다. 이전 연결 정리 중이면 `recoverable` 오류를 보내고 워커가 다시 시도한다.
- content.js에는 `let history`(시선 기록 배열)가 있어 전역 `history`를 가린다. 뒤로가기는 `window.history.back()`으로 쓴다.
- 스크롤 모드에서는 `scroll` 이벤트가 `invalidate()`를 부르지 않는다(부르면 필터·입 클릭이 매번 끊긴다).
- content.js의 `stopped` 메시지 처리는 워커가 보내지 않아 쓰이지 않는다. 워커 `stop()`은 `suspend`를 보내는데 content.js가 그 `message`를 표시하지 않는다.
- `models/`에 옛 `GazeTR-H-ETH.pt`가 남아 있지만 코드는 쓰지 않는다(git 제외 폴더).
- Windows 경로에 한글이 있으면 MediaPipe가 모델 파일을 못 연다(setup/start가 검사).
