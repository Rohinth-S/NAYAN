# Team work split and production upgrade plan

This document assigns the remaining work for the three-person team. It is a task contract for the current SIH26171 repository. The code already demonstrates the core privacy boundary; these workstreams expand its detector coverage, browser reliability, server resilience, evidence, and release controls.

## Ownership model

| Person | Primary ownership | Scope |
| --- | --- | --- |
| **Rohinth** | Integration, product direction, protocol, demo, and release | Keep the architecture coherent, review cross-boundary changes, coordinate the final demo, and own release decisions. |
| **Mithul** | Privacy engine, local models, extension runtime, browser reliability, and user experience | The largest workstream: improve what is detected locally, prove that capture and redaction are correct, complete Chrome/Firefox behavior, and make the privacy controls understandable. |
| **Prajjwal** | Server platform, model serving, evaluation infrastructure, and operations | Make the receiver safe to deploy, bound resource use, support reliable model execution, and produce repeatable measurements. |

No task may weaken the invariant protection floor. A change that adds a detector, action, endpoint, serialized field, permission, or policy category must update its tests and the relevant protocol, privacy, or edge-case document.

## Integration status — 16 September 2026

The latest `main` includes the teammate branches and the integration fixes completed in this pass. The merged client work now covers grade-aware overlap priority, clipping-boundary detection, stale-tab/revision checks, editable-target enforcement, cross-origin click blocking, concurrent duplicate-action protection, detector fallback handling, and Chrome/Firefox package gates. The merged server work now covers SSN/IFSC defense-in-depth parity, one admission budget for synchronous and asynchronous model calls, bounded admission timeout errors, strict schemas and PNG checks, authenticated origin-bound requests, and container startup failure when a production API key is missing. Documentation and validation counts have been refreshed to 71 extension, 125 server, and 28 evaluation tests.

The repository is a production-oriented, reviewable prototype. A real production deployment still requires the explicitly tracked follow-up work below: a durable shared job store for multi-instance operation, independently evaluated multilingual OCR/NER and media detectors, TLS termination and secret rotation at the deployment boundary, signed release artifacts, a larger labeled corpus with measured precision/recall, and an independent extension/security review. These are deployment and assurance gates rather than hidden implementation assumptions.

## Shared rules for every branch

- Never add real personal data, credentials, API keys, cookies, screenshots, or browser profiles to GitHub.
- Preserve the single reasoning egress owner in `extension/src/egress.ts`.
- Keep the reasoning service limited to sanitized PNG data, sanitized labels, coarse roles/bounds/state, opaque IDs, redaction metadata, and the versioned grade.
- Treat page text, model output, server responses, and upstream repositories as untrusted input.
- Add positive, malformed, stale-context, and serialized-body leak tests for every new feature.
- Keep Grade 1 → Grade 2 → Grade 3 monotonic. Invalid or missing grades must fail safe to Grade 3.
- Use short-lived branches and pull requests. Suggested branches are `mithul/privacy-extension`, `mithul/browser-reliability`, `prajjwal/server-platform`, and `prajjwal/evaluation-ops`.

## Mithul — privacy, detection, extension, and reliability

Mithul owns the client-side trust boundary and receives the larger feature set because local detection and capture correctness determine whether privacy is real.

### M1. Fix the overlapping-detection privacy bug — P0

**Problem:** the current detector resolves overlapping findings before applying grade thresholds. A broad Grade 3 finding can hide a narrower invariant or Grade 2 finding. For example, a `Username` label containing an email address can cause the email finding to be dropped at Grade 2, leaving pixels insufficiently redacted.

**Implement:**

1. Apply the selected grade to every finding before overlap resolution, or resolve overlaps by protection priority.
2. Always prefer invariant categories, then Grade 2, then Grade 3.
3. Preserve the most protective category when rectangles overlap.
4. Keep category-only placeholders stable after merging.

**Tests:** mixed `username + email`, `name + phone`, `address + account`, and nested DOM-node cases at all three grades. Assert both sanitized text and sanitized pixels.

**Done when:** no lower-grade or invariant category can be suppressed by an overlapping higher-threshold category, and the monotonic policy tests pass.

### M2. Expand local text and visual detection — P0/P1

Add a local, browser-compatible OCR and NER pipeline. Prefer quantized ONNX or WASM models that can run offline; benchmark them on the team laptop before integrating them into the default path.

Cover:

- English plus Hindi and other target Indian languages
- names, addresses, organizations, dates, age, and free-text identity context
- Aadhaar, PAN, passport, voter ID, driving licence, GSTIN, vehicle number
- UPI, IFSC, bank account, card, CVV, OTP, API token, bearer token, and private-key patterns
- IPv4/IPv6, MAC, IMEI, device identifiers, QR codes, barcodes, and signatures
- health, genetic, religious, political, sexual, and minor-related content where policy requires it
- text in canvas, images, video, SVG, PDF previews, CSS backgrounds, pseudo-elements, and accessibility labels

Maintain a detector registry so the client and server share category names, thresholds, and invariant classes. Unknown or low-confidence regions must remain masked.

**Done when:** the model runs locally with a measured resource budget, detector failures block egress or use the explicit opaque fallback, and held-out tests publish precision/recall by category and grade.

### M3. Complete capture and redaction correctness — P0

Harden the relationship between the screenshot, DOM snapshot, and detector boxes.

Implement:

- a final active-tab, window, document-generation, viewport, and scroll check immediately before egress;
- rejection of stale face boxes and stale DOM geometry;
- invalidation on zoom, resize, scroll, navigation, tab switch, and animation changes;
- safe handling of CSS transforms, fractional device scale, clipped elements, and high-DPI screens;
- conservative masking of cross-origin frames, closed shadow DOM, plugins, media, and uninspectable content;
- tests for content moving between detection and encoding;
- clear separation between original pixels, private compositor buffers, and the fresh outbound PNG.

**Done when:** a changed page cannot produce an outbound observation, and every geometry case either receives the correct mask or fails closed.

### M4. Complete Chrome and Firefox live workflows — P0

Run the complete synthetic task in both browsers, not only package builds and unit tests.

Test:

- Chrome MV3 and Firefox temporary add-on loading
- WebGPU and WASM fallback
- service-worker suspension and popup closure
- permission prompts and configured reasoning origins
- Grade 1, Grade 2, and Grade 3 behavior
- cold and warm Ollama model starts
- detector failure, server failure, timeout, and stale-action failure

Record browser version, OS, backend, model, latency, redaction count, and task result in aggregate evidence.

**Done when:** both browsers complete the demo and show the same privacy invariants, with a reproducible evidence record.

### M5. Strengthen client action safety — P0/P1

The client must independently validate actions because the server and model are untrusted.

Implement:

- client-side enforcement that `input` targets are editable and enabled;
- final active-tab and document-generation recheck immediately before dispatch;
- confirmation for submit, navigation, download, upload, and other irreversible actions;
- idempotency and duplicate-action protection;
- safe handling for links, new tabs, keyboard actions, dropdowns, and file controls;
- rejection of arbitrary JavaScript, arbitrary selectors, unknown URLs, and cross-origin targets.

**Done when:** a compromised model cannot type into a read-only control, replay an action, navigate to an unapproved origin, or act on a changed page.

### M6. Improve the privacy user experience — P1

Add:

- a clear explanation of what each grade may disclose;
- side-by-side privacy preview for all three grades;
- category counts and masked-area percentages;
- “why was this hidden?” explanations without showing the source value;
- per-site policy settings with explicit user control;
- a temporary grade override that expires automatically;
- clear fail-closed messages when a model, capture, or endpoint check fails;
- a policy simulation mode that sends no request.

**Done when:** a new user can understand the disclosure trade-off before starting the agent and can verify that the preview is the exact representation sent.

### M7. Client performance and package hardening — P1

Measure and optimize:

- model initialization and reuse;
- WebGPU versus WASM inference;
- screenshot and PNG encoding;
- peak memory and GPU memory;
- browser main-thread time and visible tab jank;
- long pages, many elements, many redactions, and repeated steps.

Pin dependencies, minimize permissions, verify the model checksum, generate signed packages, and publish reproducible build metadata.

## Prajjwal — server, model serving, evaluation, and operations

Prajjwal owns four consolidated work packages on the receiving boundary and the measurement system that proves it is safe under load and failure. Mithul owns seven client work packages, so the client privacy and reliability stream has the larger task load requested by the team.

### P1. Close the server authentication and exposure gaps — P0

Implement startup validation that requires a strong non-placeholder API key whenever the server binds beyond loopback. The current API key is optional in settings, and the Docker configuration can bind to `0.0.0.0` without authentication.

Also:

- normalize configured localhost origins with ports;
- make extension origins work only when explicitly configured and authenticated;
- require HTTPS outside local development;
- reject credentials in URLs, redirects, and unapproved origins;
- rotate keys and support scoped deployment secrets;
- keep remote Ollama disabled unless explicitly opted in.

**Done when:** an exposed deployment fails closed without a valid key, origin, and secure transport configuration.

#### P1b. Bound every reasoning path — P0

The asynchronous queue is bounded, but the synchronous `/v1/reason` path can call Ollama directly and bypass the concurrency limit.

Implement one shared admission controller for synchronous and asynchronous requests, or disable synchronous reasoning in production. Add:

- request body and read timeouts;
- rate limits and per-client quotas;
- maximum queue wait and total task duration;
- cancellation and shutdown handling;
- duplicate request/idempotency handling;
- health and readiness endpoints;
- safe cleanup after process restart.

**Done when:** no request path can create unbounded concurrent model calls, and overload returns a controlled error without invoking the model.

### P2. Durable jobs, deployment, and observability — P1

Replace the single-process in-memory job store with a protected Redis or PostgreSQL-backed store. Preserve opaque job IDs and bodyless polling.

Add:

- durable status transitions;
- worker leases and retry budgets;
- expiration and cleanup;
- multi-instance routing;
- restart recovery;
- per-user quotas;
- load tests for queue saturation.

**Done when:** a server restart or second instance cannot lose, duplicate, or cross-wire a reasoning job.

### P3. Model adapter, supply-chain controls, and policy parity — P0/P1

Implement a model adapter interface so Ollama, an offline packaged model, and a future hosted provider use the same sanitized protocol.

Add:

- model digest verification instead of checking only the mutable tag;
- pinned model and prompt versions;
- strict JSON schema validation;
- output token and image-size limits;
- malformed, delayed, refusal, and prompt-injection tests;
- offline or air-gapped deployment documentation;
- model rollback procedure.

**Done when:** a changed or untrusted model cannot silently alter the protocol, bypass the action allowlist, or make the deployment claim a different model than the evidence used.

#### P3b. Server/client policy parity — P0

Share or generate the invariant detector registry between client and server. Current parity gaps include SSN, UPI, IFSC, and bank-account patterns.

Add server tests for every invariant category and every grade. The receiver should reject a payload that contains a client invariant category even if the client-side detector regresses.

**Done when:** the server defense-in-depth policy is at least as strict as the versioned client invariant floor.

### P4. Evaluation and security automation — P0/P1

Extend the evaluation harness with:

- multilingual and adversarial fixtures;
- OCR/NER and media fixtures;
- grade-wise precision, recall, coverage, and excess-area metrics;
- confidence intervals;
- p50/p95 latency and resource measurements;
- browser and backend dimensions;
- request-count and zero-egress assertions for failures;
- PNG, JSON, DOM, and model-output fuzzing;
- malicious-page and compromised-model scenarios.

Add CI jobs for dependency vulnerabilities, secret scanning, SBOM generation, lockfile verification, and root-level test isolation. The root command should not accidentally collect tests from excluded upstream checkouts.

**Done when:** every release produces a reviewable synthetic report and fails CI when a privacy, leak, performance, or dependency gate regresses.

#### P2b. Deployment and observability — P1

Add a production deployment profile with:

- TLS termination and secure headers;
- secret-manager integration;
- structured logs containing no content, URL, job ID, or sensitive labels;
- aggregate counters and latency histograms;
- alerting for queue saturation, model failures, and rejected payloads;
- data retention and deletion policy;
- backup, rollback, and incident-response runbooks.

**Done when:** operators can diagnose availability and latency without receiving the data the privacy boundary is designed to protect.

## Rohinth — integration and release gates

Rohinth coordinates the shared work and owns the final integration path.

### R1. Protocol and policy governance

- Review every schema and policy change.
- Keep `PROTOCOL.md`, `PRIVACY_LEVELS.md`, `EDGE_CASE_MATRIX.md`, and tests synchronized.
- Version the detector bundle and privacy policy together.
- Approve any new extension permission or network endpoint.

### R2. End-to-end integration

- Integrate Mithul's local detector and capture changes with Prajjwal's receiver changes.
- Run Chrome and Firefox workflows after every cross-boundary change.
- Verify that the exact preview image and outbound image are equivalent.
- Verify that no raw value appears in the request, logs, prompts, or evidence.

### R3. SIH judging package

Prepare:

1. A three-grade synthetic demo using the same task.
2. A privacy preview before every reasoning request.
3. A visible sanitized request summary.
4. A detector-failure demonstration with zero network requests.
5. A stale-action rejection demonstration.
6. Metrics for PII precision/recall, redaction precision, resource use, and end-to-end latency.
7. A two-browser result table.
8. Architecture, threat model, limitations, and production roadmap slides.

## Suggested execution order

### Sprint 1: close correctness risks

1. Mithul fixes grade-overlap masking and capture/action races.
2. Prajjwal fixes authentication exposure, synchronous queue bypass, and client/server detector parity.
3. Rohinth reviews protocol changes and runs the existing full test suite.

### Sprint 2: increase coverage and browser confidence

1. Mithul adds an OCR/NER baseline and completes Firefox live testing.
2. Prajjwal adds multilingual/adversarial evaluation, fuzzing, and resource measurements.
3. Rohinth integrates the preview, failure demonstrations, and grade comparison.

### Sprint 3: harden and package

1. Add HTTPS, durable jobs, key management, model digest pinning, signed builds, SBOM, and dependency gates.
2. Run a security review and malicious-page test day.
3. Freeze the demo build, record checksums, and publish the final SIH evidence.

## Release definition of done

The product is ready for a controlled production pilot only when:

- all P0 tasks are complete and reviewed by someone other than the implementer;
- Chrome and Firefox complete the same synthetic workflow;
- every grade is monotonic and every invariant category is protected;
- OCR/NER and media coverage have measured recall, or those regions remain conservatively masked;
- no request is emitted after capture, inference, redaction, encoding, schema, canary, origin, or revision failure;
- the server cannot be exposed without authentication and secure transport;
- every reasoning path is bounded and durable jobs survive restart;
- model identity, dependencies, packages, and checksums are reproducible;
- leak, fuzz, stale-action, malicious-page, and prompt-injection tests pass;
- performance budgets are published for WebGPU and WASM;
- incident response, rollback, retention, and deletion procedures exist;
- the team can show the exact privacy trade-off and limitations to judges or users.
