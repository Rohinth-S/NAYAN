[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$serverPython = Join-Path $projectRoot 'server\.venv\Scripts\python.exe'
$serverPytest = Join-Path $projectRoot 'server\.venv\Scripts\pytest.exe'
$serverRuff = Join-Path $projectRoot 'server\.venv\Scripts\ruff.exe'
$model = Join-Path $projectRoot 'extension\models\version-RFB-320.onnx'
$expectedModelHash = '34CD7E60AEFF28744C657DE7A3DC64E872D506741DE66987F3426F2B79F88017'

if (-not (Test-Path -LiteralPath $serverPython -PathType Leaf)) { throw 'Run .\Setup-Prototype.ps1 first.' }

Push-Location (Join-Path $projectRoot 'extension')
try {
    npm run check
    if ($LASTEXITCODE -ne 0) { throw "Extension checks failed with exit code $LASTEXITCODE." }
} finally { Pop-Location }

Push-Location (Join-Path $projectRoot 'server')
try {
    & $serverPytest
    if ($LASTEXITCODE -ne 0) { throw "Server tests failed with exit code $LASTEXITCODE." }
    & $serverRuff check .
    if ($LASTEXITCODE -ne 0) { throw "Server lint failed with exit code $LASTEXITCODE." }
} finally { Pop-Location }

$oldPythonPath = $env:PYTHONPATH
try {
    $env:PYTHONPATH = Join-Path $projectRoot 'evaluation'
    & $serverPython -m pytest (Join-Path $projectRoot 'evaluation\tests') -q
    if ($LASTEXITCODE -ne 0) { throw "Evaluation tests failed with exit code $LASTEXITCODE." }
} finally {
    $env:PYTHONPATH = $oldPythonPath
}

if ((Get-FileHash -LiteralPath $model -Algorithm SHA256).Hash -ne $expectedModelHash) {
    throw 'UltraFace model checksum mismatch.'
}

$fetchOwners = rg -l '\bfetch\s*\(' (Join-Path $projectRoot 'extension\src') -g '*.ts'
if (($fetchOwners | Measure-Object).Count -ne 1 -or -not ($fetchOwners -match 'egress\.ts$')) {
    throw 'The source-level reasoning egress invariant failed.'
}
Write-Host 'All prototype checks passed.'
