# Integration security review

Review date: 16 September 2026  
Review scope: extension source, server boundary, model adapter, release scripts,
permissions, logs, and synthetic demo flow.

## Findings

| ID | Finding | Disposition |
| --- | --- | --- |
| SR-01 | A second reasoning fetch would bypass the audited boundary. | Closed by the governance gate; `extension/src/egress.ts` is the only source fetch owner. |
| SR-02 | Raw values, URLs, selectors, and original image bytes could enter evidence. | Closed for checked-in summaries; recursive sensitive-field checks run in `verify-governance.py`. |
| SR-03 | Model output can be stale, malformed, or target a disabled control. | Closed by strict schemas, revision checks, action validation, and action-guard tests. |
| SR-04 | Non-loopback deployment without transport/auth controls would weaken the claim. | Closed in the development profile; production deployment remains blocked until HTTPS, a strong key, and an explicit origin allowlist are configured. |
| SR-05 | Universal OCR/NER, OS-wide capture, and ordinary website traffic are outside v1. | Accepted limitation; documented in `THREAT_MODEL.md`, `PRIVACY_LEVELS.md`, and `VALIDATION_REPORT.md`. |

The automated review is reproducible with `python scripts/verify-governance.py`
and `python scripts/release-gate.py`. An independent human review is still a
release prerequisite for real personal data; the synthetic SIH demo remains the
approved scope until that review is signed off.
