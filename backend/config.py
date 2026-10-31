"""config.toml 읽기. 서버와 점검 스크립트가 같은 값을 쓴다."""
import tomllib
from pathlib import Path

# utf-8-sig: Windows 메모장이 저장할 때 붙이는 BOM도 읽는다
CONFIG = tomllib.loads((Path(__file__).resolve().parents[1] / "config.toml").read_text(encoding="utf-8-sig"))
