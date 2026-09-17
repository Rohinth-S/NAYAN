# SIH26171 release checklist

## Protocol and privacy

- [ ] Run `python scripts/verify-governance.py`.
- [ ] Review `PROTOCOL.md`, `PRIVACY_LEVELS.md`, and `EDGE_CASE_MATRIX.md` for
      the exact release version.
- [ ] Confirm no new endpoint, permission, detector category, action, or field
      was added without a migration note and tests.

## Evidence

- [ ] Run `Test-Prototype.ps1` from a clean checkout.
- [ ] Run the synthetic portal at Grades 1, 2, and 3; show the local sanitized
      preview and zero-request preview counter.
- [ ] Record Chrome and Firefox browser/version/backend/model dimensions.
- [ ] Record p50/p95 latency, redaction counts, request count, and task result;
      store aggregate values only in `evidence/`.
- [ ] Demonstrate detector failure and stale-action rejection with zero unsafe
      requests/executions.

## Security and release integrity

- [ ] Use synthetic values only and rotate any accidentally exposed local key.
- [ ] Keep Ollama loopback-only for the demo; require authentication and HTTPS
      before any non-loopback deployment.
- [ ] Review permissions, content scripts, model attribution, dependencies,
      malicious-page behavior, prompt injection, and logs.
- [ ] Run `npm run release-metadata` and publish SHA-256 values for both packages.
- [ ] Sign packages outside the repository, record the signer and key ID, and
      retain rollback instructions.
- [ ] Confirm the project license and third-party notices are present.
- [ ] Set `PRIVACY_AGENT_SIGNER_FINGERPRINT` to the approved 40/64-character
      fingerprint and sign both archives, `dist/RELEASE_METADATA.json`, and
      `artifacts/sbom.json`; production verification rejects untrusted or
      unverifiable signatures.

## Demo reliability

- [ ] Run `scripts/demo-preflight.ps1` before recording or presenting.
- [ ] Reset the synthetic portal before each run.
- [ ] Keep the model warm and have a deterministic evidence run available if
      local model inference is unavailable.
- [ ] Stop the prototype with `Stop-Prototype.ps1` after the session.
