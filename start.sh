#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export MPLCONFIGDIR="$PWD/.cache/matplotlib"
[ -x .venv/bin/python ] || { echo './setup.sh를 먼저 실행하세요.'; exit 1; }
exec .venv/bin/python -m backend.server
