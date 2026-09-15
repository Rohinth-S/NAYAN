import { describe, expect, it } from 'vitest';
import { assertNoCanaries, assertNoUnsafeKeys, detectPii, inputValueNeedsMask, isSensitiveField, isSensitiveTextLabel, pseudoContentNeedsMask, pseudonymizeOrigin, sanitizeText } from '../src/privacy';

describe('local text privacy filter', () => {
  it('preserves ordinary checkbox and radio visuals while masking populated text inputs', () => {
    expect(inputValueNeedsMask('checkbox', 'on')).toBe(false);
    expect(inputValueNeedsMask('radio', 'selected')).toBe(false);
    expect(inputValueNeedsMask('text', 'private value')).toBe(true);
    expect(inputValueNeedsMask('password', 'secret')).toBe(true);
    expect(inputValueNeedsMask('text', '')).toBe(false);
  });

  it('recognizes sensitive profile labels without masking unrelated public labels', () => {
    expect(isSensitiveTextLabel('Name')).toBe(true);
    expect(isSensitiveTextLabel('Email:')).toBe(true);
    expect(isSensitiveTextLabel('Date of birth')).toBe(true);
    expect(isSensitiveTextLabel('Employee code')).toBe(true);
    expect(isSensitiveTextLabel('Plan name')).toBe(false);
    expect(isSensitiveTextLabel('Enrollment status')).toBe(false);
  });

  it('detects and replaces the SIH PII classes before serialization', () => {
    const raw = 'Email dev@example.in, PAN ABCDE1234F, Aadhaar 1234 5678 9012, phone +91 98765 43210';
    const sanitized = sanitizeText(raw, [], 1_000);
    expect(sanitized).not.toContain('dev@example.in');
    expect(sanitized).not.toContain('ABCDE1234F');
    expect(sanitized).not.toContain('1234 5678 9012');
    expect(sanitized).not.toContain('98765 43210');
    expect(sanitized).toContain('[REDACTED:EMAIL]');
    expect(detectPii(raw).length).toBeGreaterThanOrEqual(4);
  });

  it('redacts caller-provided private values without case sensitivity', () => {
    expect(sanitizeText('Welcome, Meera Rao', ['meera rao'])).toBe('Welcome, [REDACTED:KNOWN]');
  });

  it('detects sensitive values before clipping the sanitized text', () => {
    const sanitized = sanitizeText('Prefix alice@example.com', [], 12, 2);
    expect(sanitized).not.toContain('alice');
    expect(sanitized).not.toContain('@example.com');
  });

  it('detects labeled name, address, date-of-birth, and passport lines', () => {
    const raw = [
      'Full Name: Meera Rao',
      'Address: 14 Lake View Road, Pune',
      'DOB: 17/08/2002',
      'Passport No: Z1234567',
    ].join('\n');
    const kinds = detectPii(raw).map((finding) => finding.kind);
    expect(kinds).toEqual(expect.arrayContaining(['NAME', 'ADDRESS', 'DOB', 'PASSPORT']));
  });

  it('keeps the most protective category when findings overlap', () => {
    const findings = detectPii('Username: dev@example.in');
    expect(findings.map((finding) => finding.kind)).toEqual(expect.arrayContaining(['EMAIL']));
    expect(sanitizeText('Username: dev@example.in', [], 300, 2)).toContain('[REDACTED:EMAIL]');
    expect(sanitizeText('Username: dev@example.in', [], 300, 2)).not.toContain('dev@example.in');
  });

  it('keeps invariant and Grade 2 matches inside broad labeled values', () => {
    const findings = detectPii('Name: +91 98765 43210, Account Number: 1234567890');
    expect(findings.map((finding) => finding.kind)).toEqual(expect.arrayContaining(['PHONE', 'BANK_ACCOUNT']));
    expect(sanitizeText('Name: +91 98765 43210', [], 300, 2)).not.toContain('98765 43210');
  });

  it('covers additional Indian and device identifiers conservatively', () => {
    const raw = 'GSTIN 27ABCDE1234F1Z5 IMEI 490154203237518 MAC  AA:BB:CC:DD:EE:FF vehicle MH12AB1234';
    const sanitized = sanitizeText(raw, [], 500, 1);
    expect(sanitized).not.toContain('27ABCDE1234F1Z5');
    expect(sanitized).not.toContain('490154203237518');
    expect(sanitized).not.toContain('MH12AB1234');
  });

  it('classifies structured sensitive fields', () => {
    expect(isSensitiveField({ type: 'password' })).toBe('password');
    expect(isSensitiveField({ autocomplete: 'cc-number' })).toBe('sensitive-field');
    expect(isSensitiveField({ ariaLabel: 'Mobile number' })).toBe('sensitive-field');
    expect(isSensitiveField({ name: 'search' })).toBeNull();
  });

  it('recognizes label-based credentials and payment identifiers', () => {
    expect(isSensitiveField({ ariaLabel: 'OTP code' }, 1)).toBe('sensitive-field');
    expect(isSensitiveField({ name: 'upi_id' }, 1)).toBe('sensitive-field');
    expect(isSensitiveField({ name: 'full_name' }, 1)).toBeNull();
    expect(isSensitiveField({ name: 'full_name' }, 3)).toBe('sensitive-field');
  });

  it('treats generated pseudo-element text as visually uninspectable', () => {
    expect(pseudoContentNeedsMask('"Account 123"', 'none')).toBe(true);
    expect(pseudoContentNeedsMask('normal', 'none')).toBe(false);
    expect(pseudoContentNeedsMask('""', "''")).toBe(false);
  });

  it('blocks unsafe structural fields recursively', () => {
    expect(() => assertNoUnsafeKeys({ elements: [{ innerHTML: '<b>secret</b>' }] })).toThrow('Unsafe outbound field');
    expect(() => assertNoUnsafeKeys({ task: 'safe', elements: [] })).not.toThrow();
  });

  it('finds raw, URL-encoded, and base64 privacy canaries', () => {
    expect(() => assertNoCanaries('{"label":"secret name"}', ['secret name'])).toThrow('canary');
    expect(() => assertNoCanaries('{"label":"secret%20name"}', ['secret name'])).toThrow('canary');
    expect(() => assertNoCanaries('{"label":"c2VjcmV0IG5hbWU="}', ['secret name'])).toThrow('canary');
    expect(() => assertNoCanaries('{"label":"[REDACTED:KNOWN]"}', ['secret name'])).not.toThrow();
  });

  it('replaces a browsing origin with a stable keyed alias', async () => {
    const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const first = await pseudonymizeOrigin('https://medical.example', key);
    const second = await pseudonymizeOrigin('https://medical.example', key);
    expect(first).toBe(second);
    expect(first).toMatch(/^https:\/\/site-[0-9a-f]{20}\.invalid$/u);
    expect(first).not.toContain('medical');
  });
});
