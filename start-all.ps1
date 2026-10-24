<#
  AQ Learning - start everything with one command (Windows PowerShell).
    powershell -ExecutionPolicy Bypass -File .\start-all.ps1
  Starts the Python notes/AI worker (:5055) and the Node app API (:5180), then opens
  http://127.0.0.1:5180/ . Press Ctrl+C to stop both (or run stop-all.ps1 from another window).
  API keys are read from lecture-notes-ai\backend\.env and are never printed.
#>
$ErrorActionPreference = "Stop"
$root   = $PSScriptRoot
$aiDir  = Join-Path $root "lecture-notes-ai"
$apiDir = Join-Path $root "aq-api"
$runDir = Join-Path $root ".run"
$aiPort = 5055
$apiPort = 5180
$url    = "http://127.0.0.1:$apiPort/"
New-Item -ItemType Directory -Force $runDir | Out-Null

function Test-PortBusy([int]$port) {
    $c = New-Object System.Net.Sockets.TcpClient
    try { $c.Connect("127.0.0.1", $port); return $true } catch { return $false } finally { $c.Close() }
}
function Wait-Http([string]$u, [int]$seconds) {
    for ($i = 0; $i -lt ($seconds * 2); $i++) {
        try { Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true } catch { Start-Sleep -Milliseconds 500 }
    }
    return $false
}

# --- keys from lecture-notes-ai\backend\.env (values are loaded into this process only, never echoed) ---
$envFile = Join-Path $aiDir "backend\.env"
if (Test-Path $envFile) {
    $names = @()
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$' -and -not $line.TrimStart().StartsWith("#")) {
            $v = $Matches[2].Trim('"').Trim("'")
            if ($v) { [Environment]::SetEnvironmentVariable($Matches[1], $v, "Process"); $names += $Matches[1] }
        }
    }
    Write-Host ("Loaded {0} setting(s) from backend\.env: {1}" -f $names.Count, ($names -join ", ")) -ForegroundColor DarkGray
} else {
    Write-Host "No lecture-notes-ai\backend\.env found. Copy backend\.env.example to backend\.env and add a free Groq or Gemini key (or paste a key in the web page)." -ForegroundColor Yellow
}

# --- 1. Python notes service ---
$venv = Join-Path $aiDir ".venv"
$py   = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "Creating Python virtual environment..." -ForegroundColor Cyan
    $sys = Get-Command python -ErrorAction SilentlyContinue
    if ($sys) { & $sys.Source -m venv $venv }
    elseif (Get-Command py -ErrorAction SilentlyContinue) { & py -3 -m venv $venv }
    else { throw "Python 3.10+ not found. Install it from https://www.python.org/downloads/ and re-run." }
}
$req   = Join-Path $aiDir "pyproject.toml"
$stamp = Join-Path $venv ".requirements.sha256"
$hash  = (Get-FileHash $req -Algorithm SHA256).Hash
$old   = if (Test-Path $stamp) { (Get-Content $stamp -Raw).Trim() } else { "" }
if ($hash -ne $old) {
    Write-Host "Installing Python dependencies (first run takes a minute)..." -ForegroundColor Cyan
    Push-Location $aiDir
    try { & $py -m pip install --disable-pip-version-check -e ".[web]" } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "pip install failed." }
    Set-Content -Path $stamp -Value $hash
}

# --- 2. Node API ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 18+ not found. Install it from https://nodejs.org/ and re-run." }
if (-not (Test-Path (Join-Path $apiDir "node_modules"))) {
    Write-Host "Installing Node dependencies (npm install)..." -ForegroundColor Cyan
    Push-Location $apiDir
    try { & npm.cmd install --no-audit --no-fund } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
}

$pids = @{}
$env:PYTHONUTF8 = "1"
$env:LNA_PORT   = "$aiPort"
$env:PORT       = "$apiPort"
$env:PY_NOTES_URL = "http://127.0.0.1:$aiPort"
try {
    if (Test-PortBusy $aiPort) {
        Write-Host "Port $aiPort is already in use - assuming the notes service is already running (not managing it)." -ForegroundColor Yellow
    } else {
        $p = Start-Process -FilePath $py -ArgumentList "run.py" -WorkingDirectory (Join-Path $aiDir "backend") `
             -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $runDir "ai.out.log") -RedirectStandardError (Join-Path $runDir "ai.err.log")
        $pids.ai = $p.Id
        if (-not (Wait-Http "http://127.0.0.1:$aiPort/api/providers" 60)) { throw "Notes service did not come up on :$aiPort (see .run\ai.err.log)." }
        Write-Host "Notes service (Python)  ready on http://127.0.0.1:$aiPort" -ForegroundColor Green
    }
    if (Test-PortBusy $apiPort) {
        Write-Host "Port $apiPort is already in use - assuming the app API is already running (not managing it)." -ForegroundColor Yellow
    } else {
        $p = Start-Process -FilePath "npm.cmd" -ArgumentList "start" -WorkingDirectory $apiDir `
             -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $runDir "api.out.log") -RedirectStandardError (Join-Path $runDir "api.err.log")
        $pids.api = $p.Id
        if (-not (Wait-Http "http://127.0.0.1:$apiPort/" 60)) { throw "App API did not come up on :$apiPort (see .run\api.err.log)." }
        Write-Host "App API (Node)          ready on $url" -ForegroundColor Green
    }
    $pids | ConvertTo-Json | Set-Content (Join-Path $runDir "pids.json")
    Start-Process $url
    Write-Host "`nAQ Learning is running at $url  -  press Ctrl+C to stop." -ForegroundColor Cyan
    while ($true) {
        Start-Sleep -Seconds 2
        foreach ($k in @($pids.Keys)) {
            if (-not (Get-Process -Id $pids[$k] -ErrorAction SilentlyContinue)) { throw "The $k process exited unexpectedly (see .run\$k.err.log)." }
        }
    }
} finally {
    foreach ($k in @($pids.Keys)) { & taskkill.exe /PID $pids[$k] /T /F 2>&1 | Out-Null }
    Remove-Item (Join-Path $runDir "pids.json") -ErrorAction SilentlyContinue
    Write-Host "Stopped." -ForegroundColor Yellow
}
