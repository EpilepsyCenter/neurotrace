# Freeze the Python backend with PyInstaller for distribution (Windows).
# Output lands in backend-dist/ (consumed by electron-builder's extraResources).

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir

Set-Location $ProjectDir

Write-Host "==> Cleaning previous build artifacts"
Remove-Item -Recurse -Force backend-dist, build\pyi-dist, build\pyi-work -ErrorAction SilentlyContinue

Write-Host "==> Running PyInstaller"
python -m PyInstaller `
  --noconfirm `
  --distpath=build/pyi-dist `
  --workpath=build/pyi-work `
  scripts/backend.spec

# PyInstaller emits build\pyi-dist\backend-dist\ — move it to the root
# so electron-builder's extraResources picks it up as .\backend-dist.
Move-Item build\pyi-dist\backend-dist backend-dist

$Size = "{0:N0} MB" -f ((Get-ChildItem -Recurse backend-dist | Measure-Object -Property Length -Sum).Sum / 1MB)
Write-Host "==> Backend frozen to $ProjectDir\backend-dist\ ($Size)"

Write-Host "==> Smoke test: starting bundled backend on port 18765"
$proc = Start-Process -FilePath "backend-dist\main.exe" -ArgumentList "--port","18765" `
  -RedirectStandardOutput "$env:TEMP\nt-backend-smoke.log" -RedirectStandardError "$env:TEMP\nt-backend-smoke.err" `
  -PassThru -WindowStyle Hidden

$ok = $false
for ($i = 1; $i -le 12; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:18765/health" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) {
      Write-Host "==> Health check OK after $($i * 2)s"
      $ok = $true
      break
    }
  } catch { }
}

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
if (-not $ok) {
  Write-Host "==> Health check FAILED — log:" -ForegroundColor Red
  Get-Content "$env:TEMP\nt-backend-smoke.log","$env:TEMP\nt-backend-smoke.err" -ErrorAction SilentlyContinue
  exit 1
}
