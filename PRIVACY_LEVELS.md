# Privacy grades and classification policy

This document defines the client-side privacy policy used by the SIH26171 prototype. The grades are cumulative: a higher grade includes every protection in the lower grades. **Grade 3 is the default.** Selecting a lower grade is an explicit choice to give the reasoning model more context.

The local detector assigns a category; a deterministic policy then decides whether that category must be redacted at the selected grade. A model or website can propose a category, but it cannot lower the category or override an always-protected decision. Conflicting detections use the most protective result.

## Non-downgradable protection at every grade

The following classes are always redacted when detected. The user cannot make them shareable by choosing a lower grade:

| Class | Examples | Current local signal |
| --- | --- | --- |
| Credentials and authentication secrets | Passwords, passphrases, PINs, OTP/MFA and recovery codes, API keys, bearer/access/refresh tokens, session secrets, private keys | Password input type, autocomplete and field metadata; high-confidence secret labels/patterns; user-declared values |
| Government identifiers | Aadhaar, PAN, passport numbers; future voter, driving-licence and tax identifiers | Regex plus DOM labels for Aadhaar, PAN and prefixed passport values; other formats remain a documented detector gap |
| Financial and payment secrets | Card numbers, CVV, bank account details, UPI and IFSC identifiers | Card regex and financial field labels; precise account/UPI/IFSC coverage is partial in v1 |
| Faces and biometrics | A visible face, signature or biometric template | Bundled UltraFace ONNX for faces; signatures and other biometrics remain detector gaps |
| Special-category records | Medical/genetic records and similarly high-impact private records | Only explicit field metadata or user-declared values in v1; general classification is a gap |
| User-declared private values | Any value entered under **Known private values** | Exact, case-insensitive local matching; values never become part of the policy sent to the server |
| Uninspectable or unknown visual regions | Cross-origin frames, canvas/video, embedded objects, image text, CSS-generated content or a failed visual detector | Conservative DOM/media classification and full-mask fallback |

Unknown content is not treated as low sensitivity. If the client cannot establish that a region is safe with the available detector, it masks that region at every grade.

## Grade 1 — Essential / Personalized

Grade 1 redacts the non-downgradable classes above and intentionally preserves more personal context for tasks where personalization is useful.

Information that **may remain visible** at Grade 1 includes:

- a person's name, username or public handle;
- email address and telephone number;
- postal address, birth date, IP address and ordinary location context;
- employer, job title, school, employee/customer identifier and other profile associations;
- ordinary populated form fields that are not classified into an always-protected class.

Grade 1 is suitable only when the user accepts that this contextual data may reach the configured reasoning server. Passwords, secrets, faces, government IDs, payment data, custom private values and unknown visual content remain protected.

## Grade 2 — Balanced / Protected

Grade 2 includes Grade 1 protections and additionally redacts direct contact and linkable context:

- email addresses and telephone numbers;
- street/postal addresses and precise location signals;
- dates of birth;
- IPv4 and, when supported, IPv6, MAC, IMEI, advertising and device identifiers;
- non-financial customer, membership and account identifiers;
- contact/autocomplete fields even when their current value is not separately recognized.

Names, public usernames, employer/job information, employee identifiers and ordinary populated fields may remain visible. This grade supports tasks that need to address a person by name while hiding how to contact or precisely identify that person.

## Grade 3 — Maximum / Strict (default)

Grade 3 includes Grades 1 and 2 and additionally redacts broad identity and ambiguous user-provided context:

- personal names, usernames and handles;
- employee, student and internal organization identifiers;
- age and other detected demographic/profile associations;
- organization-to-person associations when classified as personal;
- every populated editable field whose category cannot be established confidently;
- ambiguous values next to sensitive identity labels.

Public interface text, button labels and the page structure remain available after sanitization so the agent can still act. Grade 3 does not simply black out the whole page; it minimizes personal context while retaining actionable structure.

## Decision sequence

For every screenshot step, the client applies the following sequence locally:

1. Read structural DOM signals without adding field values to the outbound element list.
2. Run high-confidence text patterns and exact user-declared-value matching.
3. Run the bundled ONNX face detector through WebGPU or WASM.
4. Assign each finding to an always-protected, Grade 2 or Grade 3 policy class.
5. Apply the selected grade and merge overlapping protected rectangles.
6. Replace protected pixels with category-only semantic cards in a fresh PNG.
7. Apply the same grade-aware text sanitizer to the task, page title and element labels.
8. Validate the exact serialized request and allow the single reasoning egress only if all checks pass.

The request contains the numeric `privacy.grade` so the server can enforce the same versioned policy and understand why some context is intentionally visible. It never receives the original values, detector input, user-declared private-value list or ID-to-DOM mapping.

## Current coverage and limits

The current release directly recognizes email, Indian phone numbers, Aadhaar, PAN, card-like numbers, IPv4, prefixed dates of birth, prefixed passport numbers, labeled names and addresses, sensitive field metadata, exact custom private values and faces. It masks visual regions that it cannot inspect safely.

General multilingual NER, OCR inside images/canvas/video, QR-code decoding, signatures, minors, vehicle identifiers, IPv6/MAC/IMEI, and broad health, genetic, religious, sexual or political classification are not claimed in v1. These categories belong in the policy now so a future local OCR/NER model can add detections without changing what the grades mean.

