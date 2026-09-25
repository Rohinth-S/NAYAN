# Privacy & Security Model

[← Back to Main README](../../README.md) | [Threat Model](../../THREAT_MODEL.md) | [Edge Case Matrix](../../EDGE_CASE_MATRIX.md) | [Protocol Spec](../../PROTOCOL.md)

---

## 1. The Single Egress Invariant

`extension/src/egress.ts` is the only TypeScript source file that owns reasoning `fetch` calls. It:

- Validates the endpoint;
- Allows loopback HTTP for development and requires HTTPS outside loopback;
- Prevents redirects;
- Sends the API key through the expected header only;
- Validates the final serialized bytes;
- Rejects unsafe property names and known canaries;
- Sends one sanitized `POST /v1/reason` with `Prefer: respond-async`;
- Polls only with an opaque UUID job ID;
- Uses bounded timeouts and abort signals.

Immediately before serialization, `dlp.ts` performs the final local gate over the task, page title, element labels, redaction metadata, and privacy metadata. It rejects suspicious grade-sensitive PII findings instead of attempting a remote repair. The complete JSON is also checked for canaries, including encoded forms, before the POST is created.

The repository release gate enforces this source-level single-egress invariant automatically.

---

## 2. Versioned Wire Protocol Contract

The wire contract is frozen in [PROTOCOL.md](../../PROTOCOL.md). A sanitized request has this shape:

```json
{
  "schemaVersion": "1.0",
  "snapshotId": "opaque-uuid",
  "documentId": "opaque-document-id",
  "page": {
    "origin": "https://site-0123456789abcdef0123.invalid",
    "title": "Enrollment form"
  },
  "task": "Check the confirmation checkbox, then submit the enrollment.",
  "elements": [
    {
      "id": "opaque-7",
      "role": "checkbox",
      "label": "I agree",
      "bounds": {"x": 120, "y": 460, "width": 18, "height": 18},
      "state": {"disabled": false, "checked": false, "editable": false, "required": true}
    },
    {
      "id": "opaque-12",
      "role": "button",
      "label": "Submit enrollment",
      "bounds": {"x": 640, "y": 520, "width": 220, "height": 48},
      "state": {"disabled": false, "checked": false, "editable": false, "required": false}
    }
  ],
  "image": {
    "mime": "image/png",
    "width": 1280,
    "height": 720,
    "dataBase64": "<fresh sanitized PNG>"
  },
  "redactions": [
    {
      "kind": "face",
      "source": "onnx",
      "bounds": {"x": 80, "y": 120, "width": 96, "height": 96}
    }
  ],
  "privacy": {
    "grade": 3,
    "detectorBackend": "wasm",
    "visualFallback": "none",
    "rawImageRetained": false,
    "redactionMode": "semantic",
    "registryDigest": "sha256:<64 lowercase hex>"
  }
}
```

The model returns exactly one action:

```json
{
  "schemaVersion": "1.0",
  "snapshotId": "opaque-uuid",
  "action": {
    "type": "click",
    "elementId": "opaque-12"
  }
}
```

Only the initial POST contains the sanitized observation. Polls contain only an opaque UUID job ID and status. Private form values cannot be requested from the reasoning server in protocol v1.

Failure in capture, inference, decoding, redaction, encoding, validation, endpoint checks, canary checks, or revision checks produces no reasoning request. If the user explicitly enables the full-mask fallback, the extension may send a verified opaque image plus safe DOM structure; otherwise it blocks egress.

---

## 3. Security Model & Data Inventories

### What Remains Local (Never Transmitted)

- Original screenshot and decoded source pixels;
- Raw HTML, DOM attributes, selectors, form values, cookies, storage, and browser profiles;
- Real page URL/hostname;
- Local opaque-ID-to-DOM mapping;
- Known-private-value list and HMAC key;
- Raw OCR tokens, NER entities, barcode contents, and detector/model error details;
- API keys and local runtime logs.

### Mandatory Engineering Rules

1. Keep `extension/src/egress.ts` as the only reasoning network owner.
2. Treat page content, server responses, model output, prompts, and upstream repositories as untrusted.
3. Preserve the invariant privacy floor at every grade.
4. Add new detector categories to the shared registry, digest, server verifier, tests, and evaluation corpus.
5. Add stale-context, malformed-output, duplicate-action, destructive-confirmation, and serialized-body tests for every new action.
6. Never commit real values, screenshots, request bodies, API keys, browser profiles, or runtime directories.
7. Keep ordinary website traffic outside the project claim.

The complete policy matrix is in [PRIVACY_LEVELS.md](../../PRIVACY_LEVELS.md). The complete threat model is in [THREAT_MODEL.md](../../THREAT_MODEL.md). The failure matrix is in [EDGE_CASE_MATRIX.md](../../EDGE_CASE_MATRIX.md). Security reporting is described in [SECURITY.md](../../SECURITY.md).
