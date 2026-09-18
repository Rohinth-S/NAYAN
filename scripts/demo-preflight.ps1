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
# Readiness alone proves model availability, not extension authorization.
# An empty synthetic body must be rejected by validation only after a valid key;
# no screenshot, task or model invocation is involved in these probes.
$checks.extensionAuthentication = $false
try {
    $sessionKey = (Get-Content -LiteralPath (Join-Path $root '.runtime\api-key.txt') -Raw).Trim()
    $probeStatus = @()
    foreach ($includeKey in @($false, $true)) {
        $probeHeaders = @{ Origin = ('chrome-extension://' + ('a' * 32)) }
        if ($includeKey) { $probeHeaders['X-Privacy-Agent-Key'] = $sessionKey }
        try {
            $reply = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$Port/v1/reason" -Headers $probeHeaders -ContentType 'application/json' -Body '{}' -TimeoutSec 3
            $probeStatus += [int]$reply.StatusCode
        } catch {
            if ($null -eq $_.Exception.Response) { throw }
            $probeStatus += [int]$_.Exception.Response.StatusCode
        }
    }
    $checks.extensionAuthentication = $probeStatus[0] -eq 401 -and $probeStatus[1] -eq 422
} catch { $checks.extensionAuthentication = $false }
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
