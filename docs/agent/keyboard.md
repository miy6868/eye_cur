# 가상 키보드

## 배치
- 일반 자판(두벌식/QWERTY)을 크게. 시선은 위아래가 좌우보다 덜 정확해서 키를 세로로 길게 만들었다.
- 입력칸이 화면 아래쪽이면 키보드가 위로 간다.
- 지우기는 조합 중이면 자모 하나, 아니면 글자 하나. 엔터는 사이트가 처리하면(메시지 보내기 등) 그대로, 아니면 검색칸은 제출, 여러 줄 칸은 줄바꿈.
- 구글 검색칸처럼 이미 초점이 들어가 있는 칸은 focusin이 다시 안 나서, 시선 클릭 뒤에도 키보드를 연다.
- 맨 위 문서의 입력칸에만 쓴다. iframe·Shadow DOM 속 입력칸은 안 된다.

## 한글 조합: es-hangul
[es-hangul](https://github.com/toss/es-hangul) 2.4.0(MIT)의 `assemble`·`disassemble`만 esbuild로 묶은 것이 `extension/vendor/es-hangul.js`(전역 `Hangul`). 다시 만드는 명령:
```bash
echo "export {assemble, disassemble} from 'es-hangul';" > entry.js && npx esbuild entry.js --bundle --minify --format=iife --global-name=Hangul --outfile=extension/vendor/es-hangul.js
```

## 추천 단어
- [hermitdave/FrequencyWords](https://github.com/hermitdave/FrequencyWords)(OpenSubtitles 2018 빈도, CC-BY-SA 4.0). `scripts/build_words.py`가 한국어·영어 상위 단어(두 글자 이상)를 `extension/words/ko.json`, `en.json`으로 만든다. 이 두 파일도 CC-BY-SA 4.0.
- 친 글자로 시작하는 단어부터, 빈도순.
- `my_words.txt` 단어는 기본 목록 끝에 붙여 다른 단어와 똑같이 취급한다(우선하지 않음, 사용자 요청).
