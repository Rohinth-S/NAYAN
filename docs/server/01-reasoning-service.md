# Reasoning Service Architecture & Deployment

[← Back to Main README](../../README.md) | [System Architecture](../architecture/01-system-architecture.md)

---

## 1. Overview & Trust Model

The reasoning server is intentionally treated as an untrusted recipient. Its purpose is to validate and reason over sanitized context, not to be trusted with raw page data.

---

## 2. HTTP Routes Specification

| Route | Purpose |
| --- | --- |
| `POST /v1/reason` | Validate a sanitized observation and return an action or admit an asynchronous job. |
| `GET /v1/reason/{jobId}` | Bodyless opaque job polling. |
| `GET /health/live` | Liveness. |
| `GET /health/ready` | Readiness, provider, configuration, and ledger checks. |
| `GET /health/metrics` | Aggregate operational counters when enabled. |
| `GET /demo` | Synthetic SIH portal. |
| `POST /demo/api/reset` | Reset synthetic portal state. |
| `GET /demo/api/state` | Read synthetic portal state. |
| `POST /demo/api/submit` | Submit synthetic enrollment after required conditions. |

---

## 3. Boundary & Strict Validation

`server/app/boundary.py` enforces:

- Method and content-type rules;
- Body-size and request limits;
- API key and origin checks;
- Safe access logging;
- Security headers;
- No unsafe reasoning-path access.

`server/app/schemas.py` uses strict Pydantic models with unknown fields forbidden. `server/app/validation.py` performs defense-in-depth checks on:

- Base64 and PNG structure;
- Image dimensions, size, and pixel limits;
- Redaction count and bounds;
- Forbidden metadata and animation characteristics;
- Semantic placeholder pixels or verified opaque fallback pixels;
- Invariant-floor text and canary absence;
- Safe element roles, IDs, bounds, and states;
- Privacy grade and registry digest.

---

## 4. Configuration Profiles

Important server settings include:

- API key and required-authentication mode;
- Explicit CORS origin allowlist;
- Ollama URL, model, optional immutable digest, timeout, and remote opt-in;
- Provider-neutral gateway URL and API key;
- Request/image/pixel/element/redaction limits;
- Maximum jobs and concurrent model calls;
- Model admission timeout and job TTL;
- Rate-limit window and request count;
- Metrics and log level;
- Development or production deployment profile;
- Redis URL and optional metadata-only SQLite ledger path;
- Structural planner fallback.

### Production vs. Development Profiles

The production profile requires:
- A strong API key;
- A pinned model digest;
- A reachable Redis URL;
- Structural fallback disabled.

Development can use loopback, the in-memory job store, optional SQLite metadata, and the structural planner.

---

## 5. Ollama & Model Adapters

`server/app/gateways/ollama.py`:

- Checks the configured model manifest/digest when one is required;
- Uses `qwen3-vl:2b-instruct` by default;
- Resizes the already-sanitized image to configured model limits;
- Sends only sanitized context and image;
- Uses a defensive prompt;
- Requests strict JSON output;
- Bounds response size and timeout;
- Validates the returned action against the strict response model.

`gateway_adapter.py` and `model_adapter.py` define a provider-neutral sanitized adapter for a hosted or air-gapped deployment. The adapter accepts only `SanitizedObservation` and returns only the allowlisted action schema.

The current local setup uses Ollama on `127.0.0.1:11434`. The current development evidence does not record a pinned model digest, so it must not be described as a production-pinned model release.

---

## 6. Jobs, Ledger, Circuit Breaker, and Fallback Infrastructure

- `jobs.py` bounds asynchronous jobs, concurrency, admission time, TTL, completion, failure, cancellation, and shutdown.
- `job_ledger.py` provides an in-memory development path, metadata-only SQLite restart ledger, and Redis ledger. Raw observations are not stored in the ledger.
- `rate_limit.py` provides a process-local development limiter and an atomic Lua Redis sliding-window limiter for multi-instance deployments.
- `circuit_breaker.py` implements Closed/Open/Half-Open model admission.
- `structural_planner.py` handles only unambiguous schema-valid tasks in development and never infers private values.
- `action_guard.py` checks action/observation consistency and consent/submit prerequisites.
- `observability.py` records aggregate counters and timings without page content, raw URLs, request bodies, keys, or private labels.

---

## 7. Container Baseline & Docker Compose Hardening

`docker-compose.yml` includes:

- FastAPI server;
- Redis;
- Nginx reverse proxy;
- Dropped Linux capabilities;
- Read-only server/Redis roots with required temporary storage;
- CPU and memory limits;
- A dedicated model network;
- Persistent Redis data volume.

This is a hardened baseline. Public production still requires TLS certificates, secret management, key rotation, multi-instance failover evidence, image/dependency provenance, and independent review.
