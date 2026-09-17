import { describe, expect, it } from 'vitest';
import { classifyDocumentOcr, documentOcrInternals, type DocumentOcrLine } from '../src/document-ocr';
import type { Bounds } from '../src/types';

const media: Bounds = { x: 100, y: 80, width: 420, height: 250 };

function line(text: string, y: number, confidence = 0.92): DocumentOcrLine {
  return {
    text,
    confidence,
    bounds: { x: media.x + 32, y: media.y + y, width: 340, height: 24 },
  };
}

describe('local document OCR classifier', () => {
  it('narrows a credit card image to credential lines only', () => {
    const result = classifyDocumentOcr([
      line('ORBITAL BANK', 24),
      line('AARAV SHARMA', 74),
      line('4111 1111 1111 1111', 118),
      line('VALID THRU 08/29', 158),
      line('SECURITY CODE 482', 194),
    ], [media]);

    expect(result.documents).toEqual([
      expect.objectContaining({ kind: 'credit-card', bounds: media }),
    ]);
    expect(result.secrets.map(secret => secret.secretType)).toEqual(['card-number', 'expiry', 'cvv']);
    expect(JSON.stringify(result)).not.toContain('4111');
    expect(JSON.stringify(result)).not.toContain('AARAV');
  });

  it('uses nearby security-code labels to redact a separated CVV value', () => {
    const result = classifyDocumentOcr([
      line('ORBITAL CARD', 24),
      line('4111 1111 1111 1111', 118),
      line('VALID THRU', 158),
      line('08/29', 184),
      line('SECURITY CODE', 198),
      line('482', 222),
    ], [media]);

    expect(result.secrets.map(secret => secret.secretType)).toEqual(['card-number', 'expiry', 'cvv']);
  });

  it('uses OCR word geometry so labels and cardholder names stay visible', () => {
    const words = (items: Array<[string, number]>): NonNullable<DocumentOcrLine['words']> => items.map(([text, x]) => ({
      text,
      confidence: 0.95,
      bounds: { x, y: media.y + 118, width: text.length * 9, height: 20 },
    }));
    const result = classifyDocumentOcr([
      line('ORBITAL BANK', 24),
      {
        ...line('4111 1111 1111 1111', 118),
        words: words([['4111', 132], ['1111', 180], ['1111', 228], ['1111', 276]]),
      },
      line('VALID THRU SECURITY CODE', 158),
      {
        ...line('AARAV SHARMA 08/29 482', 194),
        words: [
          { text: 'AARAV', confidence: 0.95, bounds: { x: 132, y: media.y + 194, width: 48, height: 20 } },
          { text: 'SHARMA', confidence: 0.95, bounds: { x: 184, y: media.y + 194, width: 64, height: 20 } },
          { text: '08/29', confidence: 0.95, bounds: { x: 280, y: media.y + 194, width: 44, height: 20 } },
          { text: '482', confidence: 0.95, bounds: { x: 340, y: media.y + 194, width: 30, height: 20 } },
        ],
      },
    ], [media]);

    const card = result.secrets.find(secret => secret.secretType === 'card-number');
    const expiry = result.secrets.find(secret => secret.secretType === 'expiry');
    const cvv = result.secrets.find(secret => secret.secretType === 'cvv');
    expect(card?.bounds.x).toBe(132);
    expect(card?.bounds.width).toBe(180);
    expect(expiry?.bounds.x).toBe(280);
    expect(cvv?.bounds.x).toBe(340);
  });

  it('accepts a common OCR-prefixed expiry while keeping field coverage gated', () => {
    const result = classifyDocumentOcr([
      line('ORBITAL BANK CREDIT CARD', 24),
      line('4111 1111 1111 1111', 118),
      { ...line('AARAV SHARMA 038/29 482', 194), words: [{ text: '482', confidence: 0.95, bounds: { x: 400, y: 274, width: 25, height: 15 } }] },
    ], [media], [{ bounds: media, documentType: 'credit-card' }]);

    expect(result.documents[0]?.kind).toBe('credit-card');
    expect(result.secrets.map(secret => secret.secretType)).toEqual(['card-number', 'expiry', 'cvv']);
  });

  it('uses a credit-card hint when downscaled OCR omits the security-code label', () => {
    const words = (items: Array<[string, number, number]>): NonNullable<DocumentOcrLine['words']> => items.map(([text, x, y]) => ({
      text,
      confidence: 0.95,
      bounds: { x, y, width: text.length * 9, height: 20 },
    }));
    const result = classifyDocumentOcr([
      line('SYNTHETIC EVALUATION CARD', 20),
      line('4111 1111 1111 1111', 118),
      {
        ...line('AARAV SHARMA 08/29 482', 194),
        words: words([
          ['AARAV', 132, media.y + 194],
          ['SHARMA', 184, media.y + 194],
          ['08/29', 280, media.y + 194],
          ['482', 340, media.y + 194],
        ]),
      },
    ], [media], [{ bounds: media, documentType: 'credit-card' }]);

    expect(result.documents).toEqual([
      expect.objectContaining({ kind: 'credit-card', bounds: media }),
    ]);
    expect(result.secrets.map(secret => secret.secretType)).toEqual(['card-number', 'expiry', 'cvv', 'name']);
    expect(result.secrets.find(secret => secret.secretType === 'cvv')?.bounds.x).toBe(340);
  });

  it('redacts every labelled PAN field it can prove without masking the whole image', () => {
    const result = classifyDocumentOcr([
      line('INCOME TAX DEPARTMENT', 20),
      line('AARAV SHARMA', 70),
      line('ABCDE1234F', 120),
      line('DATE OF BIRTH 14/08/1998', 170),
    ], [media]);

    expect(result.documents[0]?.kind).toBe('pan-card');
    expect(result.secrets.map(secret => secret.secretType)).toEqual(['pan', 'date-of-birth']);
  });

  it('requires and isolates PAN name and date values when their headings are separate', () => {
    const result = classifyDocumentOcr([
      line('INCOME TAX DEPARTMENT', 20),
      line('PERMANENT ACCOUNT NUMBER', 52),
      line('ABCDE1234F', 82),
      line('NAME', 112),
      line('AARAV SHARMA', 142),
      line('DATE OF BIRTH', 172),
      line('14/08/1998', 202),
    ], [media], [{ bounds: media, documentType: 'pan-card' }]);

    expect(result.secrets.map(secret => secret.secretType)).toEqual(['pan', 'name', 'date-of-birth']);
    expect(result.secrets.find(secret => secret.secretType === 'name')?.bounds)
      .toEqual(line('AARAV SHARMA', 142).bounds);
    expect(result.secrets.find(secret => secret.secretType === 'date-of-birth')?.bounds)
      .toEqual(line('14/08/1998', 202).bounds);
  });

  it('uses a local PAN hint to associate large values when tiny captions vanish', () => {
    const result = classifyDocumentOcr([
      line('INCOME TAX DEPARTMENT', 20),
      line('SYNTHETIC PAN CARD DEMO FIXTURE', 48),
      line('ABCDE1234F', 92),
      line('AARAV SHARMA', 138),
      line('14/08/1998', 184),
    ], [media], [{ bounds: media, documentType: 'pan-card' }]);

    expect(result.secrets.map(secret => secret.secretType)).toEqual(['pan', 'name', 'date-of-birth']);
  });

  it('narrows a synthetic Aadhaar-style document to PII lines only', () => {
    const result = classifyDocumentOcr([
      line('SYNTHETIC IDENTITY CARD', 20),
      line('AADHAAR-STYLE PRIVACY TEST FIXTURE', 44),
      line('NAME: KAVYA MENON', 90),
      line('DATE OF BIRTH: 17/05/1997', 132),
      line('GENDER: FEMALE', 174),
      line('MOBILE: +91 98765 43210', 202),
      line('ADDRESS: 42 ORBIT AVENUE, BENGALURU', 226),
      line('AADHAAR NUMBER: 9876 5432 1098', 232),
    ], [media]);

    expect(result.documents).toEqual([
      expect.objectContaining({ kind: 'aadhaar-card', bounds: media }),
    ]);
    expect(result.secrets.map(secret => secret.secretType)).toEqual([
      'name',
      'date-of-birth',
      'gender',
      'mobile',
      'address',
      'aadhaar-number',
    ]);
    expect(JSON.stringify(result)).not.toContain('9876');
  });

  it('recovers confident Aadhaar words from a line containing low-confidence ornamentation', () => {
    const result = classifyDocumentOcr([
      line('SYNTHETIC IDENTITY CARD', 20),
      line('NAME: KAVYA MENON', 90),
      line('DATE OF BIRTH: 17/05/1997', 132),
      { ...line('! GENDER: FEMALE', 174, 0.48), words: [
        { text: '!', confidence: 0.05, bounds: { x: 102, y: 254, width: 5, height: 15 } },
        { text: 'GENDER:', confidence: 0.9, bounds: { x: 200, y: 254, width: 55, height: 15 } },
        { text: 'FEMALE', confidence: 0.95, bounds: { x: 260, y: 254, width: 55, height: 15 } },
      ] },
      line('MOBILE: +91 98765 43210', 202),
      line('ADDRESS: 42 ORBIT AVENUE, BENGALURU', 226),
      line('AADHAAR NUMBER: 9876 5432 1098', 232),
    ], [media]);

    expect(result.documents[0]?.kind).toBe('aadhaar-card');
    expect(result.secrets.map(secret => secret.secretType)).toContain('gender');
    expect(result.secrets.find(secret => secret.secretType === 'gender')?.bounds)
      .toEqual({ x: 260, y: 254, width: 55, height: 15 });
  });

  it('does not classify a twelve-digit number as Aadhaar without document context', () => {
    const result = classifyDocumentOcr([line('9876 5432 1098', 120)], [media]);
    expect(documentOcrInternals.aadhaarIn('9876 5432 1098')).toBe(true);
    expect(documentOcrInternals.aadhaarIn('987654321098')).toBe(false);
    expect(documentOcrInternals.aadhaarIn('AADHAAR NUMBER: 987654321098')).toBe(true);
    expect(result.documents).toEqual([]);
    expect(result.secrets).toEqual([]);
  });

  it('does not unmask a generic PAN-shaped token without document context', () => {
    const result = classifyDocumentOcr([line('ABCDE1234F', 120)], [media]);
    expect(result.documents).toEqual([]);
    expect(result.secrets).toEqual([]);
  });

  it('keeps uninspectable media fail-closed when OCR confidence is low', () => {
    const result = classifyDocumentOcr([
      line('4111 1111 1111 1111', 118, 0.52),
      line('VALID THRU 08/29', 158, 0.54),
    ], [media]);

    expect(result.documents).toEqual([]);
    expect(result.secrets).toEqual([]);
  });

  it('requires card context in addition to a Luhn-valid number', () => {
    const result = classifyDocumentOcr([
      line('Reference 4111 1111 1111 1111', 118),
    ], [media]);

    expect(documentOcrInternals.cardNumberIn('4111 1111 1111 1111')).toBe(true);
    expect(result.documents).toEqual([]);
  });

  it('uses a coarse credit-card hint when OCR misses the word credit', () => {
    const lines = [
      line('4111 1111 1111 1111', 118),
      line('08/29', 158),
      line('SECURITY CODE 482', 194),
    ];
    // The hint is local metadata only. It is safe to use as a tie-breaker
    // because all three card credentials are still required below.
    const result = classifyDocumentOcr(lines, [media], [{ bounds: media, documentType: 'credit-card' }]);
    expect(result.documents).toEqual([
      expect.objectContaining({ kind: 'credit-card', bounds: media }),
    ]);
    expect(result.secrets.map(secret => secret.secretType)).toEqual(['card-number', 'expiry', 'cvv']);
  });

  it('associates a separate trailing CVV line with a nearby expiry line', () => {
    const cvvLine: DocumentOcrLine = {
      ...line('482', 194),
      words: [{
        text: '482',
        confidence: 0.95,
        bounds: { x: media.x + 280, y: media.y + 194, width: 30, height: 20 },
      }],
    };
    const result = classifyDocumentOcr([
      line('4111 1111 1111 1111', 118),
      line('08/29', 158),
      cvvLine,
    ], [media], [{ bounds: media, documentType: 'credit-card' }]);
    expect(result.documents[0]?.kind).toBe('credit-card');
    expect(result.secrets.map(secret => secret.secretType)).toEqual(['card-number', 'expiry', 'cvv']);
    expect(result.secrets.find(secret => secret.secretType === 'cvv')?.bounds).toEqual(cvvLine.words?.[0]?.bounds);
  });

  it('never lets a credit-card hint bypass incomplete credential coverage', () => {
    const result = classifyDocumentOcr([
      line('4111 1111 1111 1111', 118),
      line('08/29', 158),
    ], [media], [{ bounds: media, documentType: 'credit-card' }]);
    expect(result.documents).toEqual([]);
    expect(result.secrets).toEqual([]);
  });

  it('does not OCR portrait or square media as a document candidate', () => {
    expect(documentOcrInternals.documentShapeLikely({ x: 0, y: 0, width: 100, height: 100 })).toBe(false);
    expect(documentOcrInternals.documentShapeLikely({ x: 0, y: 0, width: 100, height: 180 })).toBe(false);
    expect(documentOcrInternals.documentShapeLikely({ x: 0, y: 0, width: 320, height: 200 })).toBe(true);
  });
});
