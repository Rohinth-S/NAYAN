# System Architecture & Design Deep Dive

[← Back to Main README](../../README.md) | [Architecture Overview](../../ARCHITECTURE.md) | [Architecture Review](../../ARCHITECTURE_REVIEW.md)

---

## 1. Technical Modules Architecture

The following module-level view maps the browser UX, local privacy boundary, reasoning service, safe execution path, and operational evidence back to the source files that implement them.

```mermaid
flowchart TD

subgraph group_browser_ux["Browser UX"]
  node_popup["Task Interface<br/>[popup.ts]"]
  node_background["Background Controller<br/>[background.ts]"]
  node_preview["Sanitized Preview<br/>[preview.ts]"]
end

subgraph group_local_privacy["Local Privacy"]
  node_content_capture["Page Capture<br/>[content.ts]"]
  node_perception["Perception Runtime"]
  node_face_detector["Face Detector<br/>[face-detector.ts]"]
  node_document_ocr["Document OCR<br/>[document-ocr.ts]"]
  node_media_policy["Media Policy<br/>[media-policy.ts]"]
  node_privacy_policy["Privacy Grades<br/>[privacy-policy.ts]"]
  node_redactor["Image Redactor<br/>[image-redactor.ts]"]
  node_sanitizer["Observation Sanitizer<br/>[privacy.ts]"]
  node_client_validation["Outbound Validation<br/>[validation.ts]"]
end

subgraph group_reasoning["Reasoning Service"]
  node_api["Reasoning API<br/>[main.py]"]
  node_server_validation["Server Validation<br/>[validation.py]"]
  node_reasoner["Model Adapter<br/>[ollama.py]"]
end

subgraph group_safe_execution["Safe Execution"]
  node_egress["Reasoning Egress<br/>[egress.ts]"]
  node_action_guard["Action Guard<br/>[action_guard.py]"]
  node_agent_graph["Agent Controller<br/>[agent-graph.ts]"]
  node_context_guard["Context Guard<br/>[context-guard.ts]"]
end

subgraph group_operations["Operations"]
  node_job_queue["Reasoning Jobs<br/>[jobs.py]"]
  node_receipt["Privacy Receipt<br/>[privacy-receipt.ts]"]
end

node_user(("User"))
node_page["Live Page"]
node_ollama["Local Ollama"]

node_user -->|"sets task"| node_popup
node_popup -->|"starts capture"| node_background
node_background -->|"requests snapshot"| node_content_capture
node_content_capture -->|"provides signals"| node_perception
node_perception -->|"detects faces"| node_face_detector
node_perception -.->|"inspects documents"| node_document_ocr
node_perception -->|"classifies media"| node_media_policy
node_privacy_policy -->|"selects categories"| node_redactor
node_perception -->|"applies grade"| node_privacy_policy
node_redactor -->|"creates observation"| node_sanitizer
node_sanitizer -->|"passes bytes"| node_client_validation
node_client_validation -->|"authorizes egress"| node_egress
node_sanitizer -->|"renders proof"| node_preview
node_sanitizer -->|"records receipt"| node_receipt
node_egress -->|"sends observation"| node_api
node_api -->|"validates request"| node_server_validation
node_api -.->|"queues reasoning"| node_job_queue
node_api -->|"requests reasoning"| node_reasoner
node_reasoner -->|"calls model"| node_ollama
node_api -->|"guards action"| node_action_guard
node_api -->|"returns action"| node_egress
node_egress -->|"delivers action"| node_agent_graph
node_agent_graph -->|"checks context"| node_context_guard
node_agent_graph -->|"executes action"| node_page
node_agent_graph -->|"requests confirmation"| node_popup
node_page -->|"exposes state"| node_content_capture

click node_popup "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/extension/src/popup.ts"
click node_background "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/extension/src/background.ts"
click node_preview "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/extension/src/preview.ts"
click node_content_capture "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/extension/src/content.ts"
click node_perception "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/extension/src/perception-runtime.ts"
click node_face_detector "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/extension/src/face-detector.ts"
click node_document_ocr "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/extension/src/document-ocr.ts"
click node_media_policy "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/extension/src/media-policy.ts"
click node_privacy_policy "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/extension/src/privacy-policy.ts"
click node_redactor "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/extension/src/image-redactor.ts"
click node_sanitizer "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/extension/src/privacy.ts"
click node_client_validation "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/extension/src/validation.ts"
click node_egress "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/extension/src/egress.ts"
click node_api "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/server/app/main.py"
click node_server_validation "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/server/app/validation.py"
click node_job_queue "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/server/app/jobs.py"
click node_reasoner "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/server/app/gateways/ollama.py"
click node_action_guard "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/server/app/action_guard.py"
click node_agent_graph "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/extension/src/agent-graph.ts"
click node_context_guard "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/extension/src/context-guard.ts"
click node_receipt "https://github.com/rohinth-s/privacy-focused-browser-agent/blob/main/extension/src/privacy-receipt.ts"

classDef toneNeutral fill:#f8fafc,stroke:#334155,stroke-width:1.5px,color:#0f172a
classDef toneBlue fill:#dbeafe,stroke:#2563eb,stroke-width:1.5px,color:#172554
classDef toneAmber fill:#fef3c7,stroke:#d97706,stroke-width:1.5px,color:#78350f
classDef toneMint fill:#dcfce7,stroke:#16a34a,stroke-width:1.5px,color:#14532d
classDef toneRose fill:#ffe4e6,stroke:#e11d48,stroke-width:1.5px,color:#881337
classDef toneIndigo fill:#e0e7ff,stroke:#4f46e5,stroke-width:1.5px,color:#312e81
classDef toneTeal fill:#ccfbf1,stroke:#0f766e,stroke-width:1.5px,color:#134e4a
class node_popup,node_background,node_preview,node_user toneBlue
class node_content_capture,node_perception,node_face_detector,node_document_ocr,node_media_policy,node_privacy_policy,node_redactor,node_sanitizer,node_client_validation toneAmber
class node_api,node_server_validation,node_reasoner toneMint
class node_egress,node_action_guard,node_agent_graph,node_context_guard toneRose
class node_job_queue,node_receipt,node_page,node_ollama toneIndigo
```

---

## 2. Trust Boundary Architecture

The extension is the trusted privacy boundary for the configured reasoning channel. The webpage and reasoning service are treated as untrusted inputs or recipients.

```mermaid
flowchart LR
  subgraph DEVICE[User device: extension boundary]
    PAGE[Untrusted webpage<br/>DOM, forms, canvas, frames, media]
    CAPTURE[Content capture + visible PNG]
    DETECT[Local DOM, regex, known-value,<br/>face, optional perception]
    POLICY[Versioned Grade 1/2/3 policy]
    COMPOSE[Fresh compositor<br/>semantic redaction or opaque mask]
    CHECK[Serialized-body and revision checks]
    EGRESS[Only reasoning egress owner]
    EXEC[Action verifier and executor]
    PAGE --> CAPTURE
    CAPTURE --> DETECT --> POLICY --> COMPOSE --> CHECK --> EGRESS
    EGRESS --> EXEC --> PAGE
  end
  subgraph SERVICE[Reasoning service: untrusted recipient]
    BOUNDARY[Authentication, origins,<br/>size and content checks]
    VALIDATE[Strict sanitized protocol validator]
    JOBS[Bounded jobs and circuit breaker]
    MODEL[Ollama or provider adapter]
    RESPONSE[Strict action response]
    BOUNDARY --> VALIDATE --> JOBS --> MODEL --> RESPONSE
  end
  EGRESS -->|sanitized PNG + safe metadata| BOUNDARY
  RESPONSE --> EXEC
  RAW[Original pixels, raw DOM values,<br/>cookies, selectors, real URL,<br/>private-value map] -. never crosses .-> BOUNDARY
```

The server receives a versioned observation containing a fresh PNG, safe structure, opaque IDs, redaction metadata, the selected grade, a detector/registry description, and an origin alias. It does not receive the original screenshot, raw HTML, selectors, form values, cookies, storage, the real hostname, or the local ID-to-DOM map.

The privacy guarantee is scoped to this extension-to-configured-reasoning-service channel. It does not control ordinary website traffic, another extension, another application, a compromised browser, external screen sharing, or a provider outside the configured protocol.

---

## 3. Four-Layer System View

```mermaid
flowchart TB
    subgraph L1[1. Observe locally]
        P[Live webpage] --> C[Content script]
        P --> S[Visible screenshot]
        C --> CAPS[Safe DOM capsule]
    end
    subgraph L2[2. Protect locally]
        CAPS --> D[DOM, regex, known-value, face, optional perception]
        S --> D
        D --> G[Selected privacy grade]
        G --> R[Fresh semantic or opaque redaction]
    end
    subgraph L3[3. Reason remotely]
        R --> V[Schema, PNG, canary, revision, byte gates]
        V --> E[Single sanitized egress]
        E --> Q[FastAPI validation + bounded job]
        Q --> M[Ollama or sanitized provider]
    end
    subgraph L4[4. Act safely]
        M --> A[Strict action JSON]
        A --> X[Live snapshot and confirmation guard]
        X --> P
    end
```

The first two layers run on the user's machine. The reasoning service only receives the output of the protection layer. The final layer returns to the live page through a local opaque-ID map; the model never receives selectors or DOM handles.

---

## 4. End-to-End Sequence Diagram

```mermaid
sequenceDiagram
    participant User
    participant UI as Side Panel / Sidebar
    participant SW as Background controller
    participant CS as Content script
    participant Local as Local sanitizer
    participant API as FastAPI
    participant Model as Ollama / adapter
    participant Page

    User->>UI: Enter task and select grade
    UI->>SW: Start or preview
    SW->>CS: Capture DOM + activate scroll guard
    SW->>Local: Capture visible PNG and sanitize locally
    Local->>Local: Detect, apply grade, compose fresh PNG
    Local->>SW: Sanitized raster + safe metadata
    SW->>CS: Recheck document, viewport, origin, revision
    SW->>API: One sanitized POST
    API->>Model: Validated sanitized context
    Model->>API: Strict action JSON
    API->>SW: Action or opaque job result
    SW->>CS: Verify target and execute
    CS->>Page: Safe click/input/scroll/hover/focus/select/check actions
    CS->>SW: Action result and new revision
    SW->>CS: Recapture next step
```

If the page scrolls, resizes, navigates, changes origin, or otherwise invalidates the captured context during reasoning, the returned action is discarded and the extension captures a fresh step.

---

## 5. Privacy Decision Ladder

```mermaid
flowchart TD
    OBS[Observed page pixels and structure] --> INSPECT{Can the region be inspected safely?}
    INSPECT -- No --> UNKNOWN[Classify as uninspectable]
    INSPECT -- Yes --> FIND[Run local field, text, face, and optional perception detectors]
    UNKNOWN --> FLOOR[Invariant protection floor]
    FIND --> CAT[Assign a registry category]
    CAT --> GRADE{Does the selected grade hide it?}
    GRADE -- Yes --> MASK[Replace with category-only mask]
    GRADE -- No --> SAFE[Retain only the minimum safe context]
    FLOOR --> MASK
    MASK --> FRESH[Encode a new PNG]
    SAFE --> FRESH
    FRESH --> GATE{All local gates pass?}
    GATE -- No --> BLOCK[Zero egress or explicit opaque fallback]
    GATE -- Yes --> SEND[Send sanitized observation]
```

The ladder explains why a lower grade never disables the invariant floor: unknown or high-impact data reaches the mask path before the grade-specific disclosure choice is considered.

---

## 6. Architecture Evolution: Approach A to Approach B

The architecture evolved from the original multi-model, conservative per-step design to Approach B after an engineering trade-off review:

| Bottleneck | Approach B response |
| --- | --- |
| Separate face/document/template inference paths | Unified YOLO interface with asset-gated v8/v10 parsing and UltraFace fallback |
| Canvas applications contain pixels invisible to DOM inspection | Three-tier canvas strategy with optional DBNet blind masking and manual escalation |
| Viewport can move while a model reasons | Content-script Step 0 scroll-drift guard and recapture |
| Flat latency claims hide local versus end-to-end cost | Separate local processing and end-to-end latency measurements |
| Long-running model calls are fragile in MV3 | Bounded async server jobs, bodyless polling, and service-worker heartbeat |

Approach B preserved the important invariants: Chrome/Firefox extension packaging, local privacy enforcement, fresh-image redaction, fail-closed egress, strict action output, snapshot-bound execution, and explicit limitations.

The architecture decision is documented in [ARCHITECTURE_REVIEW.md](../../ARCHITECTURE_REVIEW.md) and the external RFC references:
- [SIH26171 Consolidated Engineering RFC](https://app.notion.com/p/SIH26171-Consolidated-Engineering-RFC-Single-Page-Master-Specification-3d8e39636db881a1865ee211e787be0b)
- [Architecture Trade-off Analysis RFC](https://app.notion.com/p/Architecture-Trade-off-Analysis-Approach-A-vs-Approach-B-RFC-Evaluation-3d8e39636db881a492eacc8fc4833c8b)
