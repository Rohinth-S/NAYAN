import { describe, expect, it } from 'vitest';
import {
  CATEGORY_MINIMUM_GRADE,
  DEFAULT_PRIVACY_GRADE,
  normalizePrivacyGrade,
  REGISTRY_DIGEST,
  shouldRedactCategory,
  shouldRedactFinding,
} from '../src/privacy-policy';
import { classifySensitiveField, inputValueNeedsMask, isSensitiveField, sanitizeText } from '../src/privacy';
import { serializePersistedSettings } from '../src/settings';

describe('user-selectable privacy grades', () => {
  it('defaults malformed or missing selections to strict Grade 3', () => {
    expect(DEFAULT_PRIVACY_GRADE).toBe(3);
    expect(normalizePrivacyGrade(undefined)).toBe(3);
    expect(normalizePrivacyGrade('3')).toBe(3);
    expect(normalizePrivacyGrade(0)).toBe(3);
    expect(REGISTRY_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('keeps irreversible and uninspectable categories protected at every grade', () => {
    for (const grade of [1, 2, 3] as const) {
      expect(shouldRedactCategory('credential', grade)).toBe(true);
      expect(shouldRedactCategory('government-id', grade)).toBe(true);
      expect(shouldRedactCategory('financial', grade)).toBe(true);
      expect(shouldRedactCategory('biometric', grade)).toBe(true);
      expect(shouldRedactCategory('custom', grade)).toBe(true);
      expect(shouldRedactCategory('uninspectable', grade)).toBe(true);
    }
  });

  it('progressively expands protection while allowing names below Grade 3', () => {
    expect(shouldRedactFinding('NAME', 1)).toBe(false);
    expect(shouldRedactFinding('NAME', 2)).toBe(false);
    expect(shouldRedactFinding('NAME', 3)).toBe(true);
    expect(shouldRedactFinding('EMAIL', 1)).toBe(false);
    expect(shouldRedactFinding('EMAIL', 2)).toBe(true);
    expect(shouldRedactFinding('USERNAME', 2)).toBe(false);
    expect(shouldRedactFinding('USERNAME', 3)).toBe(true);
    expect(CATEGORY_MINIMUM_GRADE['unknown-populated-field']).toBe(3);
  });

  it('protects a custom value and critical identifier inside a generic field at lower grades', () => {
    expect(inputValueNeedsMask('text', 'Local-only private value', ['Local-only private value'], 1)).toBe(true);
    expect(inputValueNeedsMask('text', 'PAN ABCDE1234F', [], 1)).toBe(true);
    expect(inputValueNeedsMask('text', 'Meera Rao', [], 1)).toBe(false);
    expect(inputValueNeedsMask('text', 'Meera Rao', [], 2)).toBe(false);
    expect(inputValueNeedsMask('text', 'Meera Rao', [], 3)).toBe(true);
  });

  it('uses the same grade for structured fields and free text', () => {
    expect(classifySensitiveField({ autocomplete: 'email' })).toBe('contact');
    expect(isSensitiveField({ autocomplete: 'email' }, 1)).toBeNull();
    expect(isSensitiveField({ autocomplete: 'email' }, 2)).toBe('sensitive-field');
    expect(isSensitiveField({ type: 'password' }, 1)).toBe('password');
    expect(sanitizeText('Name: Meera Rao; Email: meera@example.in', [], 300, 1)).toBe('Name: Meera Rao; Email: meera@example.in');
    expect(sanitizeText('Name: Meera Rao; Email: meera@example.in', [], 300, 3)).toContain('[REDACTED:NAME]');
  });

  it('serializes only durable grade preferences and never secrets', () => {
    const persisted = serializePersistedSettings({
      endpoint: 'http://127.0.0.1:8765/v1/reason',
      apiKey: 'do-not-store',
      task: 'private task',
      maxSteps: 10,
      privacyGrade: 2,
      allowFullMaskFallback: false,
      canaries: ['private value'],
    });
    expect(persisted).toEqual({
      endpoint: 'http://127.0.0.1:8765/v1/reason',
      maxSteps: 10,
      privacyGrade: 2,
      allowFullMaskFallback: false,
    });
    expect(JSON.stringify(persisted)).not.toContain('do-not-store');
    expect(JSON.stringify(persisted)).not.toContain('private value');
  });
});
