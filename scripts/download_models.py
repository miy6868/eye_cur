from pathlib import Path
import gdown

ROOT = Path(__file__).resolve().parents[1]
target = ROOT / "models/GazeTR-H-ETH.pt"
target.parent.mkdir(exist_ok=True)
if not target.exists():
    partial = target.with_suffix(".part")
    result = gdown.download(id="1WEiKZ8Ga0foNmxM7xFabI4D5ajThWAWj", output=str(partial), quiet=False)
    if not result or partial.stat().st_size < 1_000_000:
        raise SystemExit("가중치 다운로드 실패. README의 공식 링크에서 받아 models/GazeTR-H-ETH.pt에 넣으세요.")
    partial.replace(target)
print(f"Model ready: {target}")
