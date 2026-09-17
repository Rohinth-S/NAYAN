import { describe, expect, it } from 'vitest';
import { createPrivacyReceipt, markPrivacyReceiptSent } from '../src/privacy-receipt';
import { SCHEMA_VERSION, type SanitizedObservation } from '../src/types';

const observation: SanitizedObservation = {
  schemaVersion: SCHEMA_VERSION,
  snapshotId: 'a1abcc51-58de-4bea-abfe-08400f9f0ef7',
  documentId: '79dc263f-bdcc-4869-bb83-6efe5cba7f52',
  page: { origin: 'https://site-0123456789abcdef0123.invalid', title: '[REDACTED:NAME]' },
  task: 'Submit the form',
  elements: [],
  image: {
    mime: 'image/png',
    dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    width: 1,
    height: 1,
  },
  redactions: [
    { kind: 'password', source: 'dom', bounds: { x: 0, y: 0, width: 1, height: 1 } },
    { kind: 'face', source: 'onnx', bounds: { x: 0, y: 0, width: 1, height: 1 } },
  ],
  privacy: {
    grade: 3,
    detectorBackend: 'wasm',
    visualFallback: 'none',
    rawImageRetained: false,
    redactionMode: 'semantic',
  },
};

describe('local outbound privacy receipt', () => {
  it('contains only aggregate privacy facts and hashes the sanitized image', async () => {
    const receipt = await createPrivacyReceipt(observation, 42.4, 'sanitized-visual', 2, false);
    expect(receipt).toMatchObject({
      requestCount: 2,
      privacyGrade: 3,
      detectorBackend: 'wasm',
      maskedAreaPercentage: 42,
      redactionMode: 'semantic',
      transmissionMode: 'sanitized-visual',
      sent: false,
      redactionCategories: { password: 1, face: 1 },
    });
    expect(receipt.imageSha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(receipt)).not.toContain('REDACTED:NAME');
  });

  it('marks a receipt only after the server accepts the request', async () => {
    const receipt = await createPrivacyReceipt(observation, 100, 'structure-only', 3, false);
    expect(markPrivacyReceiptSent(receipt, 3)).toMatchObject({ sent: true, requestCount: 3 });
  });
});
