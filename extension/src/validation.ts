import {
  REDACTION_KINDS,
  SCHEMA_VERSION,
  type AgentAction,
  type Bounds,
  type ReasonResponse,
  type SanitizedObservation,
} from './types';
import { isPrivacyGrade } from './privacy-policy';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ELEMENT_ID_RE = /^e_[A-Za-z0-9_-]{16,64}$/;
const PNG_PREFIX = 'iVBORw0KGgo';
const MAX_IMAGE_BASE64 = 8_000_000;
const MAX_ELEMENTS = 500;
const MAX_REDACTIONS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unexpected field: ${key}`);
  }
  for (const key of required) {
    if (!(key in value)) throw new Error(`Missing field: ${key}`);
  }
}

function finiteNumber(value: unknown, name: string, min = 0, max = 100_000): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}`);
  }
}

function boundedString(value: unknown, name: string, max: number, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > max) {
    throw new Error(`Invalid ${name}`);
  }
}

function validateBounds(value: unknown): asserts value is Bounds {
  if (!isRecord(value)) throw new Error('Invalid bounds');
  exactKeys(value, ['x', 'y', 'width', 'height']);
  finiteNumber(value.x, 'bounds.x');
  finiteNumber(value.y, 'bounds.y');
  finiteNumber(value.width, 'bounds.width');
  finiteNumber(value.height, 'bounds.height');
  if (value.width <= 0 || value.height <= 0) throw new Error('Bounds must have positive area');
}

function validateOrigin(value: unknown): asserts value is string {
  boundedString(value, 'page.origin', 512);
  if (!/^https:\/\/site-[0-9a-f]{20}\.invalid$/u.test(value)) {
    throw new Error('Page origin must be a session-scoped opaque alias');
  }
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Invalid origin');
  if (parsed.origin !== value || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Only a page origin may be sent');
}

export type ObservationValidationOptions = Readonly<{
  /** Local previews do not need a user task, but egress must still require one. */
  allowEmptyTask?: boolean;
}>;

export function validateObservation(
  value: unknown,
  options: ObservationValidationOptions = {},
): asserts value is SanitizedObservation {
  if (!isRecord(value)) throw new Error('Observation must be an object');
  exactKeys(value, ['schemaVersion', 'snapshotId', 'documentId', 'page', 'task', 'elements', 'image', 'redactions', 'privacy']);
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported schema version');
  if (typeof value.snapshotId !== 'string' || !UUID_RE.test(value.snapshotId)) throw new Error('Invalid snapshotId');
  if (typeof value.documentId !== 'string' || !UUID_RE.test(value.documentId)) throw new Error('Invalid documentId');
  boundedString(value.task, 'task', 2_000, options.allowEmptyTask === true);

  if (!isRecord(value.page)) throw new Error('Invalid page');
  exactKeys(value.page, ['origin', 'title']);
  validateOrigin(value.page.origin);
  boundedString(value.page.title, 'page.title', 300, true);

  if (!Array.isArray(value.elements) || value.elements.length > MAX_ELEMENTS) throw new Error('Invalid elements');
  const ids = new Set<string>();
  for (const element of value.elements) {
    if (!isRecord(element)) throw new Error('Invalid element');
    exactKeys(element, ['id', 'role', 'label', 'bounds', 'state']);
    if (typeof element.id !== 'string' || !ELEMENT_ID_RE.test(element.id) || ids.has(element.id)) throw new Error('Invalid element id');
    ids.add(element.id);
    if (!['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'option', 'scroll-region', 'other'].includes(String(element.role))) {
      throw new Error('Invalid element role');
    }
    boundedString(element.label, 'element.label', 300, true);
    validateBounds(element.bounds);
    if (!isRecord(element.state)) throw new Error('Invalid element state');
    exactKeys(element.state, ['disabled', 'checked', 'editable', 'required']);
    for (const key of ['disabled', 'checked', 'editable', 'required'] as const) {
      if (typeof element.state[key] !== 'boolean') throw new Error(`Invalid element.state.${key}`);
    }
  }

  if (!isRecord(value.image)) throw new Error('Invalid image');
  exactKeys(value.image, ['mime', 'dataBase64', 'width', 'height']);
  if (value.image.mime !== 'image/png') throw new Error('Only PNG is allowed');
  boundedString(value.image.dataBase64, 'image.dataBase64', MAX_IMAGE_BASE64);
  if (!value.image.dataBase64.startsWith(PNG_PREFIX)) throw new Error('Invalid PNG encoding');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.image.dataBase64)) throw new Error('Invalid base64');
  finiteNumber(value.image.width, 'image.width', 1, 8_192);
  finiteNumber(value.image.height, 'image.height', 1, 8_192);

  if (!Array.isArray(value.redactions) || value.redactions.length > MAX_REDACTIONS) throw new Error('Invalid redactions');
  for (const redaction of value.redactions) {
    if (!isRecord(redaction)) throw new Error('Invalid redaction');
    exactKeys(redaction, ['kind', 'source', 'bounds']);
    if (!REDACTION_KINDS.includes(redaction.kind as never)) throw new Error('Invalid redaction kind');
    if (!['dom', 'regex', 'onnx', 'fallback'].includes(String(redaction.source))) throw new Error('Invalid redaction source');
    validateBounds(redaction.bounds);
  }

  if (!isRecord(value.privacy)) throw new Error('Invalid privacy metadata');
  exactKeys(
    value.privacy,
    ['grade', 'detectorBackend', 'visualFallback', 'rawImageRetained'],
    ['redactionMode', 'registryDigest', 'detectorArch', 'canvasPrivacyTier'],
  );
  if (!isPrivacyGrade(value.privacy.grade)) throw new Error('Invalid privacy grade');
  if (!['webgpu', 'wasm', 'missing', 'error'].includes(String(value.privacy.detectorBackend))) throw new Error('Invalid detector backend');
  if (!['none', 'full-mask'].includes(String(value.privacy.visualFallback))) throw new Error('Invalid visual fallback');
  if (value.privacy.rawImageRetained !== false) throw new Error('Raw image retention must be false');
  if (value.privacy.redactionMode !== undefined && !['semantic', 'opaque'].includes(String(value.privacy.redactionMode))) {
    throw new Error('Invalid redaction mode');
  }
  if (
    value.privacy.registryDigest !== undefined
    && !/^sha256:[0-9a-f]{64}$/.test(String(value.privacy.registryDigest))
  ) {
    throw new Error('Invalid registry digest');
  }
  if (
    value.privacy.detectorArch !== undefined
    && !['ultraface', 'yolov8n', 'yolov10n'].includes(String(value.privacy.detectorArch))
  ) {
    throw new Error('Invalid detector architecture');
  }
  if (
    value.privacy.canvasPrivacyTier !== undefined
    && !['visual-redaction', 'dbnet-blind-mask', 'manual-escalation'].includes(String(value.privacy.canvasPrivacyTier))
  ) {
    throw new Error('Invalid canvas privacy tier');
  }
  if (value.privacy.redactionMode === 'semantic' && value.privacy.visualFallback !== 'none') {
    throw new Error('Semantic redaction cannot be used with full-mask fallback');
  }
  if (['missing', 'error'].includes(String(value.privacy.detectorBackend)) && value.privacy.visualFallback !== 'full-mask') {
    throw new Error('Unavailable visual detector requires full-image mask');
  }

  const imageWidth = value.image.width as number;
  const imageHeight = value.image.height as number;
  const allBounds = [
    ...value.elements.map((element) => (element as Record<string, unknown>).bounds as Bounds),
    ...value.redactions.map((redaction) => (redaction as Record<string, unknown>).bounds as Bounds),
  ];
  for (const bounds of allBounds) {
    if (bounds.x + bounds.width > imageWidth || bounds.y + bounds.height > imageHeight) {
      throw new Error('Bounds are outside the sanitized image');
    }
  }
}

function validateAction(value: unknown): asserts value is AgentAction {
  if (!isRecord(value)) throw new Error('Invalid action');
  if (!['click', 'input', 'scroll', 'wait', 'done'].includes(String(value.type))) throw new Error('Unsupported action');
  const allowedByType: Record<AgentAction['type'], readonly string[]> = {
    click: ['type', 'elementId'],
    input: ['type', 'elementId', 'text'],
    scroll: ['type', 'direction', 'amount', 'elementId'],
    wait: ['type', 'milliseconds'],
    done: ['type', 'message'],
  };
  const type = value.type as AgentAction['type'];
  exactKeys(value, ['type'], allowedByType[type]!.filter((key) => key !== 'type'));
  if (value.elementId !== undefined && (typeof value.elementId !== 'string' || !ELEMENT_ID_RE.test(value.elementId))) {
    throw new Error('Invalid action elementId');
  }
  if (value.text !== undefined) boundedString(value.text, 'action.text', 512, true);
  if (value.message !== undefined) boundedString(value.message, 'action.message', 512, true);
  if (value.direction !== undefined && !['up', 'down'].includes(String(value.direction))) throw new Error('Invalid scroll direction');
  if (value.amount !== undefined) finiteNumber(value.amount, 'action.amount', 1, 5_000);
  if (value.milliseconds !== undefined) finiteNumber(value.milliseconds, 'action.milliseconds', 100, 5_000);

  if (value.type === 'click' && !value.elementId) throw new Error('click requires elementId');
  if (value.type === 'input' && (!value.elementId || value.text === undefined)) throw new Error('input requires elementId and text');
  if (value.type === 'scroll' && (!value.direction || value.amount === undefined)) throw new Error('scroll requires direction and amount');
  if (value.type === 'wait' && value.milliseconds === undefined) throw new Error('wait requires milliseconds');
}

export function parseReasonResponse(value: unknown, expectedSnapshotId: string): ReasonResponse {
  if (!isRecord(value)) throw new Error('Response must be an object');
  exactKeys(value, ['schemaVersion', 'snapshotId', 'action']);
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported response schema');
  if (value.snapshotId !== expectedSnapshotId) throw new Error('Stale or mismatched response');
  validateAction(value.action);
  return value as ReasonResponse;
}
