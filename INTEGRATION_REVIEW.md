# Rohinth integration review

This is the merge gate for the integrated SIH26171 prototype. It is intentionally
evidence-driven: a unit test alone cannot approve a cross-boundary change.

## Review checklist

- [x] `extension/src/egress.ts` is the only reasoning-server caller.
- [x] Sanitized observations contain no raw values, selectors, URLs, cookies, or
      original image bytes.
- [x] Client and server use strict protocol `1.0` and policy `1.0` contracts.
- [x] Grades are cumulative and the implemented core invariant categories have
      receiver checks. Full detector-category parity remains a release finding;
      see `governance/SECURITY_REVIEW.md`.
- [x] Capture identity, origin, document revision, stale snapshots, and target
      state are checked before action execution.
- [x] Detector, encoding, validation, transport, and model failures fail closed.
- [x] Positive, malformed, stale-context, duplicate-action, and serialized-body
      leak tests exist for the current action and capture paths.
- [x] Chrome and Firefox package builds are generated from the same source tree.
- [x] Generated evidence is aggregate-only and excludes screenshots, profiles,
      keys, prompts, and request bodies.

## Required commands

```powershell
python scripts/verify-governance.py
.\Test-Prototype.ps1
```

The release reviewer must record the command output, commit, browser versions,
model digest, and synthetic task result in the release evidence. A failed gate
blocks integration; do not waive it because the demo appears to work.
