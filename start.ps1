$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if ($psISE) { throw '일반 PowerShell 창에서 실행하세요. (PowerShell ISE에서는 실행되지 않습니다)' }
if ($PSScriptRoot -match '[^\x00-\x7F]') { throw "폴더 경로에 한글 등 영어가 아닌 글자가 있으면 MediaPipe가 실패합니다. C:\eye_cur 같은 영어 경로로 옮기고 setup.ps1부터 다시 실행하세요. 현재 경로: $PSScriptRoot" }
$env:MPLCONFIGDIR = Join-Path $PSScriptRoot '.cache/matplotlib'
if (-not (Test-Path '.venv/Scripts/python.exe')) { throw './setup.ps1을 먼저 실행하세요.' }
& .venv/Scripts/python.exe -m backend.server
