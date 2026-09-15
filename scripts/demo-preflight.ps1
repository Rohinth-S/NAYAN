[CmdletBinding()]
param(
    [int]$Port = 8765,
    [string]$Model = 'qwen3-vl:2b-instruct'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$checks = [ordered]@{}

try {
    $live = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health/live" -TimeoutSec 3
    $checks.live = $live.status -eq 'live'
} catch { $checks.live = $false }
try {
    $ready = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health/ready" -TimeoutSec 5
    $checks.ready = $ready.status -eq 'ready' -and $ready.model -eq $Model
} catch { $checks.ready = $false }
try {
    $tags = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5
    $checks.ollama = @($tags.models | Where-Object { $_.name -eq $Model -or $_.model -eq $Model }).Count -gt 0
} catch { $checks.ollama = $false }
$checks.chromePackage = Test-Path (Join-Path $root 'extension\dist\chrome\manifest.json')
$checks.firefoxPackage = Test-Path (Join-Path $root 'extension\dist\firefox\manifest.json')
$checks.syntheticPortal = $false
try {
    $reset = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/demo/api/reset" -TimeoutSec 3
    $checks.syntheticPortal = $reset.submitted -eq $false
} catch { $checks.syntheticPortal = $false }

$failed = @($checks.GetEnumerator() | Where-Object { -not $_.Value })
$checks.GetEnumerator() | ForEach-Object { Write-Host ("{0}={1}" -f $_.Key, $_.Value) }
if ($failed.Count -gt 0) {
    throw ("demo_preflight=failed checks={0}" -f (($failed | ForEach-Object Key) -join ','))
}
Write-Host 'demo_preflight=passed synthetic_only=true'
