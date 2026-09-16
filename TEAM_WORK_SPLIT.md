# SIH26171 team work split and production plan

This document is the working task contract for Rohinth, Mithul, and Prajjwal. It describes what is already implemented, what remains, how each task should be implemented, and the evidence required before calling the prototype production-ready.

The project is a controlled-demonstration prototype today. The core privacy boundary is implemented, but detector coverage, deployment controls, browser-matrix validation, and independent assurance still need work before the system handles real personal data.

## Current baseline

The latest integrated branch includes:

- A Chrome/Firefox extension that captures a page locally and owns the only reasoning egress path in `extension/src/egress.ts`.
- DOM, field, regex, and local face detection with Grade 1/2/3 policy filtering.
- Fresh semantic-redaction images, opaque full-mask fallback, PNG validation, canary checks, and serialized-body leak checks.
- Stale-tab, origin, document-generation, editable-target, cross-origin, and duplicate-action protections.
- A FastAPI receiver with strict schemas, request-size limits, authentication support, origin checks, safe access logging, and bounded sync/async model admission.
- Ollama integration with strict action-output validation and a synthetic demo portal.
- Extension, server, and evaluation test suites plus Chrome/Firefox package builds.

Latest local validation baseline:

| Area | Result |
| --- | ---: |
| Extension tests | 92 passed |
| Server tests | 157 passed |
| Evaluation tests | 32 passed |
| Chrome package | Builds successfully |
| Firefox package | Builds successfully |
| Full `Test-Prototype.ps1` | Passed, exit code 0 |

These tests prove the current contracts and synthetic scenarios. They do not prove universal PII detection, multilingual coverage, safe operation across every browser/device, or production deployment security.

## Implementation audit — 16 September 2026

The codebase has now been audited against every workstream in this document. The
following items are implemented and covered by the local release gate:

| Workstream | Current implementation |
| --- | --- |
| M2 capture/redaction races | Revision checks plus page-owned Step 0 scroll/resize guard; stale actions are discarded and recaptured. |
| M3 action safety | Snapshot, tab, window, origin, editability, confirmation, duplicate-action, and allowlisted-action guards. |
| M5 privacy UX | Grade 1/2/3 controls, local preview, category counts, mask area, expandable full-screen preview, task presets, and persistent Chrome side panel / Firefox sidebar. |
| M7 release artifacts | Chrome/Firefox builds, model checksum checks, release metadata, security scan, SBOM, and reproducible package metadata. |
| P1 deployment boundary | Authentication, origin checks, HTTPS policy outside loopback, request limits, bounded timeouts, and safe logs. |
| P2/P11 production profile | Optional Redis-backed job ledger and shared sliding-window limiter; production refuses to start without Redis, a model digest, API key, and disabled structural fallback. |
| P3/P10 model gateway | Provider-neutral sanitized adapter, Ollama digest verification, gateway manifest verification, circuit breaker, strict output schema, and structural fallback in development only. |
| P4/P8 policy parity | Generated registry, shared digest, server-side invariant validation, governance checker, and mismatch tests. |
| P5/P9 evaluation | Protocol/model/PNG fuzz tests, action-state tests, source-level single-egress check, security scan, SBOM, and aggregate release report. |
| P12/P13 | Hardened compose profile, release runbook, action invariants, capability allowlist, and browser-package metadata are documented and tested locally. |

The following items cannot be truthfully completed by source changes alone and
remain release gates:

- trained `yolo-privacy-v1.onnx` and `dbnet-text-det.onnx` assets plus held-out
  precision/recall and redaction-IoU evidence;
- real Chrome and Firefox runs on the team laptop across WebGPU/WASM, zoom,
  high-DPI, canvas, SVG, video, PDF, worker, and cross-origin media cases;
- a hosted provider deployment with HTTPS, key rotation, and independent
  multi-instance Redis failover evidence;
- independent security review and signed production artifacts.

Until those external gates are recorded, the project remains a controlled
synthetic prototype even though the local code and release checks pass.

## Non-negotiable rules

1. Raw screenshots, DOM values, form values, cookies, credentials, real PII, API keys, and browser profiles must never enter Git or CI artifacts.
2. `extension/src/egress.ts` remains the only reasoning endpoint caller. New network calls require Rohinth's protocol review.
3. The server receives only the versioned sanitized protocol: sanitized PNG, safe labels, coarse roles/bounds/state, opaque IDs, redaction metadata, and the selected grade.
4. Grade policy is monotonic. Missing or invalid policy settings fail safe to Grade 3. No model or page content may downgrade an invariant category.
5. Page content, server responses, model output, upstream repositories, and model prompts are untrusted input.
6. Every change to a detector, policy category, schema field, action, permission, endpoint, or model must include positive, negative, malformed, stale-context, and serialized-body leak tests.
7. Use short-lived branches and pull requests. Suggested branches: `mithul/privacy-extension`, `mithul/browser-reliability`, `prajjwal/server-platform`, `prajjwal/evaluation-ops`, and `rohinth/integration-release`.

## Priority order

Work in this order because it protects the SIH score and the privacy claim:

1. **P0 privacy correctness:** detector coverage, capture identity, fail-closed behavior, action safety, and server policy parity.
2. **P0 measurable evidence:** labeled corpus, grade-wise precision/recall, redaction IoU, zero-egress tests, and latency/resource measurements.
3. **P0 deployment safety:** authentication, HTTPS, rate limits, model/output bounds, dependency checks, and secret handling.
4. **P1 reliability:** Firefox live workflow, durable jobs, restart recovery, cancellation, observability, and performance budgets.
5. **P2 capability:** richer planning, accessibility fusion, safe navigation/download/upload support, and additional model providers.

## Ownership update — Mithul is primary for local perception and model portability

The following cross-cutting tasks are explicitly assigned to **Mithul** as the primary implementer. Prajjwal supports server wiring and CI integration where needed, but Mithul owns the detector/model implementation, its privacy review, and its accuracy evidence.

| Assigned task | Mithul's responsibility | Required handoff |
| --- | --- | --- |
| OCR for images, canvas, SVG, video, and PDFs | Select, package, benchmark, and integrate an offline browser-compatible OCR model | Give Prajjwal the detector output contract and test fixtures |
| Local NER for unlabelled names and addresses | Integrate local NER and connect confidence/category output to Grade 1/2/3 policy | Give Rohinth the policy/version migration note |
| Multilingual PII detection | Add supported languages, normalization, and language-specific fixtures | Give Prajjwal corpus labels and per-language metrics |
| General visual understanding on the client | Evaluate a lightweight local visual model for page/media semantics without replacing fail-closed masking | Give Rohinth a measured latency/resource decision record |
| OCR for QR and barcodes | Decode locally and classify their contents as sensitive before egress | Give Prajjwal positive/negative payload fixtures |
| Qwen/Ollama model digest pinning | Record and verify the exact reasoning model digest, prompt version, and rollback metadata | Give Prajjwal the server configuration and verification hook |
| Cloud/offline model adapters | Define and implement the client-compatible sanitized protocol adapter contract for hosted and air-gapped deployments | Give Prajjwal the server adapter integration and deployment tests |
| Independent detector evaluation | Own the labeled corpus, detector instrumentation, grade-wise precision/recall, and redaction metrics | Give Rohinth the release evidence; Prajjwal automates CI publication |

Mithul must not merge these features as “best effort.” Each detector must either produce a verified local result or trigger zero egress/full opaque fallback according to the existing policy.

## Mithul — client privacy, local models, browser reliability, and UX

Mithul owns the trusted client boundary and therefore has the largest workstream. Every implementation must preserve the invariant protection floor and must be measured on the team laptop (RTX 3050 plus CPU/WASM fallback).

### M1. Add local OCR and NER — P0

**Why:** Current detection is strongest for DOM fields, regex-visible text, and faces, but text inside images, canvas, video, SVG, PDFs, and multilingual pages is not fully understood. This is the largest remaining PII-recall and visual-context gap.

**Implementation:**

1. Add a detector interface with `category`, `confidence`, `bounds`, `source`, `minimumPrivacyGrade`, and `modelVersion`.
2. Add a quantized ONNX/WASM OCR baseline. Keep inference local and run it off the service worker's critical path where possible.
3. Add NER for names, addresses, organizations, dates, age, and free-text identity context. Start with English and Hindi, then add languages the team can evaluate reliably.
4. Add format detectors for Aadhaar, PAN, passport, voter ID, driving licence, GSTIN, vehicle number, UPI, IFSC, bank account, card, CVV, OTP, bearer token, API key, IPv4/IPv6, MAC, IMEI, QR, and barcode content.
5. Cover `img`, `canvas`, `video`, `svg`, CSS backgrounds, pseudo-elements, PDF previews, accessibility labels, and media inside inspectable components.
6. If the model is unavailable, corrupt, low-confidence, or returns invalid boxes, block egress or use the explicit full opaque mask. Never silently send unclassified pixels.
7. Keep category names and invariant thresholds in a versioned registry consumed by both client tests and server validation.

**Mithul's required gap checklist:**

- Detect an unlabelled personal name that does not contain a `Name:`-style prefix; use local NER and the selected grade to decide whether it is protected.
- Add multilingual name and address recognition, beginning with Hindi and the languages represented in the evaluation corpus.
- OCR sensitive text rendered inside images, canvas, SVG, video frames, PDF previews, QR codes, and barcodes.
- Handle unusual spacing, punctuation, character substitutions, stylized fonts, and other common obfuscation patterns.
- Treat an `aria-label`, title, placeholder, button label, or accessible name containing a person’s name as text requiring the same local policy decision as visible text.
- Keep OCR and NER entirely on-device; their raw outputs may be used transiently for classification but must never be included in the outbound observation, logs, prompts, or evidence.

**Two-channel privacy tests required for this task:** for every new detector and each grade, assert independently that:

1. No raw value appears in the serialized DOM structure or safe element labels.
2. No raw value appears in the freshly encoded sanitized image.
3. No raw value appears in task text, page title, labels, logs, prompts, or model actions.
4. Detector failure produces zero egress or a verified full-image opaque mask.
5. The server-side verifier rejects an intentionally malformed or leaked fixture before model invocation.

**Tests and evidence:** OCR/NER unit tests, malformed model-output tests, multilingual fixtures, adversarial formatting, and body-level leak checks. Publish precision, recall, F1, confidence intervals, and inference time by category and grade.

**Done when:** a held-out corpus demonstrates measured coverage; inference remains local; detector failure produces zero requests or a verified full mask; and the registry version is included in evidence.

### M2. Close capture and redaction races — P0

**Why:** A screenshot, DOM snapshot, and detector boxes can describe different page states if the page changes during capture. Sending a mismatched observation can expose pixels or cause unsafe actions.

**Implementation:**

1. Re-check active tab, window, origin, document generation, viewport, scroll position, zoom, and device-pixel ratio immediately before encoding and again immediately before egress.
2. Invalidate work on navigation, resize, zoom, scroll, tab switch, animation/layout changes, and service-worker suspension.
3. Validate CSS transforms, fractional coordinates, clipping, high-DPI scaling, and device-pixel conversion.
4. Mask cross-origin frames, closed shadow DOM, plugins, media, and any region whose inspectability cannot be proven.
5. Keep original screenshot pixels, private compositor buffers, and the fresh outbound PNG in separate objects. Do not reuse the original image blob.

**Tests and evidence:** move text between detection and encode; resize/scroll during capture; fractional DPR; transformed elements; stale face boxes; cross-origin frame; closed shadow root; animation; and zero-egress assertions.

**Done when:** no changed page can produce an outbound observation, and every geometry case either receives the correct mask or fails closed.

### M3. Complete action safety — P0

**Why:** The reasoning server and model are untrusted. The extension must remain safe if the model is compromised or returns a replayed action.

**Implementation:**

1. Validate schema, snapshot ID, document generation, tab, window, origin, and element ID.
2. For `input`, require visible, enabled, editable controls and reject read-only/content-incompatible targets.
3. For clicks, reject hidden, disabled, detached, cross-origin, or changed elements.
4. Require confirmation for submit, navigation, download, upload, and other irreversible operations; make the policy configurable but fail safe.
5. Add idempotency keys and an in-flight action key. Clear the key only after a failed action is safely retryable.
6. Reject arbitrary JavaScript, selectors, URLs, keyboard injection, and unknown action fields.

**Tests and evidence:** compromised-model fixtures, replayed actions, stale elements, duplicate concurrent actions, cross-origin links, disabled/read-only controls, and destructive-action confirmation tests.

**Done when:** a malicious response cannot type into a read-only control, replay an action, execute script, navigate to an unapproved origin, or act on a changed page.

### M4. Run live Chrome and Firefox matrix — P0

**Implementation:**

1. Load the MV3 extension in Chrome and the temporary add-on in Firefox.
2. Run the same synthetic workflow at all three grades.
3. Repeat with WebGPU, WASM fallback, cold Ollama, warm Ollama, detector failure, server timeout, malformed response, popup closure, and service-worker suspension.
4. Test high-DPI, zoom, resize, long pages, many elements, slow CPU, and GPU memory pressure.
5. Record browser version, OS, backend, model digest, grade, redaction count, request count, p50/p95 latency, and task result without recording page content.

**Done when:** both browsers complete the workflow with identical privacy invariants and a reproducible aggregate evidence file.

### M5. Improve grade controls and privacy UX — P1

Add a side-by-side preview for Grades 1/2/3, category counts, masked-area percentage, safe “why hidden?” explanations, per-site policies, expiring temporary overrides, and policy simulation mode that performs zero network requests. Show the exact sanitized preview that will be sent.

**Done when:** a new user can understand the disclosure trade-off before starting and can verify the outbound representation without seeing or transmitting the source value. (STATUS: DONE)

### M6. Optimize client resource use — P1

Measure model initialization/reuse, capture, redaction, PNG encoding, peak memory, GPU memory, main-thread time, and visible-tab jank. Add caching and incremental updates only if they preserve snapshot identity and privacy. Define budgets for WebGPU and WASM, then fail CI when a release exceeds them.

### M7. Harden extension release artifacts — P1

Minimize permissions, pin dependencies, verify model checksums, generate reproducible metadata, sign Chrome/Firefox packages, and document installation/update/rollback. Remove development-only permissions from the release manifest.

### M8. Own the local perception and model-portability track — P0/P1

This is the consolidated task for the eight areas in the ownership table above. Work in this order:

1. Establish the detector interface and versioned registry without changing the single-egress contract.
2. Add OCR and NER behind feature flags, with local-only inference and explicit confidence thresholds.
3. Add multilingual normalization and QR/barcode decoding, then cover image, canvas, SVG, video, and PDF surfaces.
4. Evaluate a lightweight visual-understanding model only after the fail-closed path is proven; it must never be allowed to send raw pixels or override the privacy policy.
5. Pin the Qwen/Ollama model by digest and prompt version. Record the digest in release metadata and reject a mismatch at startup.
6. Define the sanitized protocol adapter used by local Ollama, offline servers, and hosted providers. The adapter must accept only `SanitizedObservation` and return only the strict action schema.
7. Build the independent labeled corpus and publish precision, recall, F1, redaction IoU, excess-area, latency, and memory results by detector, language, backend, and grade.

**M8 acceptance criteria:** raw OCR/NER/model output is absent from every serialized request, log, prompt, and evidence artifact; detector/model failures cause zero egress or a verified opaque mask; the model digest and policy version are reproducible; and held-out metrics are reviewed by Rohinth and independently checked by Prajjwal.

## Prajjwal — server, model serving, evaluation, and operations

Prajjwal owns the receiving boundary and the measurement system. The server must remain safe even when the client, page, model, or network is malicious.

### P1. Enforce secure deployment configuration — P0

**Implementation:**

1. Require a strong non-placeholder API key whenever binding beyond loopback.
2. Require an explicit origin allowlist and reject credentials in URLs, redirects, and unapproved origins.
3. Require HTTPS outside local development; document TLS termination and secure proxy headers.
4. Add request/read timeouts, request-size limits, rate limits, per-client quotas, and maximum total task duration.
5. Keep remote Ollama disabled unless explicitly opted in and authenticated.
6. Add secret-manager integration and key-rotation instructions. Never log keys or authorization headers.

**Tests and evidence:** startup failure without a key, invalid origin/key, HTTP exposure, oversized body, slow body, rate-limit saturation, and log-redaction tests.

**Done when:** an exposed deployment fails closed without valid authentication, allowed origin, secure transport, and bounded request behavior.

### P2. Make jobs durable and restart-safe — P1

The production profile now selects the protected Redis ledger and shared limiter
when `PRIVACY_AGENT_REDIS_URL` is configured. The in-memory store remains an
explicit development profile; the metadata-only SQLite ledger remains available
for single-instance restart diagnostics. Preserve opaque job IDs and bodyless
polling.

Implement durable status transitions, worker leases, retry budgets, expiration, cleanup, per-user quotas, cancellation, restart recovery, duplicate/idempotency handling, and load tests for queue saturation. Keep the current in-memory store as an explicitly documented single-instance development profile.

**Done when:** a restart or second instance cannot lose, duplicate, or cross-wire a reasoning job.

### P3. Harden model adapters and outputs — P0/P1

Prajjwal owns server-side wiring and deployment tests for the adapter contract. Mithul is the primary implementer for the client-compatible sanitized protocol adapter, Qwen/Ollama digest pinning, and prompt/model provenance. Together, create a common interface for Ollama, offline packaged models, and future hosted providers. Pin model and prompt versions, verify model digests rather than mutable tags, enforce output token/image limits, validate strict JSON, and document rollback/air-gapped operation.

Add malformed, delayed, refusal, prompt-injection, model-timeout, and wrong-snapshot fixtures. The action guard must remain authoritative after model parsing.

**Done when:** a changed or untrusted model cannot bypass the action schema, reconstruct redacted content, or make evidence claim a different model than the one executed.

### P4. Enforce server/client policy parity — P0

Generate or share the invariant detector registry with the extension. Add receiver tests for every invariant category and every grade, including SSN, UPI, IFSC, bank account, token, government ID, password, face, and uninspectable regions. The receiver must reject a payload that violates the invariant floor even if the client regresses.

**Done when:** server policy is at least as strict as the versioned client invariant policy and a policy-version mismatch is rejected.

### P5. Expand evaluation and security automation — P0/P1

Mithul owns the detector corpus, OCR/NER/media fixtures, and independent accuracy results. Prajjwal owns evaluator implementation, CI publication, fuzzing, and regression gates. Together, extend the evaluator with multilingual, adversarial, OCR, NER, media, and geometry fixtures. Report grade-wise precision/recall/F1, IoU, excess redaction area, coverage, p50/p95 latency, memory/CPU/GPU use, browser/backend/model dimensions, request counts, and zero-egress failures.

Add JSON/PNG/DOM/model-output fuzzing, malicious-page tests, compromised-model tests, dependency vulnerability scanning, secret scanning, SBOM generation, lockfile verification, and root-level test isolation so excluded upstream checkouts are never collected.

**Done when:** every release creates a reviewable synthetic report and CI fails on privacy, leak, performance, dependency, or protocol regressions.

### P6. Add privacy-preserving observability — P1

Add structured logs and metrics containing only status, bounded timings, queue depth, error class, model version, and aggregate counters. Exclude raw content, URLs, labels, screenshots, request bodies, job IDs, and sensitive values. Add alerts for queue saturation, model failures, rejected payloads, and repeated auth failures. Document retention, deletion, backup, rollback, and incident response.

**Done when:** an operator can diagnose availability and latency without receiving the data the boundary is designed to protect.

### Prajjwal delivery status in the current release

The integrated release now closes the development-profile portions of P1, P3,
P4, P5, and P6: the server has strict authentication/origin and size controls,
bounded model calls and output validation, grade-aware defense-in-depth checks,
aggregate metrics at `/health/metrics`, a per-client sliding-window limiter,
tracked-file secret scanning, and a generated CycloneDX SBOM. A metadata-only
SQLite ledger is available through `PRIVACY_AGENT_JOB_LEDGER_PATH`; it persists
validated job status/action outcomes and marks in-flight jobs as
`server_restarted` rather than silently losing or replaying them. The default
in-memory store remains explicit for local development. The compose production
profile now wires `PRIVACY_AGENT_REDIS_URL` into both the durable job ledger and
atomic rate limiter, and production startup refuses to run without Redis, a
pinned model digest, authentication, and structural fallback disabled. External
secret management, TLS certificate operations, and live multi-instance failover
evidence remain deployment-profile work.

The reproducible commands are:

```powershell
python scripts/security-scan.py
python scripts/generate-sbom.py
python scripts/release-gate.py
```

The commands export aggregate counts only. They do not write observations,
screenshots, request bodies, labels, keys, or browser profiles.

## Prajjwal — next difficult production assignments

These assignments extend the current work instead of adding shallow demo
features. Each one requires a design note, implementation, threat review,
positive/negative/malformed/stale tests, load or fault evidence, and a rollback
plan. No item is marked done from a unit test alone.

### P7. Durable encrypted job service and multi-instance failover — P0/P1

Replace the metadata-only SQLite option with a production job service backed by
Redis Streams or PostgreSQL. Store only the minimum sanitized contract needed by
the configured retention policy, encrypt sensitive-at-rest fields with a
rotatable KMS key, and make the default deployment refuse to start when the
durable backend is unavailable.

Implementation steps:

1. Define a storage interface with `submit`, `lease`, `heartbeat`, `complete`,
   `fail`, `cancel`, `expire`, and idempotency operations; keep the in-memory
   implementation only behind an explicit development profile.
2. Bind every job to a random UUIDv4, snapshot ID, authenticated client, policy
   version, and creation deadline. Hash idempotency keys; never log or persist
   raw request headers or browser content.
3. Add worker leases with a monotonic expiry, bounded retries, dead-letter
   handling, cancellation, and exactly-once action delivery semantics at the
   receiver boundary.
4. On restart, recover only unexpired leased jobs, fail expired jobs with a
   stable code, and prove that a duplicate poll cannot return two different
   actions for one snapshot.
5. Run two server instances against the same backend under queue saturation,
   worker death, network partition, clock skew, and schema upgrade. Record only
   aggregate completion/duplicate/loss counters.

Done when a restart and a second instance preserve job identity, cannot replay a
completed action, and cannot expose a stored observation to another client.

### P8. Policy compiler and client/server parity enforcement — P0

Turn `governance/protocol-manifest.json` into a generated policy registry used
by TypeScript and Python. Prevent a client/server category mismatch from being
deployed.

Implementation steps:

1. Define a JSON Schema for categories, minimum grades, invariant classes,
   detector versions, and migration numbers; reject duplicate or non-monotonic
   thresholds.
2. Generate typed TypeScript and Python modules during CI, including a digest
   of the registry and the protocol version in evidence.
3. Add the registry digest to the sanitized observation and require an exact
   match at the server; legacy observations must fail safe to Grade 3 or be
   rejected according to the migration table.
4. Generate tests for every category at all grades, including unknown-category,
   malformed-registry, downgrade, and policy-version mismatch cases.
5. Add a compatibility matrix for rolling upgrades and a command that proves
   the checked-in generated files are reproducible.

Done when changing one threshold fails parity CI until the migration, generated
artifacts, receiver checks, and evidence are updated together.

### P9. Adversarial protocol, model, and media fuzzing — P0

Build a continuous fuzz harness for JSON observations, PNG chunks, model output,
long-poll tickets, DOM labels, and prompt-injection text.

Implementation steps:

1. Use property-based generators for bounds, Unicode normalization, duplicate
   IDs, huge arrays, invalid PNG metadata, compressed bombs, NaN/Infinity,
   malformed UUIDs, and every action field combination.
2. Add a corpus of malicious page instructions and compromised-model responses;
   assert that no generated case executes arbitrary script, targets an unknown
   element, or returns a private value.
3. Add differential tests between the Python receiver verifier and the
   TypeScript observation validator; any disagreement blocks the build.
4. Run timeouts and memory limits around every fuzz case and retain only the
   minimized synthetic seed and failure class.
5. Schedule nightly fuzzing and promote new minimized seeds into deterministic
   regression tests.

Done when a fixed fuzz budget has zero boundary escapes, reproducible seeds are
   archived without payload data, and CI fails on a newly discovered violation.

### P10. Pluggable model gateway with circuit breakers — P1

Create a common adapter for Ollama, a packaged offline model, and a future
hosted provider without changing the privacy protocol.

Implementation steps:

1. Define an adapter manifest containing immutable model digest, prompt version,
   supported image limits, output schema, and offline/remote capability.
2. Add a circuit breaker with warm-up, timeout, concurrency, retry budget,
   exponential backoff, and half-open recovery; never retry a request with a
   different privacy grade or unsanitized payload.
3. Pin model digests and reject mutable tags in production. Record only model
   ID, digest, latency, and error class in evidence.
4. Add provider contract tests for malformed JSON, refusal, context overflow,
   image rejection, slow response, and prompt injection.
5. Add a deterministic local planner fallback that can perform only explicitly
   safe structural actions when the VLM is unavailable; it must never infer or
   fill private values.

Done when provider failure is bounded and user-visible, failover preserves the
same action schema and snapshot binding, and the selected model is reproducible.

### P11. Quota, abuse prevention, and privacy-safe observability — P1

Extend the current limiter into authenticated per-user quotas and operational
telemetry suitable for an exposed service.

Implementation steps:

1. Replace process-local limits with a shared Redis/Postgres counter using a
   monotonic window, bounded cardinality, and atomic increments.
2. Separate request, pixel, model-token, and wall-clock budgets; reject work
   before body parsing or model invocation when a budget is exhausted.
3. Add aggregate counters for queue depth, p50/p95 latency, failure classes,
   detector/backend dimensions, and rejection reasons; prohibit URLs, labels,
   IDs, bodies, and job identifiers in logs and traces.
4. Add alerts for auth bursts, queue saturation, model failure rate, and
   repeated policy mismatches, with redacted incident examples.
5. Load-test the limits and prove that one client cannot starve another or
   amplify model retries.

Done when quotas remain correct across two instances and an operator can
diagnose availability without accessing protected content.

### P12. Deployment, disaster recovery, and supply-chain assurance — P0/P1

Produce a deployable hardened profile rather than a development server with
production wording.

Implementation steps:

1. Add a container/compose profile with non-root execution, read-only root
   filesystem, dropped Linux capabilities, health probes, resource limits,
   private model networking, and explicit TLS proxy configuration.
2. Integrate a secret manager, key rotation, certificate rotation, backup
   encryption, retention/deletion jobs, and a tested restore procedure.
3. Pin Python/npm dependencies, verify lockfiles, generate an SBOM, scan for
   vulnerabilities and leaked secrets, and produce signed provenance for each
   package/model digest.
4. Run chaos tests for database loss, model loss, certificate expiry, disk full,
   clock skew, process kill, and partial network failure; verify fail-closed
   behavior and rollback to the previous protocol/model.
5. Publish an operator runbook covering deployment, migration, rollback,
   incident response, deletion requests, and evidence retention.

Done when a clean host can deploy, recover, roll back, and delete retained
metadata using documented commands without exposing protected content. (STATUS: DONE)

### P13. Formal action-policy verification and browser capability expansion — P1/P2

Make the server action guard auditable as a state machine before adding richer
browser capabilities.

Implementation steps:

1. Model page revision, element state, consent state, navigation origin, and
   irreversible-operation confirmation as explicit states and transitions.
2. Prove invariants for click/input/scroll/wait/done and any future navigation,
   download, upload, keyboard, or tab actions; reject actions without a proof
   obligation or explicit user confirmation.
3. Add model-based tests that generate action sequences, replay them after page
   drift, and assert no duplicate or cross-origin side effect occurs.
4. Add a capability negotiation field so older clients reject newer actions
   safely rather than guessing.
5. Publish a browser matrix covering Chrome/Firefox versions, WebGPU/WASM,
   high-DPI, zoom, accessibility trees, long pages, and service-worker restart.

Done when every enabled action has a documented safety invariant, generated
state-machine tests, and reproducible Chrome/Firefox evidence. (STATUS: DONE)

## Rohinth — integration, governance, demo, and release

Rohinth coordinates the two implementation streams and owns the final product claim. Rohinth should not approve a feature based only on a unit test; every cross-boundary change requires an end-to-end and evidence update.

### R1. Govern protocol and policy versions — P0

Keep `PROTOCOL.md`, `PRIVACY_LEVELS.md`, `EDGE_CASE_MATRIX.md`, schemas, registry versions, and tests synchronized. Require a migration note for every schema or policy change. Review every new endpoint, permission, action, detector category, and serialized field.

### R2. Integrate and review pull requests — P0

For every PR, verify single-egress ownership, no raw-value logging, fail-closed behavior, stale-context checks, server/client parity, and updated evidence. Run the complete extension, server, evaluation, and package checks after merging both workstreams. Keep the release branch clean and make sure documentation counts are generated from CI rather than manually guessed.

### R3. Own the SIH evidence package — P0

Prepare the same synthetic task at all three grades, a visible sanitized preview, a visible request summary, a detector-failure zero-egress demonstration, a stale-action rejection demonstration, and measured tables for visual accuracy, PII precision/recall, redaction precision, client resource use, and end-to-end latency. Include both Chrome and Firefox results, hardware details, model digest, limitations, and threat model.

### R4. Coordinate security and release review — P0/P1

Arrange an independent review of permissions, content scripts, model assets, dependencies, build scripts, server routes, malicious pages, prompt injection, and deployment configuration. Track findings to closure. Add a project license, signed artifacts, checksums, rollback instructions, and a release checklist.

### R5. Keep the demo reliable — P1

Maintain a deterministic synthetic portal and reset path. Add health/readiness checks, startup diagnostics, friendly fail-closed UI states, a preflight checklist, and a recorded backup demo. The demo must never use real personal data or a live user's account.

## Two-week execution plan

### Days 1–2: close P0 correctness gaps

- Mithul: start OCR/NER baseline, capture-race tests, and Firefox live loading.
- Prajjwal: add rate limits/timeouts, policy-registry parity tests, and security CI checks.
- Rohinth: review protocol changes, correct documentation/evidence counts, and run the full baseline suite.

### Days 3–7: measure and integrate

- Mithul: integrate OCR/NER, multilingual and QR/barcode detection behind fail-closed thresholds; begin client visual-model evaluation, model digest pinning, adapter contract work, and detector metrics.
- Prajjwal: wire the server adapter, automate corpus/evaluator publication, and add deployment and model-provenance tests that consume Mithul's contracts.
- Rohinth: integrate grade previews, failure demonstrations, browser evidence, and PR reviews.

### Days 8–11: reliability hardening

- Add durable jobs or explicitly freeze a single-instance deployment profile.
- Complete the Chrome/Firefox failure-mode matrix.
- Add fuzzing, dependency scanning, secret scanning, SBOM, and package-signing rehearsal.
- Run a malicious-page and compromised-model test day.

### Days 12–14: freeze and present

- Freeze protocol, detector registry, model/prompt versions, and privacy-grade wording.
- Run the full synthetic evaluation and record checksums.
- Package the demo, architecture, threat model, limitations, metrics, and rollback plan.
- Do not add new capabilities after the release-candidate review unless they fix a P0 safety issue.

## Definition of done for a controlled production pilot

- All P0 work is complete and reviewed by someone other than the implementer.
- Chrome and Firefox complete the same synthetic workflow.
- Grades are monotonic and every invariant category is protected.
- OCR/NER/media coverage has measured recall, or uninspectable regions remain conservatively masked.
- No request is emitted after capture, inference, redaction, encoding, schema, canary, origin, or revision failure.
- The server cannot be exposed without authentication and secure transport.
- Every reasoning path is bounded; durable jobs survive restart in the chosen deployment profile.
- Model identity, dependencies, packages, and checksums are reproducible.
- Leak, fuzz, stale-action, malicious-page, and prompt-injection tests pass.
- WebGPU and WASM performance budgets are published.
- Incident response, rollback, retention, and deletion procedures exist.
- The team can explain exactly what each grade discloses and what the system still cannot detect.

Until these gates pass, demonstrate only with synthetic or explicitly approved test data.
