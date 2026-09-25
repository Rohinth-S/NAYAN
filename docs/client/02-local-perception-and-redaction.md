# Local Perception, Privacy Policies & Image Redaction

[← Back to Main README](../../README.md) | [Extension & UI Overview](./01-extension-and-ui.md) | [Privacy Levels](../../PRIVACY_LEVELS.md)

---

## 1. Local Privacy Policy & Cumulative Grades

The shared detector registry defines the minimum grade at which a category is hidden. The policy is cumulative:

- **Grade 1 — Essential:** Protect high-impact or irreversible information.
- **Grade 2 — Balanced:** Additionally protect direct contact and linkable context.
- **Grade 3 — Strict:** Additionally protect identity labels and unknown populated fields.

Missing or invalid settings normalize to Grade 3. A newly added detector category defaults to `unknown-populated-field`, which fails closed at Grade 3 until policy governance assigns it explicitly.

**Names and dates of birth follow the same policy across form fields, labelled profile text, repeated known identity values, and supported document OCR.** Names (including cardholder names) are hidden at Grade 3; dates of birth are hidden at Grades 2 and 3. The document type does not change those thresholds. Values learned from labelled fields remain capture-local. OCR must locate every field required by the selected grade before replacing a full document mask with selective boxes. Changing the grade hides the old panel preview; click **Privacy preview** to generate a fresh capture under the new policy. Existing expanded preview tabs are snapshots of their original capture.

The invariant floor applies at every grade:

- Credentials and secrets;
- Passwords, OTPs, PINs, CVVs, bearer/API/private-key tokens;
- Government identifiers;
- Financial/payment data;
- Faces and biometric regions;
- User-declared known-private values;
- Visual regions the client cannot inspect reliably.

### Policy Disclosure Matrix

| Category | Grade 1 | Grade 2 | Grade 3 |
| --- | :---: | :---: | :---: |
| Credentials, secrets, government IDs, financial data, faces | hide | hide | hide |
| Known private values and unsupported/uninspectable media | hide | hide | hide |
| Email, phone, address/location, date of birth, network/device IDs, account IDs | keep when safe | hide | hide |
| Names, usernames, professional/employee identifiers | keep when safe | keep when safe | hide |
| Unknown populated editable fields | keep only when classified safe | keep only when classified safe | hide |

`privacy.ts` applies deterministic DOM and field metadata rules, regex patterns for Indian and general identifiers, exact known-value matching, Unicode/whitespace normalization, and category mapping. `privacy-policy.ts` consumes the generated registry and digest. [PRIVACY_LEVELS.md](../../PRIVACY_LEVELS.md) contains the complete policy contract.

---

## 2. Local Visual Detection Engine

The client uses an asset-gated unified detector interface.

### Default Checked-in Path: UltraFace

`extension/models/version-RFB-320.onnx` is checked in with attribution and license files. `face-detector.ts` invokes it through ONNX Runtime Web:

1. Try WebGPU;
2. Fall back to WASM;
3. Return a typed failure if neither backend is available.

The reviewed model SHA-256 is:

```text
B63E0028667FD9E7E5DCC56EBD91E85281B8DF1498B4C3C5799DE9229305C0B1
```

### Optional Approach B Path: Unified YOLO

`yolo-detector.ts` implements:

- 640-pixel letterbox preprocessing;
- YOLOv8 output transpose and NMS;
- YOLOv10 end-to-end output decoding;
- Face, Aadhaar card, PAN card, voter ID, driving licence, passport, and signature classes;
- WebGPU-first and WASM fallback execution;
- Asset-gated selection through `__YOLO_MODEL_INCLUDED__`.

The default repository package does **not** contain `yolo-privacy-v1.onnx`; therefore the default build reports the UltraFace path and does not claim trained document-ID coverage or YOLO performance. To activate YOLO, the team must supply an approved asset with license, checksum, provenance, and held-out evaluation.

---

## 3. Redaction and Fresh-Image Construction

`image-redactor.ts`:

- Maps DOM and visual boxes into screenshot pixels;
- Clips invalid or out-of-bounds rectangles;
- Merges overlapping masks;
- Draws neutral category-only markers such as `[REDACTED:EMAIL]`, `[REDACTED:PASSWORD]`, or `[REDACTED:FACE]`;
- Computes category counts and masked-area percentage;
- Creates a new PNG from a new canvas;
- Can produce a fully opaque image only when the user explicitly enables the full-mask fallback;
- Never treats a visual overlay on the original screenshot as a valid outbound artifact;
- Does not expose the original screenshot in `SanitizedObservation`.

---

## 4. High-Assurance Structure-Only Mode

The Advanced privacy controls include **High-assurance structure-only mode**.
When selected, the local pipeline still captures the page to obtain viewport dimensions and the safe DOM capsule, but it skips visual detection, OCR, NER, and barcode interpretation for that capture. It creates a fresh all-black PNG and sends only that opaque image plus sanitized roles, labels, bounds, and state. The wire metadata reports `detectorBackend: "missing"`, `visualFallback: "full-mask"`, and `redactionMode: "opaque"`, so the server cannot mistake the image for a semantic screenshot.

Every preview and accepted reasoning request also exposes a local outbound privacy receipt. It contains only the selected grade, detector backend, redaction category counts, masked-area percentage, a SHA-256 hash of the sanitized PNG, request count, transmission mode, and whether the request was accepted. Raw values and the original screenshot are never shown in the receipt.

---

## 5. Canvas, Frames, and Media Privacy

Canvas-rendered applications are difficult because text pixels may not exist in the DOM. `canvas-privacy.ts` defines a three-tier strategy:

1. **Visual redaction:** Normal inspectable visual-object redaction.
2. **DBNet blind masking:** Optional DBNet text-region detection without OCR or content retention.
3. **Manual escalation:** Require user review when safe local classification is unavailable.

The default live path conservatively masks inspectability-uncertain media and frames. A narrow local document-OCR pass runs only on image media that would otherwise be fully masked. If it confidently recognizes a supported PAN, payment-card, or Aadhaar-style fixture, the full media mask is replaced with credential/PII boxes; a local coarse card hint can help recover a small CVV token when its caption is lost during downscaling, but card number, expiry, and CVV coverage are still required together. The local preview renders category-specific placeholders such as `[REDACTED:CARD_NUMBER]`, `[REDACTED:EXPIRY]`, `[REDACTED:CVV]`, `[REDACTED:NAME]`, `[REDACTED:PHONE_NUMBER]`, and `[REDACTED:AADHAAR_NUMBER]`, while raw OCR text is discarded. If OCR is absent, low confidence, over budget, or cannot classify the image, the full media mask remains. A page may explicitly mark a known public object with `data-privacy-media-kind="object"`; only that opt-in fixture path is preserved, while unknown media remains fail-closed. `dbnet-detector.ts` is implemented, but `dbnet-text-det.onnx` is not in the default package. The repository therefore does not claim DBNet coverage until the asset and explicit runtime wiring are supplied.

The document preview uses locally upscaled, contrast-normalized OCR crops with sparse-text segmentation and a single-block retry when required fields are missing. Fullscreen uses a dedicated preview tab and a viewport-sized fallback when the browser rejects native fullscreen; Escape exits the expanded view. Rebuild and reload the extension before generating a new preview.

---

## 6. Local Credential OCR for Image Media

The default package includes an explicitly locked local bundle. The build verifies `extension/models/ocr/lang-data/eng.traineddata` against `extension/models/ocr-lock.json`; set `LOCAL_OCR=0` only for a constrained package that intentionally omits this path. `document-ocr.ts` uses Tesseract.js locally on cropped media boxes and emits only:

- A document class: `credit-card`, `pan-card`, or `aadhaar-card`;
- Credential/PII boxes for payment card number, expiry/CVV, PAN identifier, Aadhaar number, name, date of birth, gender, mobile, and address;
- Confidence and bounds.

Raw OCR text is transient local data and is discarded before observation construction. The server receives semantic redaction records such as `source: "ocr"` and the freshly redacted PNG, not the OCR text. This deliberately does not claim generic document understanding; unsupported image media remains covered by `uninspectable-media`. The public-object fixture is a separate explicit page hint, not a generic “images are safe” rule.

---

## 7. Optional Local Perception Bundle

The opt-in bundle is implemented in `perception.ts` and `perception-runtime.ts`:

- Tesseract.js OCR for English and Hindi;
- Transformers.js multilingual NER using a locked local ONNX model;
- ZXing QR/barcode bounds;
- Regex and known-value classification;
- Confidence thresholds that convert uncertain results to `uninspectable`;
- Strict pixel, text, character, and time budgets;
- Cleanup after every capture.

The raw OCR text, NER entities, and decoded barcode values are transient local data. They are never sent, logged, or included in evidence.

Build it only after local perception assets have passed the lock-file checks and the team has reviewed the local evaluation report:

```powershell
Push-Location extension
$env:LOCAL_PERCEPTION_EVALUATED = "1"
npm run package:perception
Pop-Location
```

The build refuses `--perception` without `LOCAL_PERCEPTION_EVALUATED=1`. This is an admission acknowledgement, not a fabricated score: the report must still be reviewed for corpus limits, latency, and browser coverage. If an asset is absent, corrupt, over budget, low confidence, or returns invalid bounds, local perception fails with a generic error and egress is blocked. `evidence/local-perception.json` records real local measurements on a small synthetic corpus; those measurements are not universal recall/precision results.
