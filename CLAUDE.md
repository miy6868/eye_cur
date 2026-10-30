# 프로젝트 메모
- 고1 "AI 앱 개발 프로젝트" 발표 과제다. 내가 코드를 직접 설명해야 하므로 새 코드는 짧고 읽기 쉽게 쓰고, 핵심 줄에 한국어 주석으로 "왜"를 적는다. 한 줄에 여러 일을 몰아넣지 않는다.
- 구조: backend/(Python: 웹캠 → MediaPipe 얼굴 점 → UniGaze-B 시선 각도(ONNX Runtime), 눈 감김 판단) + extension/(Chrome 확장: 보정 회귀, 커서, 대상 선택, 입 벌리기 클릭). 시스템 커서는 움직이지 않고 웹페이지 요소를 클릭한다.
- AI 모델(MediaPipe, UniGaze)은 입력 처리에만 쓴다. 보정 회귀·떨림 필터·대상 선택·입 벌리기 클릭은 직접 구현한 코드로 유지하고 외부 라이브러리나 API로 바꾸지 않는다.
- 개발은 Arch Linux + Hyprland, 시연은 Windows 학교 PC + Chrome. OS별 차이는 backend/camera.py와 setup/start 스크립트에만 둔다. Windows 동작은 깨지 않는다.
- 순수 로직은 extension/core.js에 두고 tests/core.test.cjs에 테스트를 추가한다. 변경 후 `node --test tests/core.test.cjs tests/worker.test.cjs`와 `.venv/bin/python -m unittest discover -s tests -p 'test_*.py'`가 통과해야 한다.
- 한 번에 한 단계만 하고, 끝나면 내가 확인할 방법을 알려준 뒤 git 커밋한다.
- 최대한 빨리 작업한다.

