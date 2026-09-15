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
  'uninspectable-frame',
  'uninspectable-media',
  'visual-fallback',
] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

export type Redaction = Readonly<{
  kind: RedactionKind;
  source: 'dom' | 'regex' | 'onnx' | 'fallback';
  bounds: Bounds;
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
