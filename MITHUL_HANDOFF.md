# Mithul handoff

Date: 2026-09-16

## Current state

The working tree contains the local privacy perception and model portability work assigned to Mithul. It is ready to be recorded as one commit on `main` after the verification commands below. The implementation keeps raw page content local, uses pinned model revisions and hashes, and sends only sanitized observations to the reasoning adapter.

Implemented areas:

- Local OCR (English and Hindi), NER, visual inference, and barcode detection behind the perception feature flag.
- Fail-closed detector contracts with confidence, grade, time, pixel, text, and frame budgets.
- Private canvas redaction for images and media, with cleanup in `finally` blocks.
- A versioned detector registry shared by the extension and server, including Hindi and additional credential, identity, network, and payment patterns.
- Pinned perception asset metadata and hash validation during packaging; downloaded model binaries remain ignored by Git.
- Sanitized model adapter contracts, gateway transport validation, Ollama digest pinning, strict JSON responses, and offline-by-default behavior.
- A synthetic perception evaluation corpus and local evidence report.
- README notes describing the opt-in feature and model adapter configuration.

## Verification

From the repository root:

```powershell
$py = 'server/.venv/Scripts/python.exe'
& $py -m ruff check server/app server/tests
& $py -m pytest server/tests
Set-Location extension
npm run test
npm run typecheck
npm run package:perception
npm run evaluate:perception
npm run release-metadata
Set-Location ..
& $py scripts/verify-governance.py
& $py scripts/security-scan.py
& $py scripts/release-gate.py
git diff --check
```

The last recorded results were 133 server tests and 80 extension tests passing. The local evaluation report records 12 synthetic examples, OCR exact match 11/12, OCR p95 134.02 ms, and NER p95 252.92 ms. These are development measurements, not production accuracy claims.

## Remaining work

- Run a real Chrome and Firefox browser matrix, including SVG, video, PDF, canvas, worker, and cross-origin media cases. Browser and GPU measurements are not yet recorded.
- Expand the evaluation corpus beyond the 12 synthetic examples, add independent review, and collect verified visual PII boxes/IoU before admitting visual detections into privacy decisions. Visual inference is intentionally evidence-only today.
- Add positive and negative barcode/QR fixtures and format edge-case tests.
- Record and verify the production Ollama model digest, or configure a hosted gateway with HTTPS, an API key, and a pinned digest. The current evidence has no live Ollama digest.
- Complete gateway deployment integration, contract/load tests, signing/SBOM release hardening, and independent security review.

## Files to start with

- `extension/src/perception.ts` and `extension/src/perception-runtime.ts`
- `extension/src/image-redactor.ts`
- `extension/models/perception-lock.json`
- `extension/scripts/evaluate-perception.mjs`
- `server/app/detector_registry.py`
- `server/app/model_adapter.py` and `server/app/gateway_adapter.py`
- `evidence/local-perception.json`
