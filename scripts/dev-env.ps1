<#
  Keep everything that takes disk space inside this project folder, so it stays on the project's drive
  (e.g. D:) and never fills the system drive (C:).
  Dot-source it in any terminal before installing or testing:   . .\scripts\dev-env.ps1
  start-all.ps1 does this for you.  Everything below is git-ignored (.cache/, .tmp/).
#>
$base = Split-Path $PSScriptRoot -Parent
$cache = Join-Path $base ".cache"
$tmp   = Join-Path $base ".tmp"
foreach ($d in @($cache, $tmp)) { New-Item -ItemType Directory -Force $d | Out-Null }

$env:TEMP = $tmp                                      # scratch files (also pytest's tmp_path, Edge/ffmpeg/yt-dlp)
$env:TMP  = $tmp
$env:PIP_CACHE_DIR       = Join-Path $cache "pip"             # pip downloads
$env:npm_config_cache    = Join-Path $cache "npm"             # npm downloads (was in AppData\Local\npm-cache)
$env:HF_HOME             = Join-Path $cache "huggingface"     # embedding / speech models, if ever downloaded
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $cache "playwright" # browsers for end-to-end tests
$env:RUFF_CACHE_DIR      = Join-Path $cache "ruff"
$env:LNA_CACHE_DIR       = Join-Path $base "lecture-notes-ai\backend\.cache"   # transcripts + LLM answers
Write-Host "Caches and temp files -> $base (.cache, .tmp)" -ForegroundColor DarkGray
