import { describe, expect, it } from 'vitest';
import { assertFinalDlpClear } from '../src/dlp';
import { SCHEMA_VERSION, type SanitizedObservation } from '../src/types';

const realisticObservation: SanitizedObservation = {
  schemaVersion: SCHEMA_VERSION,
  snapshotId: 'c959bd20-ee18-4d9d-bdd3-c39eea94af95',
  documentId: 'f63f1fe5-bc3c-4483-a64d-57fba725db81',
  page: {
    origin: 'https://site-ce88fddbf852a5bad25b.invalid',
    title: 'Orbital Benefits Portal — [REDACTED:KNOWN]',
  },
  task: 'Check the confirmation checkbox, then submit the enrollment.',
  elements: [
    {
      id: 'e_jgAQCSNKhIpkN-u984WrUP7x',
      role: 'textbox',
      label: 'Employee code',
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      state: { disabled: false, checked: false, editable: true, required: true },
    },
    {
      id: 'e_lV8zCuu9UbzcWYm3IjSZO3PJ',
      role: 'textbox',
      label: 'Portal password',
      bounds: { x: 5, y: 6, width: 7, height: 8 },
      state: { disabled: false, checked: false, editable: true, required: true },
    },
    {
      id: 'e_tq8kKHAVgtmAI7yihjbL13Oh',
      role: 'checkbox',
      label: 'I confirm the benefit selection shown above.',
      bounds: { x: 9, y: 10, width: 11, height: 12 },
      state: { disabled: false, checked: false, editable: false, required: true },
    },
    {
      id: 'e_ruNemoOqHcIMC0AOIGCoCtdv',
      role: 'button',
      label: 'Submit enrollment',
      bounds: { x: 13, y: 14, width: 15, height: 16 },
      state: { disabled: false, checked: false, editable: false, required: false },
    },
  ],
  image: { mime: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', width: 32, height: 32 },
  redactions: [
    { kind: 'password', source: 'dom', bounds: { x: 5, y: 6, width: 7, height: 8 } },
    { kind: 'sensitive-field', source: 'dom', bounds: { x: 1, y: 2, width: 3, height: 4 } },
    { kind: 'pii-text', source: 'regex', bounds: { x: 9, y: 10, width: 11, height: 12 } },
  ],
  privacy: { grade: 3, detectorBackend: 'wasm', visualFallback: 'none', rawImageRetained: false },
};

describe('final outbound DLP gate', () => {
  it('does not classify opaque IDs, geometry, or schema metadata as PII', () => {
    expect(() => assertFinalDlpClear(realisticObservation, [])).not.toThrow();
  });

  it('still blocks a sensitive value in a user text field', () => {
    const leaked = { ...realisticObservation, task: 'Send the report to analyst@example.test' };
    expect(() => assertFinalDlpClear(leaked, [])).toThrow('Final local DLP gate');
  });

  it('checks configured canaries over the complete payload', () => {
    const leaked = { ...realisticObservation, documentId: 'f63f1fe5-bc3c-4483-a64d-57fba725db81' };
    expect(() => assertFinalDlpClear(leaked, ['f63f1fe5'])).toThrow('canary');
  });
});
