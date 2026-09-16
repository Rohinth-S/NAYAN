# SIH Privacy Reasoning Server

This FastAPI service is the remote side of the SIH26171 prototype. It accepts only the frozen
`SanitizedObservation` v1.0 contract, sends the sanitized structure and freshly encoded PNG to a configured
Ollama model, validates the returned action against the current snapshot, and returns one action.

The service never needs browser cookies, raw HTML, raw form values, a secret map, CDP access, or an original
screenshot. Unknown request fields are rejected. Request and response content is not logged.

The boundary applies a per-client sliding-window limit (`PRIVACY_AGENT_RATE_LIMIT_REQUESTS`, default 120 per
minute) before parsing a reasoning body. `GET /health/metrics` exposes aggregate counters only; it never includes
snapshots, labels, URLs, request bodies, or job IDs. The in-memory job store and process-local limiter are the
development profile. Set `PRIVACY_AGENT_REDIS_URL` to activate the shared Redis job ledger and atomic limiter;
production startup requires that backend, a pinned model digest, authentication, and HTTPS termination as described
in `RELEASE_CHECKLIST.md` and `TEAM_WORK_SPLIT.md`.

## Local setup

The project-wide Ollama helper keeps a portable model directory under the ignored
`.runtime` folder when a system Ollama installation is not available. Start it
from the project root and confirm the configured model is installed:

```powershell
.\Start-LocalOllama.ps1
ollama list
```

Create an isolated server environment with the bundled `uv` executable:

```powershell
cd server
..\.tools\uv\uv.exe venv .venv --python 3.12
..\.tools\uv\uv.exe pip install --python .venv\Scripts\python.exe -e ".[test]"
```

Configure a shared demo key and exact browser origins in the process environment. Do not commit the real key:

```powershell
$env:PRIVACY_AGENT_API_KEY = "replace-with-at-least-16-random-characters"
$env:PRIVACY_AGENT_REQUIRE_API_KEY = "true"
$env:PRIVACY_AGENT_CORS_ORIGINS = "http://localhost,http://127.0.0.1"
$env:PRIVACY_AGENT_OLLAMA_MODEL = "qwen3-vl:2b-instruct"
.\.venv\Scripts\uvicorn.exe app.main:app --host 127.0.0.1 --port 8765 --no-access-log --no-proxy-headers
```

Open `http://127.0.0.1:8765/demo`. The page contains fictional test PII in visible text, a password input, a
DOM attribute, a link URL, and a synthetic face. The extension should show all corresponding masks before it
enables **Send sanitized context**.

Health endpoints:

- `GET /health/live` confirms that the HTTP process is alive.
- `GET /health/ready` returns 200 only when the exact configured Ollama model appears in `/api/tags`.

Pulling Ollama models or container images requires at least 10 GB free on `/`.
Run `python scripts/check-disk-budget.py` first; do not pull when the gate fails.

With the server running, exercise the full HTTP boundary and real Ollama model using synthetic data:

```powershell
.\.venv\Scripts\python.exe scripts\live_smoke.py
```

The demo has deterministic verification endpoints:

- `POST /demo/api/reset`
- `GET /demo/api/state`
- `POST /demo/api/submit` with `{"consent": true}`

They retain only completion state, request counts, a snapshot hash prefix, redaction count, and action type.

## Wire contract

`POST /v1/reason` requires `Content-Type: application/json` and, when configured, the
`X-Privacy-Agent-Key` header. The extension adds `Prefer: respond-async`; the server returns a small `202`
ticket and performs slow Ollama inference in a bounded local job. `GET /v1/reason/{jobId}` returns the same
pending ticket or the completed action. `Prefer: wait=10` enables a bounded long poll that returns as soon as the
job changes. Only the initial POST carries the observation, while every poll enforces
the same authentication and Origin policy. A POST without the preference remains synchronously compatible.
The request uses the exact camelCase v1.0 schema shared with the extension:

```json
{
  "schemaVersion": "1.0",
  "snapshotId": "11111111-1111-4111-8111-111111111111",
  "documentId": "22222222-2222-4222-8222-222222222222",
  "page": {"origin": "https://site-0123456789abcdef0123.invalid", "title": "Benefits portal"},
  "task": "Confirm and submit the selection",
  "elements": [
    {
      "id": "e_submit_12345678901",
      "role": "button",
      "label": "Submit",
      "bounds": {"x": 10, "y": 20, "width": 100, "height": 32},
      "state": {"disabled": false, "checked": false, "editable": false, "required": false}
    }
  ],
  "image": {"mime": "image/png", "dataBase64": "...", "width": 1280, "height": 720},
  "redactions": [],
  "privacy": {"detectorBackend": "webgpu", "visualFallback": "none", "rawImageRetained": false, "redactionMode": "semantic", "grade": 3}
}
```

The response contains one revision-bound action. `state.required` is structural metadata; the server also accepts
older clients that omit it and defaults it to `false`.

`privacy.grade` is the user's cumulative local disclosure policy: `1` protects only the essential high-impact
categories, `2` additionally protects direct contact/location identifiers, and `3` additionally protects names,
usernames, employee identifiers, and ambiguous populated fields. Omission is fail-safe and defaults to `3`; invalid
values are rejected. At every grade the invariant floor remains active for passwords, passphrases, PINs, OTPs,
recovery answers, API/access/session tokens, private keys, Aadhaar/PAN/passport and other government IDs, payment
cards and detected financial credentials, faces/biometrics, known canaries, and uninspectable visual regions. Grade 1
may intentionally retain names and contact context so a workflow can use them. The extension performs this
classification before encoding; the server's grade-aware text scan is defense in depth and never reconstructs a
redacted value. `privacy.registryDigest` is optional in v1: a present value must match the compiled registry, and an
absent value keeps the invariant-floor scan.

An asynchronous acceptance contains exactly `schemaVersion`, `snapshotId`, a random UUIDv4 `jobId`, and
`status: "pending"`. The in-memory local queue retains at most 16 jobs, runs two model calls concurrently, and
expires entries after five minutes by default. The included launcher runs one API process. A replicated deployment
must replace this local queue with a shared protected job store or use sticky routing.

```json
{
  "schemaVersion": "1.0",
  "snapshotId": "11111111-1111-4111-8111-111111111111",
  "action": {"type": "click", "elementId": "e_submit_12345678901"}
}
```

Allowed action shapes are:

- `click`: `elementId`
- `input`: `elementId`, `text`
- `scroll`: `direction` (`up` or `down`), `amount` (1–5000), and an optional scroll-region `elementId`
- `wait`: `milliseconds` (100–5000)
- `done`: optional `message`

All other action fields are forbidden. An element target must exist in the same observation, disabled targets
are rejected, and input targets must be marked editable. The extension must independently check the returned
snapshot and current document revision immediately before execution.

## Boundary checks

Before Ollama receives a request, the server verifies:

- configured authentication and browser origin;
- body, decoded-image, pixel, element, and redaction limits;
- exact request fields, ID alphabets, field lengths, and a session-keyed opaque `site-<id>.invalid` origin alias;
- PNG signature, chunk structure, decoded dimensions, single-frame content, and absence of text/EXIF/ICC chunks;
- semantic mode verifies that every declared redaction rectangle contains the
  neutral placeholder background used by the local compositor; opaque fallback
  verifies entirely black pixels;
- `full-mask` fallback includes a full-frame redaction and an entirely opaque black image;
- grade-aware high-confidence patterns are absent from forwarded text: all grades reject PAN, Aadhaar, passports,
  cards, labeled bank-account numbers, OTPs, and common authentication-token forms; Grades 2 and 3 also reject
  email, Indian phone, address, date-of-birth, IP, and labeled customer/account identifiers; Grade 3 also rejects
  labeled names and employee/user identifiers.

The obvious-PII scan is a defense in depth check after the request reaches this process. Privacy still depends on
the extension detecting and removing sensitive text and pixels *before* network transmission. This prototype
does not prove universal anonymization, recognize every face or identity, inspect encrypted browser traffic, or
prevent a compromised extension/runtime from bypassing the gateway.
Medical/health text and every possible bank, UPI, or official-ID format are also outside the current high-confidence
server rule set; protect those workflows with Grade 3 plus local known-private values until a dedicated detector is
evaluated.

## Tests

```powershell
cd server
.\.venv\Scripts\pytest.exe
.\.venv\Scripts\ruff.exe check .
```

The suite covers strict request/response contracts, authenticated asynchronous jobs, long-poll and queue/expiry limits, origin and body limits, malformed and
metadata-bearing images, opaque-mask verification, full-mask fallback, prompt injection containment, stale and
invalid model actions, safe logs, the exact serialized receiver body, Ollama structured output, and deterministic
demo state.

## Container

```powershell
docker build -t sih-privacy-server server
docker run --rm -p 8765:8765 --env-file server/.env sih-privacy-server
```

The container enables `PRIVACY_AGENT_REQUIRE_API_KEY=true` by default and fails closed if no strong key is supplied.
When Ollama runs on the Windows host, set `PRIVACY_AGENT_OLLAMA_BASE_URL=http://host.docker.internal:11434` and
`PRIVACY_AGENT_ALLOW_REMOTE_OLLAMA=true` inside the container. Bind Ollama only to a trusted interface; the
reasoning server's API key does not authenticate the Ollama API itself. The synchronous compatibility endpoint
shares the same bounded model-admission gate as asynchronous jobs and returns a controlled capacity error when the
gate remains full beyond `PRIVACY_AGENT_REASONING_ADMISSION_TIMEOUT_SECONDS`.
