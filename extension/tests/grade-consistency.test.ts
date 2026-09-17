import { describe, expect, it } from 'vitest';
import { DOCUMENT_FIELD_CATEGORIES, requiredDocumentFields, shouldRedactDocumentSecret } from '../src/document-ocr';
import { classifySensitiveTextLabel, isSensitiveField, isSensitiveTextLabel } from '../src/privacy';
import { shouldRedactCategory, type PrivacyGrade } from '../src/privacy-policy';
import { identityFindings, sanitizeIdentityValues } from '../src/identity-values';
import { imageRedactorInternals } from '../src/image-redactor';
import type { DocumentOcrResult } from '../src/document-ocr';
import type { Redaction } from '../src/types';

describe('one grade policy for forms, repeated text and document OCR', () => {
  for (const grade of [1, 2, 3] as const) {
    it(`applies Grade ${grade} equally to names and dates of birth`, () => {
      for (const [category, label, autocomplete, value, hidden] of [
        ['name', 'Full name', 'name', 'Aarav Sharma', grade === 3],
        ['date-of-birth', 'Date of birth', 'bday', '14/08/1998', grade >= 2],
      ] as const) {
        expect(classifySensitiveTextLabel(label)).toBe(category);
        expect(isSensitiveTextLabel(label, grade)).toBe(hidden);
        expect(Boolean(isSensitiveField({ autocomplete }, grade))).toBe(hidden);
        expect(shouldRedactDocumentSecret(category, grade)).toBe(hidden);
        const repeated = `${value} in header, ${value} in summary`;
        const findings = identityFindings(repeated, [{ value, category }], grade);
        expect(findings).toHaveLength(hidden ? 2 : 0);
        expect(sanitizeIdentityValues(repeated, [{ value, category }], grade).includes(value)).toBe(!hidden);
      }
      for (const [field, category] of Object.entries(DOCUMENT_FIELD_CATEGORIES)) {
        expect(shouldRedactDocumentSecret(field as keyof typeof DOCUMENT_FIELD_CATEGORIES, grade))
          .toBe(shouldRedactCategory(category, grade));
      }
    });
  }

  it('requires cardholder-name coverage at Grade 3 and keeps critical fields at all grades', () => {
    for (const grade of [1, 2, 3] as PrivacyGrade[]) {
      expect(requiredDocumentFields('credit-card', grade)).toEqual(
        grade === 3 ? ['card-number', 'expiry', 'cvv', 'name'] : ['card-number', 'expiry', 'cvv'],
      );
      expect(requiredDocumentFields('pan-card', grade)).toEqual(
        grade === 1 ? ['pan'] : grade === 2 ? ['pan', 'date-of-birth'] : ['pan', 'name', 'date-of-birth'],
      );
    }
  });

  it('matches date-format variants without hiding unrelated dates or name substrings', () => {
    const values = [{ category: 'date-of-birth' as const, value: '1998-08-14' }, { category: 'name' as const, value: 'Ann Lee' }];
    expect(identityFindings('14/08/1998 14-08-1998 1998-08-14 15/08/1998', values, 2)).toHaveLength(3);
    expect(identityFindings('Ann Leeway; ANN LEE; Ann Lee', values, 3)).toHaveLength(2);
    expect(identityFindings('14/08/1998 Ann Lee', values, 1)).toHaveLength(0);
  });

  it('does not expose a missed name or DOB by narrowing a document at a stricter grade', () => {
    const media = { x: 0, y: 0, width: 400, height: 250 };
    const masks: Redaction[] = [{ kind: 'uninspectable-media', source: 'dom', bounds: media }];
    const scan: DocumentOcrResult = {
      documents: [{ kind: 'pan-card', bounds: media, confidence: 0.95 }],
      secrets: [{ kind: 'pan-card', secretType: 'pan', bounds: { x: 150, y: 50, width: 100, height: 20 }, mediaBounds: media, confidence: 0.95 }],
      durationMs: 1, modelVersion: 'test',
    };
    expect(imageRedactorInternals.narrowVerifiedDocumentMedia(masks, scan, 1)).toEqual([]);
    expect(imageRedactorInternals.narrowVerifiedDocumentMedia(masks, scan, 2)).toEqual(masks);
    expect(imageRedactorInternals.narrowVerifiedDocumentMedia(masks, scan, 3)).toEqual(masks);
    const withDob: DocumentOcrResult = { ...scan, secrets: [...scan.secrets, {
      kind: 'pan-card', secretType: 'date-of-birth', bounds: { x: 150, y: 100, width: 100, height: 20 }, mediaBounds: media, confidence: 0.95,
    }] };
    expect(imageRedactorInternals.narrowVerifiedDocumentMedia(masks, withDob, 2)).toEqual([]);
    expect(imageRedactorInternals.narrowVerifiedDocumentMedia(masks, withDob, 3)).toEqual(masks);
  });
});
