# SIH26171 evaluation harness

This directory contains reproducible, synthetic evaluation assets for the privacy-preserving browser agent. It does not contain or represent measurements from a live run. Populate a run-results file only from observed extension/server executions.

## What is measured

`scripts/evaluate.py` reports:

- PII/sensitive-region detection micro and macro precision, recall, and F1. A prediction matches a labeled visual region at intersection-over-union (IoU) >= 0.5 by default. Optional local detector instrumentation can also match nonvisual sources using `sourceRef` plus `field`.
- Privacy-grade-aware scoring. Every observation records `privacy.grade` (`1`, `2`, or `3`; omitted legacy values
  default to `3`). Corpus annotations declare `minimumPrivacyGrade`, so a Grade 1 run is not penalized for
  intentionally retaining a Grade 2/3 contact or identity field. Over-redacting a field below the selected grade is
  still reflected in pixel precision/excess-area metrics.
- Redaction coverage: the fraction of sensitive ground-truth pixels covered by at least one outbound mask.
- Redaction pixel precision and excess area: how much of the redacted union overlaps a sensitive ground-truth region, without double-counting overlapping rectangles.
- Observed task success rate and mean steps.
- Min, median, mean, nearest-rank p95, and max for each supplied latency and resource metric.

The corpus is intentionally narrow. It tests synthetic PAN-, Aadhaar-, Indian-phone-, email-, password-, person-name-, face-, DOM-attribute-, visible-text-, canvas/image-, and inaccessible-frame cases. It does not establish universal PII detection or certified anonymization.

## Files

- `corpus/synthetic_cases.json`: labeled, explicitly synthetic fixtures and canaries.
- `corpus/adversarial-privacy-v1.json`: held-out synthetic coverage for multilingual text, canvas/image/QR/CSS/shadow-DOM surfaces, spacing errors, and overlap geometry. Its `results` field is intentionally `null` until a measured browser run produces evidence.
- `schemas/corpus.schema.json`: JSON Schema for corpus authors.
- `schemas/run-results.schema.json`: JSON Schema for measured result producers.
- `examples/run-results.template.json`: empty template; its null metadata and empty observations are deliberate.
- `scripts/evaluate.py`: deterministic scorer with no third-party runtime dependencies.
- `scripts/verify_receiver_payload.py`: strict protocol and canary verifier for the exact HTTP body captured at the server.
- `SECURITY_TEST_PLAN.md`: boundary, failure, action, and demo checks.

## Result producer contract

Each observation is local evaluation instrumentation keyed by `caseId` and a random `snapshotId`. It must contain `redactions[]` using the exact extension records:

```json
{
  "kind": "pii-text",
  "source": "regex",
  "bounds": { "x": 192, "y": 352, "width": 112, "height": 20 }
}
```

The extension's network request remains the strict protocol in `../PROTOCOL.md`; evaluation fields must never be appended to it. In particular, `piiDetections` is optional, local-only instrumentation. When it is absent, the evaluator treats `pii-text`, `password`, `sensitive-field`, and `face` redaction boxes as binary sensitive-region detections. Conservative `uninspectable-media`, `uninspectable-frame`, and `visual-fallback` masks contribute to pixel coverage but do not count as PII detections.

An implementation with a local detector callback may emit `piiDetections` to retain entity kinds. A prediction needs either screenshot-pixel `bounds` or the local-only pair `sourceRef` and `field`. Never place sensitive values, raw screenshots, selectors, or DOM content in a run-results file.

Recommended observed latency keys are `capture`, `localDetection`, `redaction`, `encoding`, `request`, `serverReasoning`, `action`, and `endToEnd`, all in milliseconds. Recommended resource keys are `peakRssMb`, `peakGpuMemoryMb`, `averageCpuPercent`, `maxMainThreadBlockMs`, and `outboundBytes`. The scorer also accepts additional non-negative numeric keys.

The cumulative policy is defined in `../PROTOCOL.md`: Grade 1 protects essential secrets, government/financial IDs,
faces, and uninspectable regions; Grade 2 adds direct contact/location identifiers; Grade 3 adds names, usernames,
employee IDs, and ambiguous populated fields. The grade changes local disclosure only; invariant protections remain
active at every grade.

## Run

From `evaluation/`:

```powershell
Copy-Item .\examples\run-results.template.json .\observed-run.json
# Populate observed-run.json from the extension test runner.
python .\scripts\evaluate.py `
  --corpus .\corpus\synthetic_cases.json `
  --results .\observed-run.json `
  --output .\evaluation-report.json
```

An empty template produces `null` rates and lists all corpus cases as missing. It never fabricates a zero or a successful measurement.

Capture the exact bytes received by `POST /v1/reason`, then verify a single case with:

```powershell
python .\scripts\verify_receiver_payload.py `
  --corpus .\corpus\synthetic_cases.json `
  --case-id structured-form-indian-pii `
  --payload .\receiver-body.json
```

Exit code `0` means every tested canary is absent, `page.origin` is a keyed session-scoped alias matching `https://site-<20 lowercase hex>.invalid`, and every labeled region satisfies the declared raster mode: semantic mode has the neutral placeholder background, while the explicit opaque fallback is black in the decoded fresh PNG. Exit code `1` means a leak or pixel assertion failed. Exit code `2` means the evidence was malformed or unverifiable, which is also a failed security gate.

## Tests

The tests are compatible with pytest:

```powershell
$env:PYTHONPATH = (Resolve-Path .).Path
python -m pytest .\tests -q
```

For comparisons, keep the corpus version, browser build, extension build, detector model hash, Ollama model/tag, viewport, hardware power mode, and run count fixed. Record cold-start and warm runs separately rather than merging them.
