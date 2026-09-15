# Validation report

This report records the SIH26171 prototype evidence available on 16 September 2026. It describes a working hackathon boundary; it does not certify anonymization or claim that every kind of personal data is detected.

The current raster policy is semantic redaction: locally detected sensitive regions are replaced by neutral cards with italic category-only markers. Grade 3 is the default. A detector failure can use the explicit opaque full-image fallback.

## Evidence snapshot

| Area | Observed result | Evidence and interpretation |
| --- | --- | --- |
| Extension source and package checks | **73 tests passed** | `extension/npm run check` covers the cumulative policy, Grade 1/2/3 behavior, custom-value protection, semantic placeholder composition, PNG composition, ONNX post-processing and WebGPU-to-WASM recovery, pinned-tab freshness, asynchronous job tickets, bodyless polling, total timeout, duplicate-action protection, clipping-boundary detection, detector fallback handling, and the single egress boundary. Chrome and Firefox packages were rebuilt. |
| Server contract and boundary checks | **126 tests passed; Ruff clean** | Covers strict grade parsing/defaulting, grade-aware defense-in-depth checks (including SSN and IFSC), authentication, limits, keyed aliases, PNG metadata/animation rejection, semantic placeholder backgrounds, opaque fallback masks, bounded jobs/long polls, shared sync/async model admission with timeout, Ollama output handling, prompt-injection containment, stale actions, safe logs, and receiver-body validation. |
| Evaluation harness | **28 tests passed** | The scorer and receiver verifier now understand `minimumPrivacyGrade`, fail-safe legacy Grade 3, semantic pixels, opaque fallback pixels, grade-aware canaries, and privacy-grade reporting. |
| Grade policy behavior | **Passed** | Grade 1 intentionally permits names/contact context; Grade 2 rejects contact/location identifiers; Grade 3 rejects labeled names/usernames/employee identifiers and unknown populated fields; every grade rejects credentials, government/financial identifiers, faces, custom values and uninspectable content. |
| Semantic local preview | Passed | A locally generated semantic preview (`artifacts/sanitized-preview-semantic.png`) shows category-only placeholders, preserved public labels and checkbox state, WASM local inference, and no reasoning request. The screenshot is intentionally excluded from Git history because it is machine-specific; reproduce it locally with the documented preview command. |
| Core deterministic Chrome baseline | Passed | [Synthetic E2E summary](evidence/extension-e2e-summary.json) records three sanitized requests, WASM inference, nine redactions per request, no serialized canaries, accepted payloads, and `Enrollment submitted successfully.` in 3,406 ms. This is retained as the core boundary baseline; grade-specific behavior is covered by the current 73/126/28 test suites. |
| Live Ollama HTTP smoke | Passed | Fresh authenticated requests to the running local `qwen3-vl:2b-instruct` service returned HTTP 200 with valid structured actions in 19,115 ms while warm; earlier runs ranged from 8,046 ms warm to 78,261 ms after a model unload. Keep the model resident for the demo and report this hardware variance against the latency rubric. |
| Previously recorded full live browser task | Passed | [Recorded live summary](evidence/live-ollama-summary.json) contains three authenticated sanitized POSTs, bodyless polls, WASM local detection, no serialized canaries, and successful synthetic enrollment. It is retained as core live evidence; the current privacy-grade selector is validated separately by the focused suites. |

The reviewed UltraFace asset is pinned by SHA-256:

`34CD7E60AEFF28744C657DE7A3DC64E872D506741DE66987F3426F2B79F88017`

The final package hashes are recorded after the last `npm run check`:

| Package | SHA-256 |
| --- | --- |
| `sih-private-agent-chrome-0.1.0.zip` | `812F6BA0C62047EE36375738716BA416F94C3B2F6B66B4D1B115EF293A5DB774` (6,624,946 bytes) |
| `sih-private-agent-firefox-0.1.0.zip` | `E1E228119D56320B1BD7C44A1801406311FF6F655E64B81F9F911C93837F3495` (6,621,673 bytes) |

The deterministic browser runs observed the WASM fallback. Chrome uses an offscreen document for local ONNX inference; Firefox uses the direct local runtime. A WebGPU-capable run should be recorded separately rather than inferred from the WASM result.

## What the evidence establishes

The extension performs capture, local classification, cumulative-grade policy filtering, face inference, semantic placeholder composition, fresh PNG encoding, final serialized-body validation, and revision-bound action execution before the reasoning request. The server independently validates the strict v1.0 shape, the integer `privacy.grade`, the keyed origin alias, PNG contents, grade-aware text classes and action safety before Ollama sees the observation.

Grade 1 is an intentional disclosure choice: names and ordinary contact context may remain visible. Grade 2 removes direct contact/location identifiers. Grade 3 adds names, usernames, employee identifiers and ambiguous populated fields. The invariant floor is never relaxed. See [PRIVACY_LEVELS.md](PRIVACY_LEVELS.md) for the full category matrix and detector coverage.

The reasoning-channel guarantee ends at the configured endpoint. Website navigation, form submission, downloads, third-party scripts, cookies used by the visited site, and other ordinary page traffic are outside this prototype's guarantee. Media and frames that v1 cannot inspect locally are masked wholesale. Regex/DOM rules can miss unlabeled names, multilingual data, new identifier formats, text split across nodes, closed shadow DOM, and visual text; no OCR claim is made for canvas or image text.

## Reproduce the checks

From the project root:

```powershell
.\Setup-Prototype.ps1
.\Test-Prototype.ps1
.\Start-Prototype.ps1
```

For focused checks:

```powershell
Push-Location extension
npm run check
Pop-Location

Push-Location server
.\.venv\Scripts\pytest.exe
.\.venv\Scripts\ruff.exe check .
Pop-Location

$env:PYTHONPATH = (Resolve-Path .\evaluation).Path
& .\server\.venv\Scripts\python.exe -m pytest .\evaluation\tests -q
```

The aggregate script also checks the UltraFace checksum and the source-level single-egress invariant. The launcher stores the API key in `.runtime\api-key.txt`, keeps Ollama on loopback, verifies the selected model, and never prints the key or page data. The container profile requires a configured API key before startup. The first multimodal request may include local model-load latency; later requests use the resident model.

## Demo gate

Load the unpacked Chrome or temporary Firefox package, open the synthetic portal, choose a grade in the popup, run **Privacy preview**, and then start the task. Show the selected grade and its explanation, the sanitized image, the redaction count, and the result. Demonstrate Grade 1 with a synthetic name/contact context, Grade 2 with contact masking, and Grade 3 with name masking. Keep the deterministic receiver canary evidence alongside the live model smoke result. Demonstrate one forced model/capture failure and show that the request count remains zero, then replay a stale action and show that the browser rejects it.

Before any real-data deployment, add and label a much larger multilingual corpus, evaluate a local OCR/NER model, conduct an independent extension/security review, sign the browser packages, and set deployment-specific HTTPS origins and secrets.
