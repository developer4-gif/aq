# Lecture Notes AI - one-click start (Windows PowerShell)
#   Right-click > Run with PowerShell, or:  powershell -ExecutionPolicy Bypass -File .\start.ps1
$ErrorActionPreference = "Stop"
$root    = $PSScriptRoot
$venv    = Join-Path $root ".venv"
$py      = Join-Path $venv "Scripts\python.exe"
$req     = Join-Path $root "pyproject.toml"
$stamp   = Join-Path $venv ".requirements.sha256"
$url     = "http://127.0.0.1:5055"

# 1. virtual environment
if (-not (Test-Path $py)) {
    Write-Host "Creating virtual environment..." -ForegroundColor Cyan
    $sys = Get-Command python -ErrorAction SilentlyContinue
    if ($sys) { & $sys.Source -m venv $venv }
    elseif (Get-Command py -ErrorAction SilentlyContinue) { & py -3 -m venv $venv }
    else { throw "Python 3.10+ was not found. Install it from https://www.python.org/downloads/ and run this script again." }
}

# 2. dependencies (only when pyproject.toml changed): installs notes_engine + the web extras
$hash = (Get-FileHash $req -Algorithm SHA256).Hash
$old  = if (Test-Path $stamp) { (Get-Content $stamp -Raw).Trim() } else { "" }
if ($hash -ne $old) {
    Write-Host "Installing the project and its requirements (first run takes a minute)..." -ForegroundColor Cyan
    Push-Location $root
    try { & $py -m pip install --disable-pip-version-check -e ".[web]" } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "pip install failed." }
    Set-Content -Path $stamp -Value $hash
}

# 3. .env reminder
$envFile = Join-Path $root "backend\.env"
if (-not (Test-Path $envFile)) {
    Write-Host "Tip: copy backend\.env.example to backend\.env to save an API key on this machine (or just paste a key in the web page)." -ForegroundColor Yellow
}

# 4. open the browser once the server answers
$null = Start-Job -ScriptBlock {
    param($u)
    for ($i = 0; $i -lt 60; $i++) {
        try { Invoke-WebRequest -Uri "$u/api/providers" -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process $u; return }
        catch { Start-Sleep -Milliseconds 500 }
    }
} -ArgumentList $url

# 5. run the server in the foreground (Ctrl+C to stop)
$env:PYTHONUTF8 = "1"
Set-Location (Join-Path $root "backend")
& $py run.py
