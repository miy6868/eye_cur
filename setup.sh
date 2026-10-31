#!/usr/bin/env bash
# setup.ps1의 Linux판: uv로 Python 3.11 가상환경을 만들고 라이브러리를 설치한다.
set -euo pipefail
cd "$(dirname "$0")"
export UV_CACHE_DIR="$PWD/.uv-cache"
export UV_PYTHON_INSTALL_DIR="$PWD/.python"
command -v uv >/dev/null || { echo 'uv를 먼저 설치하세요: sudo pacman -S uv'; exit 1; }
if [ ! -x .venv/bin/python ]; then
    # Arch 기본 Python 3.13에는 mediapipe 0.10.21 휠이 없어서 3.11을 따로 받는다
    uv python install 3.11
    uv venv --clear --python 3.11 .venv
fi
# GPU 없이 돌리므로 CPU 전용 torch만 받는다 (CUDA 용량 절약). torch는 설치 때 UniGaze를 ONNX로 바꾸는 데만 쓴다
uv pip install --python .venv/bin/python torch==2.7.1 --index-url https://download.pytorch.org/whl/cpu
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python scripts/download_models.py
echo '설치 완료. ./start.sh를 실행하세요. (설정은 config.toml)'
