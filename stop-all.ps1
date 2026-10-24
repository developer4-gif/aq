<#
  Stops the processes started by start-all.ps1 (only those recorded in .run\pids.json).
    powershell -ExecutionPolicy Bypass -File .\stop-all.ps1
#>
$pidFile = Join-Path $PSScriptRoot ".run\pids.json"
if (-not (Test-Path $pidFile)) { Write-Host "Nothing to stop (no .run\pids.json - start-all.ps1 is not running, or it did not start these services)."; exit 0 }
$pids = Get-Content $pidFile -Raw | ConvertFrom-Json
foreach ($prop in $pids.PSObject.Properties) {
    if (Get-Process -Id $prop.Value -ErrorAction SilentlyContinue) {
        & taskkill.exe /PID $prop.Value /T /F 2>&1 | Out-Null
        Write-Host "Stopped $($prop.Name) (pid $($prop.Value))"
    } else { Write-Host "$($prop.Name) (pid $($prop.Value)) was not running" }
}
Remove-Item $pidFile -ErrorAction SilentlyContinue
