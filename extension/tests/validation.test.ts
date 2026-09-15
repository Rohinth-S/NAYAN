import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type SanitizedObservation } from '../src/types';
import { parseReasonResponse, validateObservation } from '../src/validation';

const snapshotId = '2d6c3ed8-a2f9-46a5-a4be-f0961881957b';

function observation(): SanitizedObservation {
  return {
    schemaVersion: SCHEMA_VERSION,
    snapshotId,
    documentId: 'd99fba3b-1682-4622-824f-8deddaaaa6c9',
    page: { origin: 'https://site-0123456789abcdef0123.invalid', title: 'Synthetic portal' },
    task: 'Click submit',
    elements: [{
      id: 'e_1234567890abcdef',
      role: 'button',
      label: 'Submit',
      bounds: { x: 10, y: 20, width: 80, height: 30 },
      state: { disabled: false, checked: false, editable: false, required: false },
    }],
    image: {
      mime: 'image/png',
      dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      width: 200,
      height: 100,
    },
    redactions: [],
    privacy: { grade: 3, detectorBackend: 'wasm', visualFallback: 'none', rawImageRetained: false },
  };
}

describe('v1 protocol validation', () => {
  it('accepts the exact sanitized observation contract', () => {
    expect(() => validateObservation(observation())).not.toThrow();
  });

  it('rejects extra fields and raw retention', () => {
    expect(() => validateObservation({ ...observation(), rawDom: '<html>' })).toThrow('Unexpected field');
    expect(() => validateObservation({ ...observation(), privacy: { ...observation().privacy, rawImageRetained: true } })).toThrow('retention');
  });

  it('rejects a real browsing origin instead of the opaque site alias', () => {
    expect(() => validateObservation({
      ...observation(),
      page: { origin: 'https://medical.example', title: 'Synthetic portal' },
    })).toThrow('opaque alias');
  });

  it('requires a full mask when the visual detector is unavailable', () => {
    expect(() => validateObservation({
      ...observation(),
      privacy: { grade: 3, detectorBackend: 'missing', visualFallback: 'none', rawImageRetained: false },
    })).toThrow('requires full-image mask');
  });

  it('rejects zero-area and out-of-image rectangles before egress', () => {
    const base = observation();
    expect(() => validateObservation({
      ...base,
      elements: [{ ...base.elements[0]!, bounds: { x: 10, y: 20, width: 0, height: 30 } }],
    })).toThrow('positive area');
    expect(() => validateObservation({
      ...base,
      redactions: [{ kind: 'pii-text', source: 'regex', bounds: { x: 199, y: 0, width: 2, height: 1 } }],
    })).toThrow('outside');
  });

  it('accepts revision-bound allowlisted actions', () => {
    const result = parseReasonResponse({
      schemaVersion: SCHEMA_VERSION,
      snapshotId,
      action: { type: 'click', elementId: 'e_1234567890abcdef' },
    }, snapshotId);
    expect(result.action.type).toBe('click');
  });

  it('rejects stale, unknown, and malformed actions', () => {
    expect(() => parseReasonResponse({ schemaVersion: SCHEMA_VERSION, snapshotId: crypto.randomUUID(), action: { type: 'done' } }, snapshotId)).toThrow('Stale');
    expect(() => parseReasonResponse({ schemaVersion: SCHEMA_VERSION, snapshotId, action: { type: 'navigate', url: 'https://evil.example' } }, snapshotId)).toThrow();
    expect(() => parseReasonResponse({ schemaVersion: SCHEMA_VERSION, snapshotId, action: { type: 'click' } }, snapshotId)).toThrow('requires elementId');
    expect(() => parseReasonResponse({ schemaVersion: SCHEMA_VERSION, snapshotId, action: { type: 'scroll', direction: 'down' } }, snapshotId)).toThrow('direction and amount');
    expect(() => parseReasonResponse({ schemaVersion: SCHEMA_VERSION, snapshotId, action: { type: 'wait', milliseconds: 99 } }, snapshotId)).toThrow('milliseconds');
    expect(() => parseReasonResponse({
      schemaVersion: SCHEMA_VERSION,
      snapshotId,
      action: { type: 'click', elementId: 'e_1234567890abcdef', text: 'unused' },
    }, snapshotId)).toThrow('Unexpected field');
  });

  it('enforces receiver collection caps', () => {
    const base = observation();
    const repeated = Array.from({ length: 501 }, (_, index) => ({
      ...base.elements[0]!,
      id: `e_${String(index).padStart(16, '0')}`,
    }));
    expect(() => validateObservation({ ...base, elements: repeated })).toThrow('Invalid elements');
    const redactions = Array.from({ length: 1_001 }, () => ({
      kind: 'pii-text' as const,
      source: 'regex' as const,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
    }));
    expect(() => validateObservation({ ...base, redactions })).toThrow('Invalid redactions');
  });
});
