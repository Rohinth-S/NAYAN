# Setup, Operations & Development Runbook

[← Back to Main README](../../README.md) | [Contributing Guidelines](../../CONTRIBUTING.md) | [Release Checklist](../../RELEASE_CHECKLIST.md)

---

## 1. System Requirements

- Windows PowerShell for the supplied scripts;
- Node.js 20 or newer;
- Python 3.11 or newer;
- Git;
- Ollama with a machine capable of running `qwen3-vl:2b-instruct`.

---

## 2. Environment Setup

```powershell
git clone https://github.com/Rohinth-S/privacy-focused-browser-agent.git
Set-Location privacy-focused-browser-agent
.\Setup-Prototype.ps1
ollama pull qwen3-vl:2b-instruct
.\Test-Prototype.ps1
```

The setup script installs extension dependencies, creates `server\.venv`, installs server test dependencies, and verifies the checked-in UltraFace checksum. Dependencies, models, API keys, and runtime files stay in ignored directories.

To verify the full browser wiring with a synthetic page, run:

```powershell
node scripts/workflow-smoke.mjs
```

This isolated smoke loads the packaged Chrome extension, captures and sanitizes the demo locally, sends only the sanitized observation to a local development server, executes the real LangGraph controller, accepts the in-page submit review, and writes aggregate results to `artifacts/workflow-smoke.json`. It exercises wiring and action safety; it is not model-accuracy evidence.

---

## 3. Starting and Stopping the Prototype

```powershell
.\Start-Prototype.ps1
```

The launcher:
- Starts or reuses local Ollama on loopback;
- Verifies the selected model exists;
- Generates or reuses `.runtime\api-key.txt`;
- Starts Uvicorn on `127.0.0.1:8765`;
- Configures development API-key and CORS settings.

`Start-LocalOllama.ps1` keeps Ollama bound to loopback, disables Ollama cloud mode and anonymized telemetry for the prototype, and places its project-local model/runtime state under ignored paths when possible.

Use `.\Start-Prototype.ps1 -SkipOllama` when Ollama is already managed separately. Stop with:

```powershell
.\Stop-Prototype.ps1
```

For a hidden background server with process tracking, use `.\Start-Prototype.ps1 -SkipOllama -Background`. The launcher requires the session key and keeps its value out of terminal output. A manually started Uvicorn process without `PRIVACY_AGENT_API_KEY` can report healthy while rejecting extension requests with **403**; stop that process and use the launcher. **401** means the panel key is missing or differs from `.runtime\api-key.txt`. Preview remains local and does not test server authentication.

Capture waits for a stable page revision, then discards and repeats a same-document capture up to three times if layout or scrolling changes during sanitization. The extension never sends the discarded image. A tab, origin, or document replacement stops the run; continuously changing pages also stop after the retry budget. Leave the page still while the agent works, then review and approve the in-page card when it requests the synthetic form submission.

---

## 4. Building and Loading the Extension

```powershell
Push-Location extension
npm run package
Pop-Location
```

For optional local perception:

```powershell
Push-Location extension
npm run package:perception
Pop-Location
```

If the local OCR asset ever needs to be restored, verify and download it with:

```powershell
Push-Location extension
npm run prepare:ocr
Pop-Location
```

### Loading in Chrome
1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select `extension\dist\chrome`.
5. Click the extension icon to open the persistent Private Browser Agent Side Panel.

### Loading in Firefox
1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select `extension\dist\firefox\manifest.json`.
4. Open the Private Browser Agent Sidebar.

---

## 5. Running the Synthetic Task & Demonstration

1. Open `http://127.0.0.1:8765/demo`.
2. Open the Side Panel/Sidebar.
3. Choose a preset or enter a task.
4. Copy the value inside `.runtime\api-key.txt` and paste it into **Optional API key**. Paste the key, not the file path.
5. Optionally enter fictional demo values under **Known private values**.
6. Select Grade 1, Grade 2, or Grade 3.
7. Click **Privacy preview** and inspect the locally generated image, redaction count, detector backend, and mask area. Preview makes no reasoning request.
8. Open **Sanitized DOM capsule** below the image. Its snapshot ID matches the image preview, and its expandable JSON view shows the structured fields eligible for the reasoning request. The panel explicitly lists omitted raw values, selectors, DOM references, cookies, the real URL, and the raw DOM snapshot.
9. Use **Expand** or **Open full view** to inspect the redacted image and DOM capsule at full size.
10. Click **Start agent**.
11. Review the populated fields and approve the in-page card when the agent requests the submit action.
12. Confirm `Enrollment submitted successfully.` appears in the demo.

For a grade comparison recording, reset the demo and run Privacy preview once at each grade:
- Grade 1 masks credentials, government/financial IDs, faces, known-private values, and uninspectable media.
- Grade 2 also masks contact, location, date-of-birth, account, and network categories.
- Grade 3 also masks names, usernames, employee identifiers, and ambiguous populated fields.

If the panel reports local offscreen sanitization failure, rebuild and reload the extension before changing the API key. The failure occurs before the reasoning request. Use the full-mask fallback only as a diagnostic or explicit high-privacy mode because it makes the entire image opaque.

---

## 6. Developer Commands Reference

```powershell
Push-Location extension
npm run typecheck
npm test
npm run package
Pop-Location

Push-Location server
.\.venv\Scripts\pytest.exe
.\.venv\Scripts\ruff.exe check .
Pop-Location

$env:PYTHONPATH = "$PWD\server;$PWD\evaluation"
& .\server\.venv\Scripts\python.exe -m pytest .\evaluation\tests -q

python scripts/verify-governance.py
python scripts/security-scan.py
python scripts/generate-sbom.py
```

---

## 7. Repository Files Index

| Path | Purpose |
| --- | --- |
| `extension/` | Cross-browser extension source, local capture, policy, detectors, redaction, preview, egress, actions, tests, and packaging. |
| `server/` | FastAPI receiver, strict schemas, validation, Ollama/provider adapters, jobs, ledgers, action guard, and demo portal. |
| `evaluation/` | Synthetic corpus, receiver verifier, precision/recall and pixel-area helpers, fuzzing, and state-machine tests. |
| `evidence/` | Aggregate synthetic and local model evidence only. |
| `governance/` | Detector registry schema, protocol manifest/migrations, and security review records. |
| `scripts/` | Release gate, governance, security, SBOM, disk budget, demo preflight, signing, retention, and preview helpers. |
| `PRIVACY_LEVELS.md` | Complete Grade 1/2/3 classification contract. |
| `PROTOCOL.md` | Frozen v1 request, async polling, response, and failure contract. |
| `ARCHITECTURE.md` | Trust boundary, data inventory, fail-closed choices, and browser-fork decision. |
| `ARCHITECTURE_REVIEW.md` | Approach A versus Approach B reasoning and migration record. |
| `INTEGRATION_REVIEW.md` | Integration invariants and verification record. |
| `EDGE_CASE_MATRIX.md` | Required capture, detector, browser, network, and action failure behavior. |
| `THREAT_MODEL.md` | Threat actors, trust assumptions, assets, and out-of-scope systems. |
| `VALIDATION_REPORT.md` | Validation snapshot and evidence interpretation. |
| `TEAM_HANDOFF.md` | Detailed current architecture and implementation handoff. |
| `TEAM_WORK_SPLIT.md` | Ownership, completed workstreams, acceptance criteria, and remaining release gates. |
| `MITHUL_HANDOFF.md` | Local perception and model portability handoff. |
| `MITHUL_RELEASE_RUNBOOK.md` | Release and evidence runbook. |
| `CONTRIBUTING.md` | Team workflow, privacy rules, tests, and review checklist. |
| `RELEASE_CHECKLIST.md` | Release and production-hardening checklist. |
| `SECURITY.md` | Security reporting and scope of the privacy claim. |
| `docker-compose.yml` | Hardened server, Redis, and Nginx deployment baseline. |
| `.github/workflows/ci.yml` | Extension, server, evaluation, governance, security, and SBOM CI. |

---

## 8. Contributing Safely

Use short-lived branches and pull requests. Every change that adds a detector, category, field, action, endpoint, permission, model, or serialized property must update:

- Implementation;
- Unit and failure tests;
- `PROTOCOL.md` when the wire contract changes;
- `PRIVACY_LEVELS.md` and the detector registry when policy changes;
- `EDGE_CASE_MATRIX.md` when failure behavior changes;
- Evidence and release metadata when a measured claim changes.

Preserve the single-egress invariant, avoid real personal data, keep runtime state ignored, and run the focused checks plus `.\Test-Prototype.ps1` before requesting review.

---

## 9. License and Attribution

The UltraFace attribution and license are shipped under `extension/models`. The optional `browser-use/` and BrowserOS references retain their upstream license files when cloned separately. Choose and add a project-level open-source license before public production distribution.
