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
if ([string]::IsNullOrEmpty($projectRoot)) { $projectRoot = $PWD.Path }
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
Write-Host "Starting server..."
Set-Location $serverDirectory
try {
    & $serverExecutable $arguments
} finally {
    Set-Location $projectRoot
}

