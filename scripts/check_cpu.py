"""Load the real checkpoint and benchmark CPU inference without opening the webcam."""
import os
import sys
import time
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
os.environ.setdefault("MPLCONFIGDIR", str(root / ".cache/matplotlib"))
import torch
from backend.tracker import load_model

model = load_model()
sample = {"face": torch.zeros(1, 3, 224, 224)}
print("Torch:", torch.__version__, "Device:", next(model.parameters()).device)
with torch.inference_mode():
    for threads in [1, 2, 4]:
        torch.set_num_threads(threads)
        model(sample)
        started = time.perf_counter()
        for _ in range(10):
            output = model(sample)
        print(f"threads={threads}, mean_ms={(time.perf_counter() - started) * 100:.1f}")
    assert output.shape == (1, 2) and torch.isfinite(output).all()
print("PASS: real checkpoint loaded, finite CPU output; not an accuracy test.")
