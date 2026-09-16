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
  source: 'dom' | 'regex' | 'onnx' | 'unified-detector' | 'dbnet' | 'fallback';
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

export type AgentAction = Readonly<{
  type: 'click' | 'input' | 'scroll' | 'wait' | 'done';
  elementId?: string;
  text?: string;
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
  redactions: readonly Readonly<{
    kind: RedactionKind;
    source: 'dom' | 'regex';
    bounds: CssBounds;
  }>[];
}>;

export type ExtensionSettings = Readonly<{
  endpoint: string;
  apiKey: string;
  task: string;
  maxSteps: number;
  privacyGrade: PrivacyGrade;
  allowFullMaskFallback: boolean;
  canaries: readonly string[];
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
  /** Approach B: Privacy UX metrics for M5 */
  categoryCounts?: Record<string, number>;
  maskedAreaPercentage?: number;
  /** Approach B: scroll-drift guard state for mid-flight race prevention. */
  scrollDrift?: ScrollDriftState;
  /** Approach B: dual-metric latency tracking. */
  latencyBudget?: LatencyBudget;
}>;

export type PopupCommand =
  | { type: 'GET_STATUS' }
  | { type: 'PREVIEW'; settings: ExtensionSettings }
  | { type: 'START'; settings: ExtensionSettings }
  | { type: 'STOP' };

export type ContentCommand =
  | { type: 'PING' }
  | { type: 'CAPTURE_DOM'; snapshotId: string; knownValues: readonly string[]; privacyGrade: PrivacyGrade }
  | { type: 'VERIFY_REVISION' }
  | {
      type: 'EXECUTE_ACTION';
      snapshotId: string;
      documentId: string;
      documentRevision: number;
      action: AgentAction;
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
      result?: string;
    }
  | { ok: false; error: string };
