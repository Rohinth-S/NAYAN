[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$serverPython = Join-Path $projectRoot 'server\.venv\Scripts\python.exe'
$serverPytest = Join-Path $projectRoot 'server\.venv\Scripts\pytest.exe'
$serverRuff = Join-Path $projectRoot 'server\.venv\Scripts\ruff.exe'
$model = Join-Path $projectRoot 'extension\models\version-RFB-320.onnx'
$expectedModelHash = 'B63E0028667FD9E7E5DCC56EBD91E85281B8DF1498B4C3C5799DE9229305C0B1'

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
    # Evaluation tests import both evaluation.helpers and the server package.
    # Keep the upstream browser-use checkout outside pytest collection while
    # exposing the two first-party Python package roots explicitly.
    $env:PYTHONPATH = @(
        (Join-Path $projectRoot 'server')
        (Join-Path $projectRoot 'evaluation')
    ) -join [IO.Path]::PathSeparator
    & $serverPython -m pytest (Join-Path $projectRoot 'evaluation\tests') -q
    if ($LASTEXITCODE -ne 0) { throw "Evaluation tests failed with exit code $LASTEXITCODE." }
} finally {
    $env:PYTHONPATH = $oldPythonPath
}

if ((Get-FileHash -LiteralPath $model -Algorithm SHA256).Hash -ne $expectedModelHash) {
    throw 'UltraFace model checksum mismatch.'
}

$fetchOwners = Select-String -Path (Get-ChildItem (Join-Path $projectRoot 'extension\src\*.ts')).FullName -Pattern '\bfetch\s*\(' | Select-Object -ExpandProperty Path -Unique
if (($fetchOwners | Measure-Object).Count -ne 1 -or -not ($fetchOwners -match 'egress\.ts$')) {
    throw 'The source-level reasoning egress invariant failed.'
}
Write-Host 'All prototype checks passed.'
