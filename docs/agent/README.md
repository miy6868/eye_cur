# 개발 기록 (agent용)

코드만 봐선 모르는 **이유와 측정 결과**를 분야별로 남긴다. 다시 시도해서 실패하지 않도록 하는 것이 목적이다.
파일 역할·메시지 형식·함정은 저장소 맨 위 `CLAUDE.md`에 있다.

- 지금 설정값은 적지 않는다(`config.toml`과 코드를 본다). 숫자는 실험 당시 값과 측정 결과만 적는다.
- 새로 실험하거나 방식을 바꾸면 해당 파일에 이유와 수치를 더한다.

| 파일 | 분야 |
|---|---|
| [gaze-model.md](gaze-model.md) | 시선 모델 선택, 속도, int8, 얼굴 정규화 |
| [calibration.md](calibration.md) | 보정 방식, 순서, 기다리는 시간, 회귀 입력 |
| [gestures.md](gestures.md) | 눈·입 판정 문턱값 |
| [selection.md](selection.md) | 대상 후보, 선택, 클릭 취소, iframe |
| [keyboard.md](keyboard.md) | 가상 키보드, 한글 조합 라이브러리, 추천 단어 |
