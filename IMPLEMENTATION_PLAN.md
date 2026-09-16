# SIH26171 end-to-end implementation plan

Date: 2026-09-16 (updated for Approach B architecture)

## Deliverable

A reproducible hackathon prototype with a Chrome MV3 extension, Firefox extension package, local screenshot/DOM privacy processing, a user-selectable cumulative Grade 1/2/3 policy, a single fail-closed egress path, an open-weight Ollama reasoning server, revision-bound browser actions, a synthetic evaluation portal, and automated boundary tests.

This is a production-oriented prototype. It will not claim certified anonymization or universal PII detection without an independent security review and a labeled evaluation corpus.

## Trust boundary

Raw screenshots, DOM nodes, form values, secret mappings, browsing history, cookies, and browser control stay inside the extension on the user's machine. The reasoning server receives only a strict `SanitizedObservation` containing a freshly encoded masked raster, sanitized visible labels, opaque element IDs, coarse roles/bounds, redaction metadata, and a random snapshot revision.

The server returns one schema-validated action. The extension checks the revision, action allowlist, target element, and domain before executing it. Website traffic caused by navigation or form submission is separate from traffic to the reasoning server. The selected grade is frozen into each observation and is never allowed to downgrade the invariant protection floor.

## Components

| Component | Responsibility |
| --- | --- |
| `extension/` | Cross-browser capture, grade-aware DOM heuristics, local text classification, unified vision detection (YOLOv8n/v10n multi-class) with WebGPU/WASM fallback, canvas-app privacy mitigation (DBNet blind mask), scroll-drift guard (Step 0 Abort Gate), LangGraph.js state-graph orchestration, policy-gated pixel masking, preview, final outbound validation, agent loop, and action execution. |
| `server/` | Strict FastAPI request/response schemas (extended for Approach B detection classes), size/auth/origin controls, payload-safe logging, Ollama structured reasoning, health/model checks, synthetic portal, and leak-capture test mode. |
| `browser-use/` | Optional guarded Python baseline for comparison; it is kept outside the primary repository because it is a nested upstream checkout. |
| `PRIVACY_LEVELS.md` | Versioned category matrix, grade semantics, always-protected invariants, detector coverage and known gaps. |
| `artifacts/` | Built Chrome/Firefox packages and reproducible validation reports. |

## Build phases

1. Freeze versioned request/action schemas and security invariants.
2. Freeze the cumulative privacy-grade matrix and unit-test local DOM/text classification and opaque element mapping.
3. Integrate unified vision detector interface and YOLOv8n/v10n multi-class model implementation.
4. Implement canvas-app privacy mitigation (3-tier: visual redaction, DBNet blind mask, manual escalation).
5. Implement scroll-drift guard (Step 0 Abort Gate) for mid-flight race prevention.
6. Implement the extension popup, LangGraph.js state-graph orchestrator, background egress gateway, and revision-bound executor.
7. Implement the Ollama reasoning service and synthetic portal.
8. Test the exact serialized receiver payload with synthetic canaries in text, inputs, attributes, URLs, and pixels.
9. Build Chrome and Firefox artifacts and run a real Chrome end-to-end workflow.
10. Record measured latency/resource results (dual-metric: local median/p95 + end-to-end), limitations, setup commands, and demo steps.

## Acceptance criteria

- No reasoning request is emitted if capture, model inference, redaction, encoding, or validation fails.
- Raw screenshots and known synthetic canaries are absent from the serialized server request.
- The selected grade is present in `privacy.grade`, defaults to Grade 3, and is applied locally to the task, labels, fields and raster. Credentials, government/financial identifiers, faces, document IDs (Aadhaar, PAN, voter ID, driving license, passport), signatures, custom private values and uninspectable content are protected at every grade; Grade 2 adds contact/location identifiers and Grade 3 adds names and ambiguous populated fields.
- Protected regions are covered by category-only semantic redaction cards in a newly encoded image; the explicit inference-failure fallback is a fully black frame.
- Canvas-app elements receive 3-tier privacy treatment: visual redaction, opt-in DBNet detection-only blind masking, or manual escalation.
- The scroll-drift guard (Step 0 Abort Gate) invalidates stale SoM registries when viewport drift is detected during VLM network calls.
- The server rejects unknown fields, oversized payloads, unsupported image encodings, stale/invalid actions, and missing authentication when enabled.
- Only one audited background function can contact the reasoning endpoint.
- Returned actions contain the current snapshot ID and opaque element ID; stale actions are rejected locally.
- Chrome and Firefox builds complete from one source tree.
- The policy is monotonic: moving from Grade 1 to Grade 2 to Grade 3 never exposes a category that a lower grade protected, and an invalid/missing grade fails safe to Grade 3.
- A real Chrome demo completes a multi-step task through the sanitized server boundary, with deterministic grounding for high-confidence form prerequisites.
- Tests and documentation state detector coverage and unresolved privacy limitations without claiming perfect anonymity.

## Verification evidence

- Type checks, lint, unit tests, server contract tests, and extension build checks.
- Receiver-side leak assertions over the final HTTP body.
- Redacted-image fixtures and bounding-box metrics.
- A live synthetic workflow with step count, cold/warm latency, redaction count, and action result.
