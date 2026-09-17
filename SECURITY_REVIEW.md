# Independent security review record

This project treats an independent review as a release prerequisite. The
repository contains automated gates and a reviewer checklist, but an
automated test run is not an independent security assessment.

## Scope for the reviewer

- Verify every browser-to-server egress path, including `fetch`, polling,
  extension-local offscreen IPC, error reporting, telemetry, and update code.
- Attempt to recover raw DOM, accessibility text, input values, screenshot
  pixels, canvas/video/SVG/PDF content, frame data, and service-worker state
  from network bodies, logs, crash reports, and persisted storage.
- Review the privacy-grade policy, high-assurance structure-only mode, final
  DLP gate, canary handling, action broker, manifest permissions, model
  loading, dependency locks, and release signatures.
- Exercise the adversarial corpus and the Chrome/Firefox browser matrix on
  supported hardware, including zoom, high-DPI, scrolling, animation, nested
  frames, and service-worker suspension.

## Status

| Item | Status | Evidence |
| --- | --- | --- |
| Automated contract, unit, evaluation, package, security-scan, SBOM, and supply-chain gates | Maintained in CI/local release gate | `evidence/latest-release.json` |
| Chrome browser matrix | Recorded when the local browser runner is available | `evidence/browser-matrix-chrome.json` |
| Firefox browser matrix | Requires a Firefox executable on the test host | `evidence/browser-matrix-firefox.json` |
| Independent third-party review | **Pending** | Reviewer and date must be recorded before production release |

Do not describe the project as independently certified until the final row has
a named reviewer, scope, date, findings, and remediation references.
