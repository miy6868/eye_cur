"""가상 키보드 추천 단어 목록 만들기 → extension/words/ko.json, en.json

출처: hermitdave/FrequencyWords (OpenSubtitles 2018 자막 단어 빈도, CC-BY-SA 4.0)
자주 나온 순서대로 단어만 담는다. 한 번 만들어 git에 넣어 두므로 설치 때 다시 돌릴 필요는 없다.
"""
import json
import re
import urllib.request
from pathlib import Path

URL = 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/{0}/{0}_50k.txt'
KEEP = 20000
RULES = {'ko': re.compile(r'[가-힣]{2,}'), 'en': re.compile(r'[a-z]{2,}')}  # 한 글자 단어는 추천해도 빨라지지 않는다
OUT = Path(__file__).resolve().parent.parent / 'extension' / 'words'

OUT.mkdir(exist_ok=True)
for lang, rule in RULES.items():
    text = urllib.request.urlopen(URL.format(lang), timeout=30).read().decode('utf-8')
    words = []
    for line in text.splitlines():
        word = line.split(' ')[0]
        if rule.fullmatch(word):
            words.append(word)
        if len(words) == KEEP:
            break
    (OUT / f'{lang}.json').write_text(json.dumps(words, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(lang, len(words), words[:10])
