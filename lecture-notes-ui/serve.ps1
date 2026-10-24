# Serves this folder at http://127.0.0.1:5173/  (the notes API only accepts localhost / 127.0.0.1 origins)
# Run:  powershell -ExecutionPolicy Bypass -File .\serve.ps1     Stop: Ctrl+C
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$venvPy = "D:\AQspace\lecture-notes-ai\.venv\Scripts\python.exe"
if (Test-Path $venvPy) { $py = $venvPy }
else {
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "Python was not found. Install Python 3 or fix the venv path in serve.ps1." }
  $py = $cmd.Source
}
Write-Host "Serving $here at http://127.0.0.1:5173/  (Ctrl+C to stop)" -ForegroundColor Cyan
Write-Host "For 'Get notes' also start the notes server: D:\AQspace\lecture-notes-ai\start.ps1" -ForegroundColor DarkGray
Set-Location $here
& $py -m http.server 5173 --bind 127.0.0.1
