#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export MPLCONFIGDIR="$PWD/.cache/matplotlib"
# Hyprland 같은 타일링 창 관리자는 창 크기를 직접 정한다. 확장이 창을 줄이면 타일 크기와 어긋나 화면이 깨지므로 끈다
export SHRINK_WINDOW=0
[ -x .venv/bin/python ] || { echo './setup.sh를 먼저 실행하세요.'; exit 1; }
exec .venv/bin/python -m backend.server
