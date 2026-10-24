<#
  Scans the repo (excluding .git) for real-looking API keys and for any file named .env.
  Exit code 1 on hits. Matches under tests/ are reported as allowlisted dummy fixtures (exit stays 0).
  Matched values are never printed in full.
  Usage: powershell -ExecutionPolicy Bypass -File scripts\secret-scan.ps1
#>
param([string]$Repo = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = "Stop"

$patterns = [ordered]@{
    "Groq key"       = 'gsk_[A-Za-z0-9]{40,}'
    "Google API key" = 'AIza[0-9A-Za-z_\-]{35}'
    "HuggingFace"    = 'hf_[A-Za-z]{30,}'
    "xAI key"        = 'xai-[A-Za-z0-9]{40,}'
    "OpenAI-style"   = 'sk-[A-Za-z0-9]{40,}'
}
$skipDirs = '[\\/](\.git|node_modules|\.venv|__pycache__)[\\/]'
$binExt   = '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.pdf', '.zip', '.pyc', '.gz'

$hits = @(); $allowed = @()
$files = Get-ChildItem -LiteralPath $Repo -Recurse -File -Force |
    Where-Object { $_.FullName -notmatch $skipDirs }

foreach ($f in $files) {
    $rel = $f.FullName.Substring($Repo.TrimEnd('\').Length + 1)
    $isTest = $rel -match '(^|[\\/])tests?[\\/]'
    if ($f.Name -eq ".env") { $hits += "[.env file] $rel"; continue }
    if ($binExt -contains $f.Extension.ToLower()) { continue }
    if ($f.Length -gt 5MB) { continue }
    $text = [System.IO.File]::ReadAllText($f.FullName)
    foreach ($label in $patterns.Keys) {
        foreach ($m in [regex]::Matches($text, $patterns[$label])) {
            $v = $m.Value
            $masked = $v.Substring(0, [Math]::Min(6, $v.Length)) + "..." + "(len $($v.Length))"
            $line = "[$label] ${rel}: $masked"
            if ($isTest) { $allowed += $line } else { $hits += $line }
        }
    }
}

if ($allowed.Count) {
    Write-Host "Allowlisted (tests/ fixtures - confirm they are dummies):" -ForegroundColor Yellow
    $allowed | Sort-Object -Unique | ForEach-Object { Write-Host "  $_" }
}
if ($hits.Count) {
    Write-Host "SECRET SCAN FAILED:" -ForegroundColor Red
    $hits | Sort-Object -Unique | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    exit 1
}
Write-Host "Secret scan passed ($($files.Count) files checked)." -ForegroundColor Green
exit 0
