$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:UV_CACHE_DIR = Join-Path $PSScriptRoot '.uv-cache'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $PSScriptRoot '.python'
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'uv를 먼저 설치하세요: https://docs.astral.sh/uv/getting-started/installation/' }
if (-not (Test-Path '.venv/Scripts/python.exe')) {
    uv python install 3.11
    if ($LASTEXITCODE -ne 0) { throw 'Python 설치 실패' }
    uv venv --python 3.11 .venv
    if ($LASTEXITCODE -ne 0) { throw '가상환경 생성 실패' }
}
uv pip install --python .venv/Scripts/python.exe torch==2.7.1 --index-url https://download.pytorch.org/whl/cpu
if ($LASTEXITCODE -ne 0) { throw 'CPU PyTorch 설치 실패' }
uv pip install --python .venv/Scripts/python.exe -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw '라이브러리 설치 실패' }
& .venv/Scripts/python.exe scripts/download_models.py
if ($LASTEXITCODE -ne 0) { throw '가중치 다운로드 실패' }
if (-not (Test-Path '.env')) { Copy-Item .env.example .env }
Write-Host '설치 완료. ./start.ps1을 실행하세요. (API 키는 선택(USE_JEV): Jev를 켤 때만 .env에 TYPESAFE_API_KEY 입력)'
