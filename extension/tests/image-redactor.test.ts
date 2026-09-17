import { describe, expect, it } from 'vitest';
import { imageRedactorInternals } from '../src/image-redactor';
import type { DocumentOcrResult } from '../src/document-ocr';
import type { Redaction } from '../src/types';

describe('opaque mask geometry', () => {
  it('covers every receiver crop pixel for fractional bounds', () => {
    const source = { x: 10.75, y: 20.25, width: 4.5, height: 3.1 };
    const mask = imageRedactorInternals.integerMaskBounds(source, 100, 100);
    expect(mask).toEqual({ x: 10, y: 20, width: 6, height: 4 });
    expect(mask.x).toBeLessThanOrEqual(Math.floor(source.x));
    expect(mask.x + mask.width).toBeGreaterThanOrEqual(Math.ceil(source.x + source.width));
    expect(mask.y + mask.height).toBeGreaterThanOrEqual(Math.ceil(source.y + source.height));
  });

  it('clips expanded masks at image boundaries', () => {
    expect(imageRedactorInternals.integerMaskBounds({ x: 98.8, y: 99.2, width: 5, height: 5 }, 100, 100))
      .toEqual({ x: 98, y: 99, width: 2, height: 1 });
  });
});

describe('semantic placeholder labels', () => {
  it('uses category-only labels that never include source content', () => {
    expect(imageRedactorInternals.placeholderFor('password')).toBe('[REDACTED:PASSWORD]');
    expect(imageRedactorInternals.placeholderFor('face')).toBe('[REDACTED:FACE]');
    expect(imageRedactorInternals.placeholderFor('pii-text')).toBe('[REDACTED:PII]');
    expect(imageRedactorInternals.placeholderFor('uninspectable-media')).toBe('[REDACTED:MEDIA]');
  });

  it('renders OCR document fields with their specific category', () => {
    expect(imageRedactorInternals.placeholderForDocumentSecret('name')).toBe('[REDACTED:NAME]');
    expect(imageRedactorInternals.placeholderForDocumentSecret('date-of-birth')).toBe('[REDACTED:DATE_OF_BIRTH]');
    expect(imageRedactorInternals.placeholderForDocumentSecret('aadhaar-number')).toBe('[REDACTED:AADHAAR_NUMBER]');
    expect(imageRedactorInternals.placeholderForDocumentSecret('mobile')).toBe('[REDACTED:PHONE_NUMBER]');
    expect(imageRedactorInternals.placeholderForDocumentSecret('address')).toBe('[REDACTED:ADDRESS]');
    expect(imageRedactorInternals.placeholderForDocumentSecret('card-number')).toBe('[REDACTED:CARD_NUMBER]');
    expect(imageRedactorInternals.placeholderForDocumentSecret('expiry')).toBe('[REDACTED:EXPIRY]');
    expect(imageRedactorInternals.placeholderForDocumentSecret('cvv')).toBe('[REDACTED:CVV]');
  });
  it('blocks non-uniform screenshot scaling that would shift redaction boxes', () => {
    expect(imageRedactorInternals.uniformViewportScale(1.25, 1.25)).toBe(true);
    expect(imageRedactorInternals.uniformViewportScale(1, 0.84)).toBe(false);
    expect(imageRedactorInternals.uniformViewportScale(0, 1)).toBe(false);
  });

  it('removes a whole-media mask only after local document OCR finds every card credential', () => {
    const media = { x: 20, y: 30, width: 280, height: 170 };
    const redactions: Redaction[] = [
      { kind: 'uninspectable-media', source: 'dom', bounds: media },
      { kind: 'pii-text', source: 'regex', bounds: { x: 400, y: 30, width: 60, height: 20 } },
    ];
    const scan: DocumentOcrResult = {
      documents: [{ kind: 'credit-card', bounds: media, confidence: 0.91 }],
      secrets: [{
        kind: 'sensitive-field',
        secretType: 'card-number',
        bounds: { x: 60, y: 90, width: 190, height: 20 },
        confidence: 0.9,
        mediaBounds: media,
      }, {
        kind: 'sensitive-field',
        secretType: 'expiry',
        bounds: { x: 260, y: 120, width: 40, height: 20 },
        confidence: 0.9,
        mediaBounds: media,
      }, {
        kind: 'sensitive-field',
        secretType: 'cvv',
        bounds: { x: 310, y: 120, width: 30, height: 20 },
        confidence: 0.9,
        mediaBounds: media,
      }, {
        kind: 'sensitive-field',
        secretType: 'name',
        bounds: { x: 60, y: 145, width: 120, height: 20 },
        confidence: 0.9,
        mediaBounds: media,
      }],
      durationMs: 12,
      modelVersion: 'test',
    };

    const narrowed = imageRedactorInternals.narrowVerifiedDocumentMedia(redactions, scan);
    expect(narrowed.some(item => item.kind === 'uninspectable-media')).toBe(false);
    expect(narrowed).toContain(redactions[1]);
  });

  it('keeps a card fully masked when OCR misses a required credential', () => {
    const media = { x: 20, y: 30, width: 280, height: 170 };
    const scan: DocumentOcrResult = {
      documents: [{ kind: 'credit-card', bounds: media, confidence: 0.91 }],
      secrets: [{
        kind: 'sensitive-field',
        secretType: 'card-number',
        bounds: { x: 60, y: 90, width: 190, height: 20 },
        confidence: 0.9,
        mediaBounds: media,
      }],
      durationMs: 12,
      modelVersion: 'test',
    };

    expect(imageRedactorInternals.narrowVerifiedDocumentMedia([
      { kind: 'uninspectable-media', source: 'dom', bounds: media },
    ], scan)).toEqual([
      { kind: 'uninspectable-media', source: 'dom', bounds: media },
    ]);
  });

  it('removes only the verified document mask and keeps an overlapping portrait fail-closed', () => {
    const media = { x: 20, y: 30, width: 280, height: 170 };
    const portrait = { x: 38, y: 56, width: 54, height: 68 };
    const scan: DocumentOcrResult = {
      documents: [{ kind: 'credit-card', bounds: media, confidence: 0.91 }],
      secrets: [{
        kind: 'sensitive-field', secretType: 'card-number', bounds: { x: 70, y: 90, width: 150, height: 20 }, confidence: 0.9, mediaBounds: media,
      }, {
        kind: 'sensitive-field', secretType: 'expiry', bounds: { x: 230, y: 130, width: 38, height: 18 }, confidence: 0.9, mediaBounds: media,
      }, {
        kind: 'sensitive-field', secretType: 'cvv', bounds: { x: 270, y: 130, width: 25, height: 18 }, confidence: 0.9, mediaBounds: media,
      }, {
        kind: 'sensitive-field', secretType: 'name', bounds: { x: 105, y: 152, width: 90, height: 16 }, confidence: 0.9, mediaBounds: media,
      }],
      durationMs: 12,
      modelVersion: 'test',
    };

    expect(imageRedactorInternals.narrowVerifiedDocumentMedia([
      { kind: 'uninspectable-media', source: 'dom', bounds: media },
      { kind: 'uninspectable-media', source: 'dom', bounds: portrait },
    ], scan)).toEqual([
      { kind: 'uninspectable-media', source: 'dom', bounds: portrait },
    ]);
  });

  it('requires PAN, name, and date of birth before narrowing a PAN image', () => {
    const media = { x: 20, y: 30, width: 280, height: 170 };
    const document = { kind: 'pan-card' as const, bounds: media, confidence: 0.94 };
    const pan = { kind: 'pan-card' as const, secretType: 'pan' as const, bounds: { x: 60, y: 80, width: 90, height: 18 }, confidence: 0.9, mediaBounds: media };
    const name = { kind: 'pan-card' as const, secretType: 'name' as const, bounds: { x: 60, y: 110, width: 100, height: 18 }, confidence: 0.9, mediaBounds: media };
    const date = { kind: 'pan-card' as const, secretType: 'date-of-birth' as const, bounds: { x: 60, y: 140, width: 80, height: 18 }, confidence: 0.9, mediaBounds: media };

    expect(imageRedactorInternals.completeDocumentCoverage(document, [pan, date])).toBe(false);
    expect(imageRedactorInternals.completeDocumentCoverage(document, [pan, name, date])).toBe(true);
  });

  it('keeps whole-media masks when document OCR has no secret finding', () => {
    const media = { x: 20, y: 30, width: 280, height: 170 };
    const redactions: Redaction[] = [{ kind: 'uninspectable-media', source: 'dom', bounds: media }];
    const scan: DocumentOcrResult = {
      documents: [{ kind: 'credit-card', bounds: media, confidence: 0.91 }],
      secrets: [],
      durationMs: 12,
      modelVersion: 'test',
    };

    expect(imageRedactorInternals.narrowVerifiedDocumentMedia(redactions, scan)).toEqual(redactions);
  });

  it('does not treat the structural full-viewport fallback as an OCR crop', () => {
    expect(imageRedactorInternals.coversWholeImage({ x: 0, y: 0, width: 1_280, height: 720 }, 1_280, 720)).toBe(true);
    expect(imageRedactorInternals.coversWholeImage({ x: 80, y: 50, width: 640, height: 360 }, 1_280, 720)).toBe(false);
  });
});
