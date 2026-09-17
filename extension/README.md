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
`B63E0028667FD9E7E5DCC56EBD91E85281B8DF1498B4C3C5799DE9229305C0B1`.
Its upstream project and MIT attribution are in `models/NOTICE.md` and
`models/ULTRAFACE_LICENSE.txt`.

The release build also includes a small locked English Tesseract OCR asset at
`models/ocr/lang-data/eng.traineddata`. It is used only on image media that
would otherwise be masked in full, and only to narrow supported synthetic
payment-card/PAN/Aadhaar-style fixtures to credential or PII boxes. Restore or
verify that asset
with:

```powershell
npm run prepare:ocr
```

## Load the extension

For Chrome, open `chrome://extensions`, enable Developer mode, choose **Load
unpacked**, and select `extension/dist/chrome`.

For Firefox, open `about:debugging#/runtime/this-firefox`, choose **Load
Temporary Add-on**, and select `extension/dist/firefox/manifest.json`.

Open an HTTP(S) test page and click the extension icon. In Chrome the icon opens
the persistent side panel; in Firefox the build exposes a sidebar panel. Use
**Privacy preview** first. A task is optional for this local preview; enter one
when you are ready to run the agent. The preview never calls the reasoning
server. Check the detector state and masked image, then open the
**Sanitized DOM capsule** directly below it. This judge-facing proof panel is
generated from the same sanitized observation that would be sent to the
reasoning endpoint: it shows the sanitized task/title, origin alias, opaque
element IDs, roles, geometry, safe labels, state flags, redaction counts, and
the exact sanitized DOM JSON. It also lists the raw fields intentionally
omitted (input values, selectors, DOM references, cookies, real URL, and the
raw DOM snapshot). Use **View the sanitized DOM payload** during a demo to
make the client-side privacy boundary visible instead of relying on the image
alone. The **Open full view** action includes the same DOM capsule beside the
full-size redacted image.
The side panel stays open while the run captures, reasons, scrolls, clicks,
fills fields, waits, or stops. The Chrome build declares `<all_urls>` because
Chrome's `captureVisibleTab` API explicitly requires either `activeTab` or that
grant. This capability is used for local DOM/pixel capture only: runtime code
rejects non-HTTP(S) tabs, no page data is sent by the permission itself, and
the egress gateway still accepts only sanitized context. Firefox uses explicit
HTTP(S) host patterns for the same local capture boundary.

The default endpoint is `http://127.0.0.1:8765/v1/reason`. Non-loopback
endpoints must use HTTPS. API keys and known private values are kept in the
background/panel memory and are not saved to extension storage. The endpoint,
step count, full-mask preference, and selected privacy grade are saved locally.
The default is Grade 3 (strict). See [`../PRIVACY_LEVELS.md`](../PRIVACY_LEVELS.md)
for the complete category matrix and detector limits.

The synthetic demo page includes a privacy-spectrum gallery and comparison
fields for critical data (password, PAN, Aadhaar, and bank account), personal
data (email, phone, address, date of birth, customer ID, and IP address), and
identity data (name, username, and employee code). Run **Privacy preview** at
each grade on a fresh page to show the redaction set expanding progressively.

### Troubleshoot a blocked local preview

`Local offscreen sanitization failed; transmission blocked` is a fail-closed
local error. It means no reasoning request was sent; an API key or Ollama
response cannot cause that message. After rebuilding, remove any older
unpacked copy, load `extension/dist/chrome` with **Load unpacked**, and accept
the new all-sites permission warning. Then reload the HTTP(S) page and run
**Privacy preview**. The detector should become `wasm` or `webgpu` and the mask count
should be greater than zero. The extension's **Errors** panel contains a
bounded local category if the offscreen document, ONNX runtime, or image
decoder still fails. The optional full-mask fallback can keep a task moving,
but it deliberately sends an opaque image and is intended for diagnostics.

If the panel reports `No active browser tab`, the active tab is usually an
extension-management page, a new-tab page, a local PDF/file, or another
browser-restricted surface. Switch to `http://127.0.0.1:8765/demo` (or another
ordinary HTTP(S) page), then click **Privacy preview** again. The side panel
now checks the last-focused browser window as well as its current window so a
normal page remains discoverable when the panel owns a separate UI context.
If Chrome shows an updated host-access warning after rebuilding, accept it and
reload the extension. If the extension was loaded from an older build, remove
that unpacked copy and load `extension/dist/chrome` again so the manifest's
`<all_urls>` capture capability is applied.

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
- names, including cardholder names, use Grade 3 in both DOM and document OCR;
  dates of birth use Grades 2–3 in both paths. Repeated identity values learned
  from labelled fields retain their category, including supported date-format
  variants. These values remain local to the capture;
- changing the grade hides the old panel preview until a fresh **Privacy
  preview** is generated. An already-open expanded preview tab remains a
  snapshot of its original capture;
- the same grade-aware sanitizer processes the task, title, element labels,
  field values and raster, so lowering the grade never bypasses the invariant
  protection floor;
- UltraFace face bounding boxes are detected using WebGPU, with single-threaded
  WASM fallback on setup or first-inference failure, and are marked
  `[REDACTED:FACE]` at every grade;
- every visible iframe and unsupported embedded/media-rendered region (`img`,
  `picture`, `canvas`, `video`, `svg`, `object`, `embed`, and CSS background
  images) is covered at every grade;
- for supported synthetic PAN/payment-card/Aadhaar-style image fixtures, local
  credential OCR may replace the whole-image media mask with only PAN/card
  number/expiry/CVV or Aadhaar-style PII boxes. Payment-card captions can be
  lost when a small image is downscaled, so a page-supplied coarse card type
  hint may help associate a nearby three/four-digit token with the CVV; the
  card number, expiry, and CVV are still all required before any pixels are
  unmasked. If OCR is absent, low confidence, over budget, cannot classify the
  image, or does not cover every required credential, the complete media
  region remains masked. The local preview writes field-specific semantic
  placeholders such as `[REDACTED:CARD_NUMBER]`, `[REDACTED:EXPIRY]`,
  `[REDACTED:CVV]`, `[REDACTED:NAME]`, `[REDACTED:PHONE_NUMBER]`, and
  `[REDACTED:AADHAAR_NUMBER]`; these
  labels contain no source values; they are painted into the sanitized image
  and can therefore be visible to the reasoning server along with that image.
  OCR uses local upscaling and contrast normalization, sparse-text segmentation,
  and a single-block retry for incomplete document crops. High-confidence
  words can recover a line affected by decorative noise, but its original
  bounds are retained so uncertain value characters remain covered;
- a page can explicitly mark a known public object fixture with
  `data-privacy-media-kind="object"`; this is the only media-preservation
  hint, and ambiguous/unclassified media remains fail-closed.

If the ONNX model is missing or inference fails, transmission stops. The user
may explicitly enable the visual full-mask fallback; in that mode the entire
image becomes opaque black, the request records `visualFallback: "full-mask"`
and `redactionMode: "opaque"`, and sanitized DOM structure remains available
to the server.

## Known limits

Preview fullscreen uses the browser Fullscreen API when available. If an
extension panel rejects it, the extension opens the dedicated preview tab;
that viewer also supports a viewport-sized fallback, an Exit fullscreen
button, and Escape. After rebuilding, reload the unpacked extension and
generate a new preview: already-open preview tabs retain their previous image.

- Regex and label rules can miss unlabeled personal names, unusual identifiers,
  multilingual PII, text split across DOM nodes, closed shadow DOM, and new PII
  formats. A labeled evaluation corpus is needed before expanding claims.
- Media and frames are deliberately over-redacted except for the narrow local
  PAN/payment-card/Aadhaar OCR path and explicit public-object fixture hint.
  This protects privacy but can still remove visual context and lower task
  accuracy for unsupported media.
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
