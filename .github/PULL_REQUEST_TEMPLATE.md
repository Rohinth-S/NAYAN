## Change

<!-- Describe the user-visible behavior and the reason for the change. -->

## Privacy and trust-boundary impact

- [ ] No raw HTML, DOM values, selectors, cookies, storage, real URL, original screenshot, or ID-to-DOM map crosses the reasoning boundary.
- [ ] No additional reasoning-network call was added; `extension/src/egress.ts` remains the audited egress owner.
- [ ] Privacy-grade behavior is monotonic and the invariant protection floor is unchanged or stronger.
- [ ] New detectors/actions are documented in `PRIVACY_LEVELS.md`, `PROTOCOL.md`, and/or `EDGE_CASE_MATRIX.md` as applicable.

## Validation

- [ ] `.\Test-Prototype.ps1` passes, or the focused checks below explain the exception.
- [ ] Positive, malformed, stale-page, and serialized-body leak tests cover the change.
- [ ] Chrome and Firefox builds were checked when extension code changed.
- [ ] Latency/resource impact and known limitations are recorded when relevant.

## Evidence

<!-- List commands, synthetic fixtures, browser/model versions, and results. Never attach real personal data or secrets. -->
