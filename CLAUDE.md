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
- 사용자가 확인하는 방법을 이미 몇번 알려준 적이 있고, 알려줄 방법이 똑같다면 아주 간략하게 말하도록 한다.
- 파일의 역할, 메시지 형식, 코드만 봐선 모르는 사실(아래 지도·함정)이 바뀌면 이 파일과 README의 해당 부분도 같이 고친다. 함수 이름·현재 값은 이 파일에 적지 않는다(grep과 config.toml로 본다).

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
- iframe 속 요소: 모든 프레임에 manifest `content_scripts`로 core·dom·`frame.js`가 들어간다. content.js `askFrames`가 `frameRelay`로 워커에 부탁 → 워커가 `chrome.tabs.sendMessage(..., {frameId})`로 frame.js에 `frameCollect`/`frameClick` 전달. 좌표는 iframe 내용 왼쪽 위만큼 옮기고, id는 content.js가 `e`+번호로 다시 붙인다(맨 위 페이지 요소 id와 겹치지 않게).
- 입을 2초 넘게 벌렸다 다물면(`MouthClick`/`Blink`의 `result === 'long'`) content.js `setMode('menu')`. 메뉴·탭·키보드 버튼은 shadow DOM `#overlay`의 `<button>`이고 `candidates()`가 페이지 요소와 같은 후보로 넣는다(`overlay: true`, 누르면 `element.click()`). 메뉴·탭 화면이면 그 버튼만 후보. 스크롤 모드는 대상 선택 대신 보이지 않는 끝내기 버튼(`scrollExit`)이 입 클릭 대상.
- 가상 키보드: 조합 중인 단어의 누른 키(`kb.jamo`)를 es-hangul `assemble`로 글자로 만들고, `textChange`로 바뀐 끝부분만 `GazeDOM.type`(execCommand delete/insertText)으로 고친다. 추천은 `words/*.json`을 `disassemble`한 자모 앞부분으로 찾는다(`suggest`).
- 대상 선택은 `NearestSelector`(로컬). 외부 API는 쓰지 않는다(예전 Jev API 연동은 삭제).
- 클릭 기본은 입 벌리기(`MouthClick`). config.toml `[click] mode = "eyes"`면 양눈 감기(`Blink`).

## 파일 지도
| 파일 | 역할 · 코드만 봐선 모르는 것 |
|---|---|
| `backend/server.py` | FastAPI 서버(`/health`, `/demo`, `/ws`). 세션은 동시에 1개만. 인증(origin + `runtime.json` 토큰) 뒤 맨 먼저 `settings`를 보낸다. 보정 기록은 `logs/pursuit.jsonl`에 한 줄씩 쌓인다 |
| `backend/tracker.py` | 카메라 프레임 → `frame` 메시지. 시선 모델은 별도 스레드라 느려도 눈·입 판정 프레임은 막히지 않는다. 눈 감는 중·얼굴 잃음 직후 250ms와 500ms 넘게 늦은 시선 결과는 버린다 |
| `backend/gestures.py` | 눈·입 판정. 눈은 사람마다 평소 뜬 눈(80분위)을 기준으로 삼고, 눈·입 모두 문턱값 두 개로 상태가 깜빡이지 않게 한다 |
| `backend/camera.py` | OS별 카메라 열기(Windows DSHOW / Linux V4L2)와 최신 프레임만 남기는 읽기 스레드. 시작 때 고른 카메라 번호는 `CONFIG`에만 넣고 config.toml 파일은 바꾸지 않는다 |
| `backend/config.py`, `config.toml` | 모든 사용자 설정. config.toml은 git에 포함되고 사용자가 직접 고친다(BOM 있어도 읽음) |
| `extension/manifest.json` | MV3. core·dom·frame.js는 모든 프레임에 자동으로 들어가고, content.js는 워커가 지금 탭에만 주입한다. `words/*.json`은 web_accessible_resources |
| `extension/worker.js` | 서비스 워커: 서버 소켓 1개, 지금 보는 탭 하나에만 붙인다. 보정·서버 `settings`를 기억했다가 새로 붙는 탭에 넘긴다. iframe 중계, 탭 목록·전환, 실행 중 화면 꺼짐 방지 |
| `extension/content.js` | 페이지 쪽 전부(보정 화면, 커서, 대상 선택, 클릭, 메뉴·스크롤·탭·키보드 화면). UI는 닫힌 shadow DOM. 화면에 띄운 버튼도 페이지 요소와 같은 후보로 골라 입 클릭으로 누른다. 이미 초점이 있는 입력칸은 focusin이 다시 안 나서 시선 클릭 뒤에도 키보드를 연다 |
| `extension/core.js` | DOM 없는 순수 계산(보정 회귀, 클릭 판정, 필터, 대상 선택, 추천 등). Node 테스트도 같은 파일을 `require`한다. `SETTINGS`는 서버 값이 오기 전 기본값 |
| `extension/dom.js` | DOM 도우미(후보 수집, 가려짐 검사, 클릭 이벤트, 글자 입력, 스크롤 상자 찾기). 글자는 execCommand로 넣어야 React·contenteditable 편집기도 받아들인다 |
| `extension/frame.js` | 맨 위가 아닌 프레임에서만 동작. 워커가 중계한 `frameCollect`/`frameClick`에만 답한다 |
| `extension/vendor/es-hangul.js` | es-hangul의 `assemble`·`disassemble`만 묶은 파일(전역 `Hangul`). 다시 만드는 명령은 README 출처 |
| `extension/words/ko.json`, `en.json` | 추천 단어(빈도순). `scripts/build_words.py`로 생성, CC-BY-SA 4.0 |
| `extension/popup.html`, `popup.js` | 토큰 입력, 시작/다시 보정/중지, 상태, 스위치 두 개(정보 표시, 키보드 자동 표시) |
| `demo.html` | 시연·테스트 페이지(`/demo`) |
| `vendor/unigaze.py` | UniGaze-B를 torch만으로 다시 쓴 것. 설치 때 ONNX 변환에만 쓴다 |
| `scripts/` | `download_models.py`(가중치 → ONNX), `build_words.py`(추천 단어), `check_cpu.py`(카메라 없이 모델 점검, setup.ps1 마지막에 실행), `check_camera.py`(카메라·얼굴·시선 확인) |
| `setup.*`, `start.*` | uv로 Python 3.11 venv·CPU torch·requirements·모델 변환 / 서버 실행 |

## 테스트 파일
| 파일 | 대상 |
|---|---|
| `tests/core.test.cjs` | core.js 전부(클릭 판정·메뉴용 long, 회귀, 필터, 선택기, 보정 순서·중앙값, 드리프트, 눈 크기, 추천, 조합 글자 바꾸기, 스크롤 속도) |
| `tests/worker.test.cjs` | worker.js를 가짜 `chrome`·WebSocket·타이머로 `vm`에서 실행(`harness()`). 탭 전환, 재연결, 보정 저장/폐기, 초점 처리, iframe 중계, 탭 고르기(`listTabs`/`switchTab`) |
| `tests/test_backend.py` | `/health`, `/demo`, 소켓 인증·정리·처음 `settings`, 보정 기록 저장 |
| `tests/test_gestures.py`, `test_normalization.py`, `test_tracker_async.py`, `test_camera.py` | 눈·입 판정, 얼굴 정규화·머리 각도·텐서, 느린 모델이 눈 프레임을 막지 않는지, 카메라 선택 |

## 메시지
서버 ↔ 워커 (`/ws`, JSON)
- 워커 → 서버: 처음 `{type:'auth', token}` (5초 안). 이후 `calibrationLog`, `stop`.
- 서버 → 워커: `settings {click, select, calibration, scroll, keyboard, shortcuts}`(인증 직후 한 번), `status {message}`, `frame {...}`, `error {error, recoverable?}`. 토큰·origin이 틀리면 close 1008.
- `frame` 필드: `valid, time(ms, 촬영 시각), eyesReady, closing, closed, openness, mouthOpen, mar, ear`. 시선이 나온 프레임에만 `gaze [yaw, pitch], gazeTime, captureAgeMs, inferenceMs, headRoll, headDistance(mm), headPitch, headYaw, iris`. 실패 시 `error`/`gazeError`.

워커 ↔ 페이지 (`chrome.tabs.sendMessage` / `runtime.sendMessage`, 모두 `context`(UUID)로 오래된 페이지 메시지를 거른다)
- 워커 → 페이지: `start {context, calibration, settings}`(워커가 기억한 마지막 `settings`), `suspend`, 그리고 서버 메시지(`settings`, `status`, `frame`)를 그대로 전달.
- 페이지 → 워커: `calibrated {model, layout}`, `calibrationInvalid`, `recalibrate`, `calibrationLog`, `uiStatus`, `stop {reason}`, `listTabs`(→ 이 창의 http/https 탭 `[{id, title, url, active}]`), `switchTab {tabId}`(→ true/false), `frameRelay {frameId, request}`(request는 `frameCollect {x, y, radius}` → 후보 배열, `frameClick {id}` → true/false만 허용).
- 워커 → frame.js: `frameRelay`의 request를 그대로 해당 `frameId`에만 보낸다. 워커가 탭 전체로 보내는 다른 메시지에는 frame.js가 답하지 않는다.
- 팝업 → 워커(sender.tab 없음): `getStatus`, `start {tabId, token}`, `stop`, `recalibrate {tabId}`.

저장소(`chrome.storage.local`): `pairingToken`, `showInfo`, `autoKeyboard`, `calibration {model, layout}`.
- 저장된 보정은 `layout`(content.js `geometry()` = 창 크기·위치·devicePixelRatio·확대)과 `model.method`(`CALIBRATION_METHOD`)가 같을 때만 다시 쓴다. 시선 모델이나 보정 방식을 바꾸면 `CALIBRATION_METHOD` 문자열을 바꿔 예전 보정을 버리게 한다.

## 조정 값 위치
사용자가 바꿀 값은 모두 `config.toml`에 있다(뜻은 그 파일 주석). `[mouth]`·`[eyes]`는 `backend/gestures.py`가 읽고, `[click]`·`[select]`·`[calibration]`·`[scroll]`·`[keyboard]`·`[shortcuts]`는 서버가 `settings` 메시지로 확장에 보내 `core.js` `configure()`가 덮어쓴다. `core.js` `SETTINGS`의 숫자는 서버 값이 오기 전·테스트용 기본값이라 config.toml과 달라도 된다. 값을 하나 더 늘릴 때는 config.toml, `SETTINGS`, 쓰는 곳을 같이 고친다. 바로가기는 `SETTINGS`가 아니라 `SHORTCUTS` 배열(http/https만, 최대 9개).

config.toml 밖에 있는 값:
| 값 | 위치 |
|---|---|
| 메뉴 버튼 글자 크기 | `extension/content.js` 스타일 `#overlay button{font}` |
| 탭 카드 수, 추천 수 | `extension/content.js` `TABS_PER_PAGE`, `core.js` `suggest`의 `count` |
| 보정 점·순서 | `extension/core.js` `CALIBRATION_POINTS`/`CALIBRATION_ORDER` |
| 후보 탐색 반경 | `extension/content.js` `candidates()` |
| 떨림 필터 목록·기본 | `extension/content.js` `filterChoices`, `filterIndex` |
| 드리프트 보정 | `extension/core.js` `DRIFT_GAIN`/`DRIFT_MAX_SIZE_PX`, 켜기는 content.js `CLICK_DRIFT` |
| 눈 크기 경고 여유 | `extension/core.js` `EYE_MARGIN` |

## 함정
- content.js는 탭마다 `executeScript`로 주입되고 `__gazeInstalled`로 한 번만 설치된다. 확장을 새로고침해도 이미 열린 탭에는 옛 스크립트가 남으므로 페이지도 새로고침해야 한다.
- Linux(Hyprland)에서는 팝업을 여는 것만으로 창 초점이 `WINDOW_ID_NONE`이 된다. 그래서 보정 중에는 초점을 따지지 않고(worker `calibrating()`, content `unfocused`), 팝업의 다시 보정은 `tabId`를 직접 받는다.
- UniGaze 출력은 [pitch, yaw]지만 tracker가 [yaw, pitch]로 바꿔 보낸다. 보정·기록은 모두 [좌우, 위아래] 기준.
- 회귀 입력은 시선 각도 2개뿐이다. 홍채·머리 값은 기록과 패널 표시용이다(입력으로 넣으면 9점에서 과적합했다).
- 서버는 동시에 세션 1개만 받는다. 이전 연결 정리 중이면 `recoverable` 오류를 보내고 워커가 다시 시도한다.
- 스크롤 모드에서는 `scroll` 이벤트가 `invalidate()`를 부르지 않는다(부르면 필터·입 클릭이 매번 끊긴다).
- content.js의 `stopped` 메시지 처리는 워커가 보내지 않아 쓰이지 않는다. 워커 `stop()`은 `suspend`를 보내는데 content.js가 그 `message`를 표시하지 않는다.
- `models/`에 옛 `GazeTR-H-ETH.pt`가 남아 있지만 코드는 쓰지 않는다(git 제외 폴더).
- Windows 경로에 한글이 있으면 MediaPipe가 모델 파일을 못 연다(setup/start가 검사).
