import type { PrivacyGrade } from './privacy-policy';

export const SCHEMA_VERSION = '1.0' as const;

export type Bounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export const REDACTION_KINDS = [
  'password',
  'pii-text',
  'sensitive-field',
  'face',
  'aadhaar-card',
  'pan-card',
  'voter-id',
  'driving-license',
  'passport',
  'signature',
  'canvas-text',
  'uninspectable-frame',
  'uninspectable-media',
  'visual-fallback',
] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

/**
 * Approach B unified multi-class detection taxonomy.
 * A single YOLOv8n/v10n forward pass detects all classes simultaneously,
 * replacing the multi-model ensemble from Approach A.
 */
export const VISION_DETECTION_CLASSES = [
  'face',
  'aadhaar_card',
  'pan_card',
  'voter_id',
  'driving_license',
  'passport',
  'signature',
] as const;
export type VisionDetectionClass = (typeof VISION_DETECTION_CLASSES)[number];

/** Approach B: 3-tier canvas-app PII mitigation strategy. */
export type CanvasPrivacyTier =
  | 'visual-redaction'    // Tier 1: standard visual-object redaction (default)
  | 'dbnet-blind-mask'    // Tier 2: opt-in DBNet detection-only text masking
  | 'manual-escalation';  // Tier 3: user-initiated manual review

/** Approach B: scroll-drift guard state for mid-flight race prevention. */
export type ScrollDriftState = Readonly<{
  /** Whether the viewport has drifted since the last SoM registry was built. */
  drifted: boolean;
  /** Timestamp of last detected scroll event during a VLM network call. */
  lastDriftTimestamp: number | null;
  /** The debounce window in ms for the passive scroll listener. */
  debounceMs: number;
}>;

/** Approach B: dual-metric latency budget (median/p95 + end-to-end). */
export type LatencyBudget = Readonly<{
  localMedianMs: number;    // Target: ≤75ms
  localP95Ms: number;       // Target: ≤100-120ms
  endToEndMs: number;       // Target: ≤1.0-1.5s
}>;

export type Redaction = Readonly<{
  kind: RedactionKind;
  source: 'dom' | 'regex' | 'onnx' | 'unified-detector' | 'dbnet' | 'ocr' | 'fallback';
  bounds: Bounds;
  /** Approach B: confidence from unified detector, absent for rule-based sources. */
  confidence?: number;
}>;

export type ElementRole =
  | 'button'
  | 'link'
  | 'textbox'
  | 'checkbox'
  | 'radio'
  | 'combobox'
  | 'option'
  | 'scroll-region'
  | 'other';

export type SanitizedElement = Readonly<{
  id: string;
  role: ElementRole;
  label: string;
  bounds: Bounds;
  state: Readonly<{
    disabled: boolean;
    checked: boolean;
    editable: boolean;
    required: boolean;
  }>;
}>;

export type SanitizedObservation = Readonly<{
  schemaVersion: typeof SCHEMA_VERSION;
  snapshotId: string;
  documentId: string;
  page: Readonly<{
    origin: string;
    title: string;
  }>;
  task: string;
  elements: readonly SanitizedElement[];
  image: Readonly<{
    mime: 'image/png';
    dataBase64: string;
    width: number;
    height: number;
  }>;
  redactions: readonly Redaction[];
  privacy: Readonly<{
    grade: PrivacyGrade;
    detectorBackend: 'webgpu' | 'wasm' | 'missing' | 'error';
    visualFallback: 'none' | 'full-mask';
    rawImageRetained: false;
    /** Semantic placeholders are rendered locally in the sanitized raster. */
    redactionMode?: 'semantic' | 'opaque';
    /** Optional v1 digest of the compiled detector registry. */
    registryDigest?: string;
    /** Approach B: which detector architecture produced the visual detections. */
    detectorArch?: 'ultraface' | 'yolov8n' | 'yolov10n';
    /** Approach B: canvas privacy tier applied to canvas-app elements. */
    canvasPrivacyTier?: CanvasPrivacyTier;
  }>;
}>;

/**
 * Extension-local proof view of the DOM fields that accompany the outbound
 * SanitizedObservation. This deliberately contains no selectors, DOM
 * references, input values, cookies, or raw URL. Labels and task/title text
 * have already passed through the selected privacy policy.
 */
export type SanitizedDomPreview = Readonly<{
  snapshotId: string;
  documentId: string;
  originAlias: string;
  title: string;
  task: string;
  grade: PrivacyGrade;
  detectorBackend: SanitizedObservation['privacy']['detectorBackend'];
  redactionCount: number;
  elementCount: number;
  elements: readonly SanitizedElement[];
  redactionKinds: Readonly<Record<string, number>>;
  /** Local-only before/after accounting for the DOM proof panel. */
  domAudit?: DomSanitizationAudit;
  /** Local-only inventory of handles; values and selectors are never retained. */
  redactions?: readonly RedactionAuditItem[];
  registryDigest?: string;
}>;

/** A safe, displayable record for one local redaction. No original value is retained. */
export type RedactionAuditItem = Readonly<{
  handle: string;
  fieldId: string;
  type: string;
  layer: 'dom' | 'regex' | 'ner' | 'vision' | 'ocr' | 'fallback';
  source: Redaction['source'];
  confidence: number;
  bounds: Bounds;
  hasOnScreenBox: boolean;
  placeholder: string;
}>;

/** Counts are intentionally coarse: they prove minimisation without exposing the raw DOM. */
export type DomSanitizationAudit = Readonly<{
  rawInteractiveCount: number;
  rawCandidateRedactions: number;
  rawSensitiveFields: number;
  sanitizedInteractiveCount: number;
  sanitizedRedactions: number;
  valuesOmitted: true;
  selectorsOmitted: true;
}>;

export type LatencyBreakdown = Readonly<{
  screenshotMs: number;
  domInspectionMs: number;
  sanitizationMs: number;
  networkMs: number;
  actionMs: number;
  totalMs: number;
}>;

export type PolicyBlock = Readonly<{
  code: string;
  message: string;
}>;

/** Extension-local audit artifact. It is never part of SanitizedObservation. */
export type RedactionReport = Readonly<{
  reportId: string;
  generatedAt: string;
  status: 'preview' | 'running' | 'completed' | 'blocked' | 'cancelled';
  privacyGrade: PrivacyGrade;
  detectorBackend: SanitizedObservation['privacy']['detectorBackend'];
  detectorArch?: SanitizedObservation['privacy']['detectorArch'];
  redactionCount: number;
  maskedAreaPercentage: number;
  actionsExecuted: number;
  actionsBlocked: number;
  networkRequests: number;
  imageSha256: string;
  redactionMode: PrivacyReceipt['redactionMode'];
  transmissionMode: PrivacyReceipt['transmissionMode'];
  domAudit: DomSanitizationAudit;
  redactions: readonly RedactionAuditItem[];
  policyBlocks: readonly PolicyBlock[];
  latency: LatencyBreakdown;
}>;

export type AgentAction = Readonly<{
  /** All browser mutations stay inside the local, revision-bound action broker. */
  type:
    | 'click'
    | 'input'
    | 'scroll'
    | 'wait'
    | 'done'
    | 'hover'
    | 'focus'
    | 'doubleClick'
    | 'check'
    | 'uncheck'
    | 'select';
  elementId?: string;
  text?: string;
  /** Public option label/value for the native `select` action. */
  option?: string;
  direction?: 'up' | 'down';
  amount?: number;
  milliseconds?: number;
  message?: string;
}>;

export type ReasonResponse = Readonly<{
  schemaVersion: typeof SCHEMA_VERSION;
  snapshotId: string;
  action: AgentAction;
}>;

export type CssBounds = Bounds;

export type RawElement = Readonly<{
  id: string;
  role: ElementRole;
  label: string;
  bounds: CssBounds;
  state: SanitizedElement['state'];
}>;

export type RawDomSnapshot = Readonly<{
  documentId: string;
  documentRevision: number;
  origin: string;
  title: string;
  viewport: Readonly<{ width: number; height: number; scrollX: number; scrollY: number }>;
  elements: readonly RawElement[];
  /** Extension-local only: never included in SanitizedObservation. */
  textRegions?: readonly Readonly<{ text: string; bounds: CssBounds }>[];
  /** Extension-local only: coarse media hints used to guide local OCR. */
  mediaHints?: readonly Readonly<{
    bounds: CssBounds;
    kind: 'document' | 'person' | 'object' | 'unknown';
    documentType?: 'aadhaar-card' | 'pan-card' | 'credit-card' | 'unknown';
    /** Original loaded image pixels, local OCR only; never part of egress. */
    localImage?: Readonly<{ dataUrl: string; width: number; height: number }>;
  }>[];
  redactions: readonly Readonly<{
    kind: RedactionKind;
    source: 'dom' | 'regex';
    bounds: CssBounds;
    /** Optional field-specific label for semantic placeholders (e.g. 'NAME', 'PHONE'). */
    fieldLabel?: string;
  }>[];
}>;

export type ExtensionSettings = Readonly<{
  endpoint: string;
  apiKey: string;
  task: string;
  maxSteps: number;
  privacyGrade: PrivacyGrade;
  allowFullMaskFallback: boolean;
  /** Skip terminal confirmation only for the synthetic loopback demo page. */
  autoApproveLocalDemo: boolean;
  /** Enable an explicit, local-only transfer from a selected source tab. */
  allowLocalTransfer?: boolean;
  /** Source tab chosen in the extension UI; never persisted or sent to the server. */
  sourceTabId?: number | null;
  /**
   * High-assurance mode deliberately discards all screenshot semantics. The
   * server receives an opaque black PNG plus the already-sanitized DOM
   * structure, which is the strongest browser-compatible privacy posture.
   */
  highAssuranceMode: boolean;
  canaries: readonly string[];
}>;

export type PrivacyReceipt = Readonly<{
  requestCount: number;
  privacyGrade: PrivacyGrade;
  detectorBackend: SanitizedObservation['privacy']['detectorBackend'];
  redactionCategories: Readonly<Record<string, number>>;
  maskedAreaPercentage: number;
  imageSha256: string;
  redactionMode: 'semantic' | 'opaque';
  transmissionMode: 'sanitized-visual' | 'structure-only';
  sent: boolean;
}>;

export type AgentStatus = Readonly<{
  running: boolean;
  phase: 'idle' | 'capturing' | 'sanitizing' | 'reasoning' | 'executing' | 'done' | 'blocked' | 'error';
  message: string;
  step: number;
  detectorBackend: SanitizedObservation['privacy']['detectorBackend'];
  redactionCount: number;
  lastLatencyMs: number | null;
  previewDataUrl: string | null;
  /** Local proof view derived from the exact sanitized observation. */
  sanitizedDomPreview: SanitizedDomPreview | null;
  /** Approach B: Privacy UX metrics for M5 */
  categoryCounts?: Record<string, number>;
  maskedAreaPercentage?: number;
  /** Approach B: scroll-drift guard state for mid-flight race prevention. */
  scrollDrift?: ScrollDriftState;
  /** Approach B: dual-metric latency tracking. */
  latencyBudget?: LatencyBudget;
  /** Local-only receipt for the latest eligible or transmitted observation. */
  privacyReceipt: PrivacyReceipt | null;
  /** Local-only audit report for the latest preview/run. */
  latestReport?: RedactionReport | null;
  /** Stage timings for the latest capture/request cycle. */
  latencyBreakdown?: LatencyBreakdown;
}>;

export type PopupCommand =
  | { type: 'GET_STATUS' }
  | { type: 'PREVIEW'; settings: ExtensionSettings }
  | { type: 'START'; settings: ExtensionSettings }
  | { type: 'STOP' };

export type ContentCommand =
  | { type: 'PING' }
  | { type: 'CAPTURE_DOM'; snapshotId: string; knownValues: readonly string[]; privacyGrade: PrivacyGrade }
  /** Parse and fill only explicitly requested, page-declared public fields locally. */
  | { type: 'FILL_PUBLIC_FIELDS'; task: string }
  | { type: 'VERIFY_REVISION' }
  | { type: 'SET_SCROLL_GUARD'; active: boolean }
  | { type: 'GET_SCROLL_DRIFT' }
  /** Mark the page as being controlled by the agent; trusted user input pauses it. */
  | { type: 'SET_AUTOMATION_ACTIVE'; active: boolean }
  /** Read local interaction state without exposing page values. */
  | { type: 'GET_INTERACTION_STATE' }
  /** Capture editable values locally for an explicitly selected source tab. */
  | { type: 'CAPTURE_TRANSFER_FIELDS' }
  /** Fill matching destination controls using extension-local values only. */
  | { type: 'APPLY_TRANSFER_FIELDS'; fields: readonly TransferField[]; overwrite?: boolean }
  /** Dismiss an in-page approval card when the run is stopped or taken over. */
  | { type: 'CANCEL_PENDING_APPROVAL' }
  | {
      type: 'EXECUTE_ACTION';
      snapshotId: string;
      documentId: string;
      documentRevision: number;
      action: AgentAction;
      autoApproveIrreversible?: boolean;
    };

export type ContentResponse =
  | {
      ok: true;
      snapshot?: RawDomSnapshot;
      revision?: {
        documentId: string;
        documentRevision: number;
        origin: string;
        viewport: { width: number; height: number; scrollX: number; scrollY: number };
      };
      scrollDrift?: ScrollDriftState;
      interaction?: InteractionState;
      transfer?: TransferResult;
      transferFields?: readonly TransferField[];
      result?: string;
    }
  | { ok: false; error: string };

/** Extension-local field categories used for tab-to-tab matching. */
export type TransferField = Readonly<{
  label: string;
  value: string;
  kind: 'text' | 'email' | 'phone' | 'address' | 'date' | 'number' | 'select';
}>;

export type TransferResult = Readonly<{
  scanned: number;
  filled: number;
  skipped: number;
  unmatched: number;
}>;

export type InteractionState = Readonly<{
  automationActive: boolean;
  manualTakeover: boolean;
  interactionRevision: number;
  documentRevision: number;
}>;
