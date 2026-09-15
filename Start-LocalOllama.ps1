param(
    [string]$RuntimePath = '',
    [string]$ModelsPath = ''
)
$ErrorActionPreference = 'Stop'

try {
    Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 | Out-Null
    Write-Host 'An Ollama server is already listening locally. Its startup settings were not changed.'
    return
} catch {}

if ([string]::IsNullOrWhiteSpace($RuntimePath)) {
    $installed = Get-Command ollama -ErrorAction SilentlyContinue
    if ($installed) {
        $RuntimePath = $installed.Source
    } else {
        $candidates = @(
            (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'),
            (Join-Path $env:ProgramFiles 'Ollama\ollama.exe'),
            (Join-Path $PSScriptRoot '.runtime\ollama\ollama.exe')
        )
        $RuntimePath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    }
}
if (-not (Test-Path -LiteralPath $RuntimePath -PathType Leaf)) {
    throw 'Ollama executable was not found. Install Ollama, add it to PATH, or supply -RuntimePath.'
}
if ([string]::IsNullOrWhiteSpace($ModelsPath)) {
    if (-not [string]::IsNullOrWhiteSpace($env:OLLAMA_MODELS)) {
        $ModelsPath = $env:OLLAMA_MODELS
    } else {
        $ModelsPath = Join-Path $PSScriptRoot '.runtime\ollama-models'
    }
}

# Resolve the project-local model directory before exporting OLLAMA_MODELS.
# If this assignment happens earlier, Ollama silently falls back to the user's
# protected default directory on managed Windows hosts.
$env:OLLAMA_HOST = '127.0.0.1:11434'
$env:OLLAMA_MODELS = $ModelsPath
$env:OLLAMA_NO_CLOUD = '1'
$env:ANONYMIZED_TELEMETRY = 'false'
$env:BROWSER_USE_VERSION_CHECK = 'false'
$env:BROWSER_USE_CALCULATE_COST = 'false'
$env:BROWSER_USE_SETUP_LOGGING = 'false'
$env:BROWSER_USE_CONFIG_DIR = Join-Path $PSScriptRoot '.runtime\browseruse'

$logPath = Join-Path $PSScriptRoot '.runtime\logs'
New-Item -ItemType Directory -Force -Path $ModelsPath, $logPath | Out-Null
$server = Start-Process -FilePath $RuntimePath -ArgumentList 'serve' -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logPath 'ollama-out.log') `
    -RedirectStandardError (Join-Path $logPath 'ollama-error.log')
Set-Content -LiteralPath (Join-Path $logPath 'ollama.pid') -Value $server.Id
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    try {
        Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 1 | Out-Null
        Write-Host "Local Ollama ready on 127.0.0.1:11434 (PID $($server.Id)); model files: $ModelsPath"
        return
    } catch {}
    if ($server.HasExited) { throw 'Ollama exited during startup. Check the local runtime logs.' }
}
throw 'Ollama did not become ready. Check the local runtime logs.'
