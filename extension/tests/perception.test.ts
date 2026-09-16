import { describe, expect, it } from 'vitest';
import { entityCategory, perceive, validBounds, type PerceptionRuntime } from '../src/perception';

const canvas = { width: 320, height: 240 } as unknown as OffscreenCanvas;
const runtime = (entity = 'PER', ocrConfidence = 0.95, barcodeCount = 0): PerceptionRuntime => ({
  async entities() { return [{ entity, score: 0.96 }]; },
  async ocr() { return [{ text: 'Aadhaar 1234 5678 9012', bounds: { x: 10, y: 10, width: 150, height: 20 }, confidence: ocrConfidence }]; },
  async barcodes() { return Array.from({ length: barcodeCount }, (_, i) => ({ x: 5 + i * 20, y: 5, width: 15, height: 15 })); },
  async close() {},
});

describe('local perception safety contract', () => {
  it('redacts neural name findings without returning source text', async () => {
    const result = await perceive(runtime(), canvas, [{ text: 'Meera Rao', bounds: { x: 0, y: 0, width: 100, height: 20 } }], ['Meera Rao'], 3, []);
    expect(result.safeTexts).toEqual(['[REDACTED:NAME]']);
    expect(JSON.stringify(result)).not.toContain('Meera Rao');
    expect(result.findings[0]?.modelVersion).toBe('1.1.0');
  });

  it('maps uncertain predictions to the invariant floor', () => {
    expect(entityCategory({ entity: 'PER', score: 0.2 })).toBe('uninspectable');
  });

  it('fails closed on unknown model labels', async () => {
    await expect(perceive(runtime('UNKNOWN'), canvas, [], ['public'], 3, [])).rejects.toThrow('Local perception failed');
  });

  it('classifies barcodes and QR codes as uninspectable regions', async () => {
    const result = await perceive(runtime('PER', 0.95, 2), canvas, [], [], 3, []);
    const barcodeFindings = result.findings.filter(f => f.source === 'barcode');
    expect(barcodeFindings).toHaveLength(2);
    expect(barcodeFindings.every(f => f.category === 'uninspectable')).toBe(true);
  });

  it('treats low-confidence OCR results as uninspectable', async () => {
    const result = await perceive(runtime('PER', 0.5, 0), canvas, [], [], 3, []);
    const ocrFinding = result.findings.find(f => f.source === 'ocr');
    expect(ocrFinding?.category).toBe('uninspectable');
  });

  it('enforces valid canvas and box bounds for SVG, canvas, and media regions', () => {
    expect(validBounds({ x: 0, y: 0, width: 100, height: 100 }, 320, 240)).toBe(true);
    expect(validBounds({ x: -5, y: 0, width: 100, height: 100 }, 320, 240)).toBe(false);
    expect(validBounds({ x: 0, y: 0, width: 400, height: 100 }, 320, 240)).toBe(false);
  });

  it('rejects execution when perception budget is exceeded', async () => {
    const hugeCanvas = { width: 4000, height: 4000 } as unknown as OffscreenCanvas;
    await expect(perceive(runtime(), hugeCanvas, [], [], 3, [])).rejects.toThrow('Local perception budget exceeded');
  });
});
