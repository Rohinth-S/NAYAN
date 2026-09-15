# Client release and browser verification

This runbook closes the client release gates without claiming browser results that were not measured.

## Package and checksum gate

```powershell
Push-Location extension
npm ci
npm run check
npm run release-metadata
Get-Content dist/RELEASE_METADATA.json
Pop-Location
```

The metadata file records SHA-256 hashes for every generated Chrome and Firefox artifact. Release automation must sign those artifacts with the maintainer's CI secret; private signing keys never belong in this repository.

## Chrome workflow

1. Load `extension/dist/chrome` as an unpacked extension.
2. Open the synthetic portal and enter only synthetic values.
3. Run **Privacy preview** at Grades 1, 2, and 3; verify the preview changes monotonically and the request counter remains zero.
4. Start the same task and record browser version, detector backend, redaction count, p50/p95 latency, and final action result.
5. Force a detector failure and a stale-page change; verify zero reasoning requests and a rejected action.

## Firefox workflow

1. Load `extension/dist/firefox/manifest.json` using `about:debugging` → **This Firefox** → **Load Temporary Add-on**.
2. Repeat the exact synthetic task and failure cases above.
3. Store aggregate measurements only. Do not commit screenshots, profiles, URLs, API keys, or raw page values.

The repository CI verifies both package builds and all deterministic tests. Browser versions, hardware, and Ollama model startup latency are environment-specific and must be recorded by the operator running the live demo.
