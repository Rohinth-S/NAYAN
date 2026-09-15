# SIH26171 private browser-agent extension

This directory builds one TypeScript codebase into a Chrome Manifest V3
extension and a Firefox-compatible Manifest V2 extension. It captures the
active visible tab, finds sensitive DOM/text regions locally, runs the bundled
UltraFace ONNX detector locally, draws italic category-only placeholders into a
fresh PNG, and sends only the validated `SanitizedObservation` to a reasoning
server.

This is a production-oriented hackathon prototype, not a guarantee of complete
anonymization. The current detector coverage and limits are listed below.

## Build and test

Prerequisites: Node.js 20 or newer.

```powershell
cd <repo>\extension
npm install
npm run check
```

`npm run check` type-checks, runs the unit and privacy-boundary tests, builds
both browsers, and creates:

- `artifacts/sih-private-agent-chrome-0.1.0.zip`
- `artifacts/sih-private-agent-firefox-0.1.0.zip`

The release build includes `models/version-RFB-320.onnx` when it is present.
The reviewed model in this workspace has SHA-256
`34CD7E60AEFF28744C657DE7A3DC64E872D506741DE66987F3426F2B79F88017`.
Its upstream project and MIT attribution are in `models/NOTICE.md` and
`models/ULTRAFACE_LICENSE.txt`.

## Load the extension

For Chrome, open `chrome://extensions`, enable Developer mode, choose **Load
unpacked**, and select `extension/dist/chrome`.

For Firefox, open `about:debugging#/runtime/this-firefox`, choose **Load
Temporary Add-on**, and select `extension/dist/firefox/manifest.json`.

Open an HTTP(S) test page, click the extension icon, enter a task, and choose
**Privacy preview** first. The preview never calls the reasoning server. Check
the detector state and masked image, then choose **Start agent**. The browser
will ask for access to the configured reasoning-server origin. Endpoint access
is optional and granted per origin; page access uses `activeTab` after the user
opens the extension.

The default endpoint is `http://127.0.0.1:8765/v1/reason`. Non-loopback
endpoints must use HTTPS. API keys and known private values are kept in the
background/popup memory and are not saved to extension storage. The endpoint,
step count, full-mask preference, and selected privacy grade are saved locally.
The default is Grade 3 (strict). See [`../PRIVACY_LEVELS.md`](../PRIVACY_LEVELS.md)
for the complete category matrix and detector limits.

## Privacy boundary

The only explicit reasoning-server network call in extension source is
`sendSanitizedObservation` in `src/egress.ts`. Immediately before that call it:

1. validates the exact versioned request schema and rejects unknown fields;
2. rejects raw-content keys such as HTML, values, cookies, storage, or raw
   screenshots;
3. searches the final serialized body for raw, URL-encoded, and base64 forms of
   operator-provided privacy canaries;
4. submits the sanitized body once, uses bounded 10-second long polls carrying
   only a random UUID job ID, uses
   no cookies, no referrer, no redirects, a 100-second total deadline, and an
   optional request key.

The content script is injected only into the active tab after a user gesture.
It creates new random element IDs for each snapshot. The mapping between those
IDs and live DOM elements never leaves the content script. A returned action is
accepted only when its schema version, snapshot ID, document ID, DOM revision,
tab origin, and target ID still match. The action allowlist is `click`, `input`,
`scroll`, `wait`, and `done`; each type rejects irrelevant fields.

The v1 request body is:

```json
{
  "schemaVersion": "1.0",
  "snapshotId": "random UUID",
  "documentId": "local document UUID",
  "page": { "origin": "https://site-a1b2c3d4e5f60718293a.invalid", "title": "sanitized" },
  "task": "sanitized",
  "elements": [
    {
      "id": "e_opaqueRandomId",
      "role": "button",
      "label": "Submit",
      "bounds": { "x": 10, "y": 20, "width": 80, "height": 30 },
      "state": { "disabled": false, "checked": false, "editable": false, "required": false }
    }
  ],
  "image": { "mime": "image/png", "dataBase64": "...", "width": 1280, "height": 720 },
  "redactions": [
    { "kind": "pii-text", "source": "regex", "bounds": { "x": 1, "y": 2, "width": 3, "height": 4 } }
  ],
      "privacy": { "grade": 3, "detectorBackend": "webgpu", "visualFallback": "none", "rawImageRetained": false, "redactionMode": "semantic" }
}
```

The normal raster mode replaces each sensitive rectangle with a neutral card and
an italic category marker such as `[REDACTED:EMAIL]`, `[REDACTED:PASSWORD]`,
or `[REDACTED:FACE]`. The marker contains no source value. When the local
detector is unavailable and the user explicitly enables fallback, the raster
uses `redactionMode: "opaque"` and is entirely black.

The response is exactly `{schemaVersion, snapshotId, action}`. The server must
echo the current snapshot ID and return one allowlisted action. The structural
`state.required` flag contains no field value; older clients may omit it and
the server defaults it to `false`.

The real page origin is used locally for tab and action checks. The outbound
`page.origin` is a keyed, session-scoped `.invalid` alias, so the server does
not receive the visited hostname. The alias key is non-exportable and stays in
background memory.

## Current detection behavior

The extension applies the selected cumulative grade before encoding a new PNG:

- Grade 1 always protects passwords, authentication secrets, government and
  financial identifiers, faces, caller-provided known values, and all
  uninspectable frames/media;
- Grade 2 additionally protects email, phone, address/location, date of birth,
  IP/network and detected customer/account identifiers;
- Grade 3 additionally protects names, usernames, employee identifiers and
  unknown populated editable fields;
- the same grade-aware sanitizer processes the task, title, element labels,
  field values and raster, so lowering the grade never bypasses the invariant
  protection floor;
- UltraFace face bounding boxes are detected using WebGPU, with single-threaded
  WASM fallback, and are marked `[REDACTED:FACE]` at every grade;
- every visible iframe and embedded/media-rendered region (`img`, `picture`,
  `canvas`, `video`, `svg`, `object`, `embed`, and CSS background images) is
  covered at every grade because the current prototype cannot inspect its
  pixels with local OCR.

If the ONNX model is missing or inference fails, transmission stops. The user
may explicitly enable the visual full-mask fallback; in that mode the entire
image becomes opaque black, the request records `visualFallback: "full-mask"`
and `redactionMode: "opaque"`, and sanitized DOM structure remains available
to the server.

## Known limits

- Regex and label rules can miss unlabeled personal names, unusual identifiers,
  multilingual PII, text split across DOM nodes, closed shadow DOM, and new PII
  formats. A labeled evaluation corpus is needed before expanding claims.
- Media and frames are deliberately over-redacted until a bundled local OCR and
  broader visual model are evaluated. This protects privacy but removes visual
  context and can lower task accuracy.
- UltraFace detects faces only. It is not OCR, document classification, or
  general visual understanding.
- Only the visible viewport is captured. Navigation is not in the action
  protocol, and a navigation can revoke `activeTab` access.
- The extension controls traffic to the configured reasoning endpoint. Normal
  website requests, form submissions, downloads, and third-party page scripts
  are outside this privacy boundary.
- Browser extensions and the reasoning service still require a security review,
  signed release process, dependency review, and adversarial testing before use
  with real sensitive data.
- Chrome keeps image decoding, ONNX, redaction, and PNG encoding in an offscreen
  document. Reasoning uses short service-worker submit/poll requests and a
  bounded extension-API heartbeat, so a cold Ollama call does not depend on one
  fetch remaining open beyond Chrome's MV3 limit.
