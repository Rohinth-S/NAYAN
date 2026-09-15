[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$pidFile = Join-Path $projectRoot '.runtime\server-process.json'
if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
    Write-Host 'No recorded privacy-server process is running.'
    return
}

$record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$expectedExecutable = [IO.Path]::GetFullPath([string]$record.executable)
try {
    $process = Get-Process -Id ([int]$record.pid) -ErrorAction Stop
} catch {
    Remove-Item -LiteralPath $pidFile -Force
    Write-Host 'The recorded privacy-server process had already stopped.'
    return
}

$actualExecutable = $process.Path
if ($actualExecutable -and [IO.Path]::GetFullPath($actualExecutable) -ne $expectedExecutable) {
    throw 'The recorded PID now belongs to a different executable; refusing to stop it.'
}
Stop-Process -Id $process.Id
Wait-Process -Id $process.Id -Timeout 10 -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $pidFile -Force
Write-Host 'Privacy server stopped. Ollama was left running for reuse.'

