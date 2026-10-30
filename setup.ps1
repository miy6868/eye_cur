$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
# ISE는 uv의 일반 안내 메시지(stderr)를 오류로 바꿔 설치를 멈춘다
if ($psISE) { throw '일반 PowerShell 창에서 실행하세요. (PowerShell ISE에서는 실행되지 않습니다)' }
# MediaPipe는 Windows에서 한글 등 영어가 아닌 경로에 있는 모델 파일을 열지 못한다
if ($PSScriptRoot -match '[^\x00-\x7F]') { throw "폴더 경로에 한글 등 영어가 아닌 글자가 있으면 MediaPipe가 실패합니다. C:\eye_cur 같은 영어 경로로 옮긴 뒤 다시 실행하세요. 현재 경로: $PSScriptRoot" }
$env:UV_CACHE_DIR = Join-Path $PSScriptRoot '.uv-cache'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $PSScriptRoot '.python'
# 학교망처럼 HTTPS를 검사하는 네트워크에서도 받도록 Windows 인증서 저장소를 쓴다
$env:UV_NATIVE_TLS = '1'
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'uv를 먼저 설치하세요: https://docs.astral.sh/uv/getting-started/installation/' }
# 폴더를 옮기면 .venv 안의 Python 경로가 깨진다: 파일이 있는지가 아니라 실제로 실행되는지 본다
$venvOk = (Test-Path '.venv/Scripts/python.exe') -and ((& .venv/Scripts/python.exe -c 'import sys; print(sys.version_info[:2] == (3, 11))') -eq 'True')
if (-not $venvOk) {
    uv python install 3.11
    if ($LASTEXITCODE -ne 0) { throw 'Python 설치 실패' }
    uv venv --clear --python 3.11 .venv
    if ($LASTEXITCODE -ne 0) { throw '가상환경 생성 실패' }
}
# torch는 설치 때 UniGaze를 ONNX로 바꾸는 데만 쓴다 (CPU 전용 휠)
uv pip install --python .venv/Scripts/python.exe torch==2.7.1 --index-url https://download.pytorch.org/whl/cpu
if ($LASTEXITCODE -ne 0) { throw 'CPU PyTorch 설치 실패' }
uv pip install --python .venv/Scripts/python.exe -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw '라이브러리 설치 실패' }
& .venv/Scripts/python.exe scripts/download_models.py
if ($LASTEXITCODE -ne 0) { throw '가중치 다운로드 실패' }
if (-not (Test-Path '.env')) { Copy-Item .env.example .env }
# DLL이 없으면 설치는 성공해도 시연 때 처음 실패하므로, 여기서 모델을 미리 불러 본다 (카메라는 열지 않음)
& .venv/Scripts/python.exe scripts/check_cpu.py
if ($LASTEXITCODE -ne 0) { throw '모델 로딩 점검 실패. "DLL load failed"가 보이면 https://aka.ms/vs/17/release/vc_redist.x64.exe 를 설치하고, Windows N/KN 에디션이면 미디어 기능 팩을 설치한 뒤 다시 실행하세요.' }
Write-Host '설치 완료. ./start.ps1을 실행하세요. (API 키는 선택(USE_JEV): Jev를 켤 때만 .env에 TYPESAFE_API_KEY 입력)'
