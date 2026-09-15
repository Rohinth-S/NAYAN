# Contributing

Thanks for helping build the SIH26171 privacy-focused browser agent. Keep changes small, testable, and explicit about the privacy boundary. The project is a prototype, so a clear limitation is better than an unmeasured privacy claim.

## Start here

1. Read `README.md`, `TEAM_HANDOFF.md`, `ARCHITECTURE.md`, `PROTOCOL.md`, and `PRIVACY_LEVELS.md`.
2. Run `.\Setup-Prototype.ps1` from the repository root.
3. Run `.\Test-Prototype.ps1` before changing code and again before opening a pull request.
4. Use the synthetic demo and evaluation corpus. Do not test with real personal data.

## Repository rules

- Never commit `.runtime/`, `.tools/`, `artifacts/`, browser profiles, model caches, `.env` files, API keys, certificates, or real user data.
- Do not add a second reasoning-network call. `extension/src/egress.ts` is the audited egress boundary; update the source-boundary test if the architecture genuinely changes.
- Do not send raw HTML, DOM values, selectors, cookies, storage, real URLs, original screenshots, or the ID-to-DOM map to the server.
- A new detector must be assigned a category in `extension/src/privacy-policy.ts`, documented in `PRIVACY_LEVELS.md`, covered at all relevant grades, and tested for overlap and false positives.
- A new action must have an exact schema, target/revision checks, positive and malformed tests, a stale-page test, and a serialized-body leak assertion.
- Keep privacy policy changes monotonic. A higher grade may redact more, never less; the invariant floor cannot be relaxed.
- Use synthetic canaries and fixtures only. If a fixture resembles a credential, label it as fictional and keep it out of screenshots and logs.

## Local checks

```powershell
Push-Location extension
npm run typecheck
npm test
npm run package
Pop-Location

Push-Location server
.\.venv\Scripts\pytest.exe
.\.venv\Scripts\ruff.exe check .
Pop-Location

$env:PYTHONPATH = (Resolve-Path .\evaluation).Path
& .\server\.venv\Scripts\python.exe -m pytest .\evaluation\tests -q
```

`.\Test-Prototype.ps1` runs the same checks, verifies the UltraFace checksum, and checks that the extension has only one source-level `fetch` owner. Build artifacts are generated locally and remain ignored.

## Change checklist

Before opening a pull request, confirm:

- the change has a focused test and does not weaken a fail-closed path;
- `PROTOCOL.md`, `PRIVACY_LEVELS.md`, `EDGE_CASE_MATRIX.md`, or `TEAM_HANDOFF.md` are updated when behavior or claims change;
- the exact serialized request contains no new sensitive field or metadata;
- Chrome and Firefox packages still build from the same source tree;
- error paths do not log request bodies, raw values, URLs, screenshots, job IDs, or model prompts;
- latency/resource impact is measured if capture, inference, image composition, or transport changed;
- limitations and detector gaps are stated in the PR description.

## Pull requests

Use a short branch name such as `privacy/ocr-canvas` or `runtime/firefox-parity`. Keep commits focused and explain the user-visible behavior, trust-boundary impact, tests run, and known limitations. Request review from the privacy/evaluation owner for policy, detector, protocol, or egress changes.

## Reporting a security issue

Do not open a public issue containing a secret, raw personal data, an exploitable payload, or a screenshot with sensitive content. Contact the repository maintainers privately, include a minimal synthetic reproduction, affected commit, browser/runtime versions, and whether any data crossed the reasoning boundary. See `SECURITY.md` for the reporting expectations.
