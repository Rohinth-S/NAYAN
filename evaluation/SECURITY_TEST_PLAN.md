# SIH26171 security test plan

## Scope and pass rule

The trusted boundary is the extension process up to its single reasoning-request gateway. The reasoning server is an untrusted receiver. Normal requests made by the visited website are outside this boundary and must be described separately in the demo.

A security case passes only when the exact body received at `POST /v1/reason` conforms to protocol v1.0, contains no test canary in supported textual encodings, and contains a freshly encoded PNG whose required regions satisfy the declared raster mode: semantic regions contain the neutral placeholder proof and opaque fallback regions are black. A detector, capture, validation, or verifier error is a failure; an error must never be recorded as a pass.

All identifiers in `corpus/synthetic_cases.json` are fictional test data. Do not run these tests against real accounts or production pages.

## Receiver-side evidence procedure

1. Start the server in its synthetic leak-capture test mode. The HTTP handler must retain the raw request bytes in memory immediately after reading the request and before model invocation or Pydantic parsing. Do not reconstruct the evidence by serializing a parsed object.
2. Disable access logs and ensure the capture contains only synthetic traffic. Save one body per `caseId` after the run. Do not commit captured bodies, because a failing body intentionally contains canaries.
3. Confirm exactly one `POST /v1/reason` was observed for each successful capture. Record zero requests for each fail-closed case.
4. Run `scripts/verify_receiver_payload.py` against those exact bytes. Keep its safe report, which identifies canaries only by ID and never echoes their value.
5. Separately validate the response schema and action locally against the current `snapshotId`, `documentId`, domain, action allowlist, and opaque element map.

The verifier independently enforces the exact request keys from `PROTOCOL.md`, the keyed session-scoped origin alias `^https://site-[0-9a-f]{20}\.invalid$`, no path/query/fragment/credentials, opaque element IDs, `image.mime == image/png`, strict base64, PNG CRCs and dimensions, exact element/state (including structural `required` metadata)/redaction/privacy shapes, and `privacy.rawImageRetained == false`.

Privacy-grade checks are cumulative and fail-safe: omitted `privacy.grade` is treated as Grade 3; invalid types or
values are rejected. Grade 1 may retain contact/name context, while Grades 2 and 3 must remove direct contact,
location, DOB, and IP identifiers; Grade 3 also removes labeled names and user/employee identifiers. Every grade
must remove credentials/secrets, government and financial identifiers, face/biometric regions, known canaries, and
uninspectable content. The receiver verifier uses each synthetic annotation's `minimumPrivacyGrade` when deciding
whether a canary or labeled region is required to be absent.

## Canary matrix

| Case | Synthetic canary locations | Required receiver result |
| --- | --- | --- |
| `structured-form-indian-pii` | Visible name/email/password/phone/PAN; password/autocomplete attributes; email in a DOM attribute and page title; PAN/email in URL fragment/query | `form-password` and `form-pan` must never appear at any grade. `form-email`/`form-phone` must be absent at Grades 2–3, and `form-name` at Grade 3; Grade 1 intentionally permits those contact/name canaries when they were not configured as user known-private values. `page.origin` is only the keyed `.invalid` alias. Field regions satisfy the declared semantic/opaque mode; usable button label remains. |
| `canvas-image-aadhaar-face` | Aadhaar-shaped and email pixels; Aadhaar-shaped image attribute; two synthetic face patches | Entire canvas/image region is covered at every grade because it is uninspectable, using semantic placeholders when local inference is available or the explicit opaque fallback otherwise. Face boxes are reported when ONNX succeeds. v1 does not claim OCR detection of the pixel text. |
| `non-sensitive-controls` | No sensitive canary; order number, date, price, and ordinary label | No false-positive PII box; actionable label remains sufficient to open the order. |
| `inaccessible-cross-origin-frame` | Synthetic secret rendered inside an uninspectable iframe | Whole frame is a `uninspectable-frame` placeholder region (or the explicit opaque fallback); the Continue control remains available. |

For every case, scan task text, title, labels, element state, redaction metadata, IDs, and the complete raw JSON body. Checking only `elements[]` is insufficient.

## Fail-closed tests

Each test below must produce the stated effect. Instrument the egress function and assert its invocation count; a console message alone is not evidence.

| Injection | Expected behavior |
| --- | --- |
| Visible-tab screenshot API rejects or returns an empty image | Zero reasoning requests; show a local error. |
| DOM collection throws or returns an invalid rectangle | Zero requests. Do not reuse the previous observation. |
| Text sanitizer throws, times out, or returns an unknown kind | Zero requests. |
| ONNX model is missing, corrupt, or produces invalid boxes | With the explicit visual fallback enabled, mask the whole screenshot and set `visualFallback="full-mask"`; otherwise send zero requests with `visualFallback="none"`. |
| Canvas, image, video, SVG, object/embed, CSS background, or iframe content cannot be inspected | Cover the region with a semantic placeholder before encoding, or use the explicit full-image opaque fallback when local inference is unavailable. |
| Any sensitive/fallback rectangle is outside the image or has a non-positive size | Zero requests after outbound validation. |
| Mask composition or fresh PNG encoding fails | Zero requests; never send the original screenshot or a CSS-overlay capture. |
| `image.dataBase64` is JPEG, malformed base64, corrupt PNG, or dimension-mismatched | Extension sends zero requests; server also rejects if directly attacked. |
| Unknown top-level, page, element, state, image, redaction, or privacy field is introduced | Outbound schema rejects locally; server rejects independently. |
| Full URL, HTML, selector, DOM attributes, input value, cookie, local path, secret map, or raw screenshot is inserted | Outbound schema rejects locally. Receiver canary verification must fail if the request is forced through. |
| Reasoning endpoint is non-HTTPS and non-loopback, host is not allowlisted, or redirects | Zero requests. Redirect following stays disabled. |
| Transport creation or authentication setup fails | Zero requests; no raw or less-sanitized retry path. |
| `privacy.grade` is omitted | Interpret as Grade 3; never silently downgrade the local policy. |
| `privacy.grade` is boolean, fractional, string, or outside 1–3 | Reject the observation before model invocation. |
| A Grade 1 request contains a name or email | Permit it when no invariant secret/ID rule matches; score it as intentional disclosure. |
| Any grade contains a password, token, government/financial ID, face, or uninspectable region | Reject text or require the corresponding local redaction/fallback. |
| Server response has an unknown field, multiple actions, or an unsupported action | Reject locally without browser interaction. |
| Response `snapshotId` differs from the active snapshot | Reject locally. |
| Navigation changed `documentId` or the DOM revision after the request | Reject locally and recapture before any later action. |
| Action references a missing opaque element ID | Reject locally. |
| Action targets a disallowed domain or leaves the approved origin policy | Reject locally. |

## Server negative tests

Send direct synthetic requests that bypass the extension and verify HTTP rejection before Ollama is called:

- Missing or wrong `Content-Type`, unsupported schema version, malformed JSON, unknown fields, and duplicate logical IDs.
- Missing/incorrect `X-Privacy-Agent-Key` when authentication is enabled.
- Body, image, element-count, label-length, task-length, and redaction-count limits exceeded by one unit and by a large amount.
- Non-PNG MIME, decompression bomb dimensions, corrupt CRC, and base64 with ignored junk.
- Raw site origin, noncanonical alias, alias with uppercase hex, credentials, path, query, fragment, `file:`, `data:`, loopback rebinding form, or malformed port.
- Ollama unavailable, timeout, malformed model JSON, multiple actions, stale snapshot, and unsupported action.

For each rejection, assert a bounded, content-free error; assert the Ollama call count is zero when validation should precede reasoning; and assert logs contain no body, task, title, label, base64, or canary.

## Measurement run

Use a fixed viewport and build. Run every corpus case once after clearing model/browser caches for a cold sample, then at least ten warm repetitions. Record each sample rather than only an average. Required timestamps surround capture, local detection, composition/encoding, request, server reasoning, action, and end-to-end completion. Sample extension/browser RSS, GPU memory when available, CPU percentage, maximum main-thread blocking duration, and serialized outbound bytes.

Generate the report with `scripts/evaluate.py`. Do not fill absent measurements with zero. Archive the run-results JSON, report, extension version/hash, detector asset hash, server version/hash, model tag, browser version, OS, device/power mode, and whether WebGPU or WASM ran.

## Live demo checklist

- Build both Chrome MV3 and Firefox packages from the same source revision and retain build logs.
- Start local Ollama and the reasoning server; show health/model checks without exposing environment variables or keys.
- Open the synthetic portal and the extension preview. Show raw content only in the local side of the preview and the separately labeled sanitized image beside it.
- Run `structured-form-indian-pii`: show masks, the exact safe receiver report, snapshot-bound click, and completion state.
- Run `canvas-image-aadhaar-face`: state clearly that v1 masks uninspectable media wholesale and does not use OCR for canvas text.
- Run `non-sensitive-controls` to demonstrate that ordinary labels survive and the task remains actionable.
- Trigger one fail-closed capture/model error and show that the reasoning request count remains zero.
- Replay or alter a response `snapshotId` and show that the browser action is rejected.
- Show the measured report and its environment/run count. Describe missing cases and null metrics honestly.
- Explain that website traffic is separate from reasoning-server traffic and that the prototype is not a guarantee of universal anonymization.
