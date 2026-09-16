param(
    [Parameter(Mandatory=$true)]
    [string]$FilePath
)

if (-not (Test-Path $FilePath)) {
    Write-Error "File not found: $FilePath"
    exit 1
}

# Generate SHA256 Checksum
$hash = Get-FileHash -Path $FilePath -Algorithm SHA256
$hashFile = "$FilePath.sha256"
"$($hash.Hash)  $((Get-Item $FilePath).Name)" | Out-File -FilePath $hashFile -Encoding ASCII

Write-Host "Generated checksum at $hashFile"

# Optional: GPG Signature (requires gpg installed and configured)
# If gpg is not present, we just skip the cryptographical signing and only leave the hash.
if (Get-Command gpg -ErrorAction SilentlyContinue) {
    Write-Host "Signing with GPG..."
    gpg --detach-sign --armor $FilePath
    Write-Host "Generated GPG signature at $FilePath.asc"
} else {
    Write-Host "GPG not found in PATH, skipping cryptographic signature. Only SHA256 hash was generated."
}

Write-Host "Release signing complete!"
