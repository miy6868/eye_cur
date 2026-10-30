"""UniGaze-B 가중치를 받아 ONNX 모델 두 개(fp32, int8)로 바꾼다. 설치할 때 한 번 실행한다.

torch는 여기서 ONNX로 바꿀 때만 쓴다. 서버는 ONNX Runtime으로 돌리므로 torch를 불러오지 않는다.
"""
import sys
from pathlib import Path

import httpx
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor"))
import unigaze  # noqa: E402

URL = "https://huggingface.co/UniGaze/UniGaze-models/resolve/main/unigaze_b16_joint.safetensors"
weights = ROOT / "models/unigaze_b16_joint.safetensors"
fp32 = ROOT / "models/unigaze_b16.onnx"
int8 = ROOT / "models/unigaze_b16_int8.onnx"
weights.parent.mkdir(exist_ok=True)

if not weights.exists():
    print("UniGaze-B 가중치 받는 중 (약 346MB)…", flush=True)
    partial = weights.with_suffix(".part")
    with httpx.stream("GET", URL, follow_redirects=True, timeout=60) as response:
        response.raise_for_status()
        with open(partial, "wb") as file:
            for chunk in response.iter_bytes(1 << 20):
                file.write(chunk)
    # 중간에 끊긴 파일을 완성본으로 착각하지 않도록 크기를 확인한 뒤에 이름을 바꾼다
    if partial.stat().st_size < 300_000_000:
        raise SystemExit(f"가중치 다운로드 실패. {URL} 에서 받아 {weights}에 넣으세요.")
    partial.replace(weights)

if not fp32.exists():
    model = unigaze.load(weights)
    # 224×224 얼굴 한 장을 넣는 계산 과정을 그대로 기록해 ONNX 파일로 저장한다
    torch.onnx.export(model, torch.zeros(1, 3, 224, 224), str(fp32), input_names=["face"],
                      output_names=["gaze"], opset_version=17, dynamo=False)

if not int8.exists():
    # 가중치를 8비트 정수로 줄인 모델: 파일 343→87MB, 계산 약 2배 빠름. .env의 GAZE_INT8=1일 때만 쓴다
    quantize_dynamic(str(fp32), str(int8), weight_type=QuantType.QInt8)

print(f"Model ready: {fp32.name}, {int8.name}")
