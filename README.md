# 시선 클릭

웹캠으로 시선을 읽어 Chrome 웹페이지의 버튼·링크를 고르고, **입을 벌렸다 다물면 클릭**합니다.
GPU 없이 CPU만으로 돌아갑니다.

## 빠른 시작

**1. 설치** (처음 한 번)

| Windows | Linux |
|---|---|
| [uv](https://docs.astral.sh/uv/getting-started/installation/) 설치 후, `C:\eye_cur`처럼 **영어 경로**에서 | `sudo pacman -S uv` 후 |
| `powershell -ExecutionPolicy Bypass -File .\setup.ps1` | `./setup.sh` |

Chrome `chrome://extensions` → 개발자 모드 → **압축해제된 확장 프로그램을 로드합니다** → `extension` 폴더.

**2. 실행**

| Windows | Linux |
|---|---|
| `powershell -ExecutionPolicy Bypass -File .\start.ps1` | `./start.sh` |

**3. 사용**
1. 콘솔에 나온 **연결 토큰**을 복사합니다.
2. 아무 웹페이지에서 확장 아이콘 → 토큰 입력 → **시작**.
3. 머리를 고정하고 초록 점을 차례로 바라봅니다(보정).
4. 버튼을 바라보고 입을 벌렸다 다물면 클릭. 고리가 보라색이 될 때까지 벌리고 있으면 메뉴가 열립니다.

## 문서
- [사용 설명서](docs/guide.md): 메뉴·키보드·설정·문제 해결
- [개발 기록](docs/agent/): 설계 이유와 측정 수치

시험용 페이지: 서버 실행 중 `http://127.0.0.1:8765/demo`

---
개인·연구용 시제품입니다. 시선 모델 [UniGaze](https://github.com/ut-vision/UniGaze)는 비상업 라이선스입니다. 출처는 [사용 설명서](docs/guide.md#출처)에 있습니다.
