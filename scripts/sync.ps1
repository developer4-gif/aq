<#
  Mirrors the four working folders under D:\AQspace into this repo (robocopy /MIR per folder),
  leaving out virtualenvs, dependencies, generated output, databases, secrets and probe files.
  The user's OAuth app (backend/, frontend/, docker-compose.yml) is never touched.
  Usage: powershell -ExecutionPolicy Bypass -File scripts\sync.ps1 [-Source D:\AQspace]
#>
param(
    [string]$Source = "D:\AQspace",
    [string]$Repo   = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = "Stop"

# repo folder  <-  working folder
$map = [ordered]@{
    "lecture-notes-ai" = "lecture-notes-ai"
    "lecture-notes-ui" = "lecture-notes-ui"
    "aq-api"           = "aq-api"
    "docs"             = "docs"
}

$xd = @(".venv", "venv", "node_modules", "output", "data", "__pycache__", ".pytest_cache",
        "screenshots-tmp", "_landing-backup", "build", "dist", "*.egg-info", ".git")
$xf = @("*.db", "*.db-journal", "*.sqlite", "*.sqlite3", ".env", "*.pyc", "*.log", "_*.html", "undefined", "Thumbs.db")

# lecture-notes-ui/screenshots (small PNG docs): keep only while the folder is under 5 MB
$shots = Join-Path $Source "lecture-notes-ui\screenshots"
if (Test-Path $shots) {
    $bytes = (Get-ChildItem $shots -Recurse -File | Measure-Object Length -Sum).Sum
    if ($bytes -ge 5MB) {
        Write-Host ("screenshots/ is {0:N1} MB (>= 5 MB): excluded." -f ($bytes / 1MB)) -ForegroundColor Yellow
        $xd += "screenshots"
    } else {
        Write-Host ("screenshots/ is {0:N1} MB (< 5 MB): kept." -f ($bytes / 1MB))
    }
}

foreach ($name in $map.Keys) {
    $src = Join-Path $Source $map[$name]
    $dst = Join-Path $Repo $name
    if (-not (Test-Path $src)) { Write-Host "SKIP $name (missing $src)" -ForegroundColor Yellow; continue }
    Write-Host "==> $name" -ForegroundColor Cyan
    # /MIR deletes destination files absent from the source; excluded names are left alone (and ignored by .gitignore).
    $args = @($src, $dst, "/MIR", "/NJH", "/NJS", "/NP", "/NDL", "/NFL", "/R:2", "/W:1", "/XD") + $xd + @("/XF") + $xf
    & robocopy @args | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $name (exit $LASTEXITCODE)" }
}
$global:LASTEXITCODE = 0
Write-Host "Sync complete." -ForegroundColor Green
