$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:MPLCONFIGDIR = Join-Path $PSScriptRoot '.cache/matplotlib'
if (-not (Test-Path '.venv/Scripts/python.exe')) { throw './setup.ps1을 먼저 실행하세요.' }
& .venv/Scripts/python.exe -m backend.server
