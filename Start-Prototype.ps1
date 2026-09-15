[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8765,
    [ValidateNotNullOrEmpty()]
    [string]$Model = 'qwen3-vl:2b-instruct',
    [string]$ApiKey = '',
    [switch]$SkipOllama
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$runtimeDirectory = Join-Path $projectRoot '.runtime'
$serverDirectory = Join-Path $projectRoot 'server'
$serverExecutable = Join-Path $serverDirectory '.venv\Scripts\uvicorn.exe'
$keyFile = Join-Path $runtimeDirectory 'api-key.txt'
$pidFile = Join-Path $runtimeDirectory 'server-process.json'
$stdoutLog = Join-Path $runtimeDirectory 'server-out.log'
$stderrLog = Join-Path $runtimeDirectory 'server-error.log'

New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

if (-not (Test-Path -LiteralPath $serverExecutable -PathType Leaf)) {
    throw 'The server environment is missing. Run .\Setup-Prototype.ps1 first.'
}

if (-not $SkipOllama) {
    & (Join-Path $projectRoot 'Start-LocalOllama.ps1')
    $tags = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5
    $modelAvailable = @($tags.models | Where-Object {
        $_.name -eq $Model -or $_.model -eq $Model
    }).Count -gt 0
    if (-not $modelAvailable) {
        throw "Ollama model '$Model' is not installed locally. Pull it before starting the prototype."
    }

    # Loading a multimodal model can take tens of seconds on a laptop. Warm it
    # with a fixed, non-sensitive prompt so the first user task does not spend
    # the extension's entire request budget loading weights. Skip the request
    # when Ollama already reports the selected model as resident.
    $loaded = $false
    try {
        $processes = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/ps' -TimeoutSec 5
        $loaded = @($processes.models | Where-Object {
            $_.name -eq $Model -or $_.model -eq $Model
        }).Count -gt 0
    } catch {}
    if (-not $loaded) {
        Write-Host "Warming local Ollama model '$Model' (fixed local prompt; no page data)…"
        $warmup = @{
            model = $Model
            stream = $false
            think = $false
            keep_alive = '10m'
            options = @{ temperature = 0; num_predict = 1; num_ctx = 512 }
            messages = @(@{ role = 'user'; content = 'Reply with the single word READY.' })
        } | ConvertTo-Json -Depth 10 -Compress
        try {
            Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:11434/api/chat' `
                -ContentType 'application/json' -Body $warmup -TimeoutSec 180 | Out-Null
        } catch {
            throw "Ollama model '$Model' could not be warmed. Check the local Ollama logs."
        }
    }
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    if (Test-Path -LiteralPath $keyFile -PathType Leaf) {
        $ApiKey = (Get-Content -LiteralPath $keyFile -Raw).Trim()
    } else {
        $bytes = New-Object byte[] 32
        $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
        $ApiKey = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    }
}
if ($ApiKey.Length -lt 16) { throw 'ApiKey must contain at least 16 characters.' }
Set-Content -LiteralPath $keyFile -Value $ApiKey -NoNewline -Encoding ascii

if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
    try {
        $record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
        $existing = Get-Process -Id ([int]$record.pid) -ErrorAction Stop
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health/ready" -TimeoutSec 2
        if ($health.status -eq 'ready') {
            Write-Host "Privacy server is already ready on http://127.0.0.1:$Port (PID $($existing.Id))."
            Write-Host "Session key: $keyFile"
            return
        }
    } catch {
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    }
}

try {
    # Some managed Windows hosts deny the TCP-table query even for a local
    # process. Treat that query as advisory; uvicorn's bind/health check below
    # remains the authoritative port check.
    $listener = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($listener.Count -gt 0) { throw "Port $Port is already in use by another process." }
} catch {
    if ($_.Exception.Message -like "Port $Port is already in use*") { throw }
    # Access-denied/no-match errors are intentionally ignored here.
}

$env:PRIVACY_AGENT_API_KEY = $ApiKey
$env:PRIVACY_AGENT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'
$env:PRIVACY_AGENT_OLLAMA_MODEL = $Model
$env:PRIVACY_AGENT_ALLOW_REMOTE_OLLAMA = 'false'
$env:PRIVACY_AGENT_CORS_ORIGINS = 'http://localhost,http://127.0.0.1'

$arguments = @(
    'app.main:app',
    '--host', '127.0.0.1',
    '--port', [string]$Port,
    '--no-access-log',
    '--no-proxy-headers'
)
$process = Start-Process -FilePath $serverExecutable -ArgumentList $arguments -WorkingDirectory $serverDirectory `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
@{
    pid = $process.Id
    port = $Port
    executable = $serverExecutable
    startedAtUtc = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding utf8

for ($attempt = 0; $attempt -lt 45; $attempt++) {
    Start-Sleep -Seconds 1
    if ($process.HasExited) {
        throw "Privacy server exited during startup. See $stderrLog"
    }
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health/ready" -TimeoutSec 2
        if ($health.status -eq 'ready') {
            Write-Host "Prototype ready: http://127.0.0.1:$Port/demo"
            Write-Host "Reasoning endpoint: http://127.0.0.1:$Port/v1/reason"
            Write-Host "Session key: $keyFile"
            return
        }
    } catch {}
}

throw "The HTTP server started, but Ollama model '$Model' was not ready. See $stderrLog"
