[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$uv = Join-Path $projectRoot '.tools\uv\uv.exe'
$model = Join-Path $projectRoot 'extension\models\version-RFB-320.onnx'
$expectedModelHash = 'B63E0028667FD9E7E5DCC56EBD91E85281B8DF1498B4C3C5799DE9229305C0B1'

if (-not (Test-Path -LiteralPath $uv -PathType Leaf)) { throw "Bundled uv is missing: $uv" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20 or newer is required.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required.' }
if (-not (Test-Path -LiteralPath $model -PathType Leaf)) { throw 'The bundled UltraFace model is missing.' }
if ((Get-FileHash -LiteralPath $model -Algorithm SHA256).Hash -ne $expectedModelHash) {
    throw 'The bundled UltraFace model checksum does not match the reviewed asset.'
}

Push-Location (Join-Path $projectRoot 'extension')
try { npm ci } finally { Pop-Location }

$serverDirectory = Join-Path $projectRoot 'server'
$python = Join-Path $serverDirectory '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    & $uv venv (Join-Path $serverDirectory '.venv') --python 3.12
}
& $uv pip install --python $python -e "$serverDirectory[test]"

Write-Host 'Dependencies installed and the local vision model checksum verified.'
Write-Host 'Ensure qwen3-vl:2b-instruct is installed in Ollama, then run .\Start-Prototype.ps1.'
