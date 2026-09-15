import type { Bounds, RedactionKind } from './types';
import {
  CATEGORY_MINIMUM_GRADE,
  categoryForFinding,
  shouldRedactCategory,
  shouldRedactFinding,
  type PrivacyCategory,
  type PrivacyGrade,
} from './privacy-policy';

export type TextFinding = Readonly<{
  start: number;
  end: number;
  kind: string;
}>;

const PATTERNS: readonly Readonly<{ kind: string; regex: RegExp }>[] = [
  { kind: 'SECRET', regex: /\b(?:password|passcode|one[- ]time (?:code|password)|otp|(?:login|transaction|security|atm|upi) pin|pin (?:number|code)|cvv|cvc|security code|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|auth(?:entication)?[-_ ]?token|private key|recovery code)\s*[:=-]\s*[^\s,;]{3,200}/giu },
  { kind: 'EMAIL', regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu },
  { kind: 'AADHAAR', regex: /(?<![+\d])(?:\d[ -]?){11}\d(?!\d)/gu },
  { kind: 'PAN', regex: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/giu },
  { kind: 'CARD', regex: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/gu },
  { kind: 'SSN', regex: /\b\d{3}-\d{2}-\d{4}\b/gu },
  { kind: 'BANK_ACCOUNT', regex: /\b(?:bank )?account(?: number| no\.?| #)?\s*[:=-]\s*[A-Z0-9 -]{6,34}/giu },
  { kind: 'UPI', regex: /\bupi(?: id)?\s*[:=-]\s*[A-Z0-9._-]{2,256}@[A-Z][A-Z0-9.-]{1,63}\b/giu },
  { kind: 'IFSC', regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/giu },
  { kind: 'GSTIN', regex: /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/giu },
  { kind: 'IMEI', regex: /\b\d{15}\b/gu },
  { kind: 'MAC', regex: /(?:[A-F0-9]{2}:){5}[A-F0-9]{2}/giu },
  { kind: 'IPV6', regex: /\b(?:[A-F\d]{1,4}:){2,7}[A-F\d]{1,4}\b/giu },
  { kind: 'VEHICLE', regex: /\b[A-Z]{2}[ -]?\d{1,2}[ -]?[A-Z]{1,3}[ -]?\d{4}\b/giu },
  { kind: 'PHONE', regex: /(?<!\d)(?:\+?91[ -]?)?[6-9]\d{4}[ -]?\d{5}(?!\d)/gu },
  { kind: 'IP', regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu },
  { kind: 'DOB', regex: /\b(?:dob|date of birth|birth date)\s*[:=-]\s*(?:\d{1,2}[\/-]){2}\d{2,4}\b/giu },
  { kind: 'PASSPORT', regex: /\b(?:passport(?: number| no\.?)?)\s*[:=-]\s*[A-Z][1-9][0-9]{6}\b/giu },
  { kind: 'NAME', regex: /\b(?:full name|customer name|passenger name|name)\s*[:=-]\s*[\p{L}][\p{L}.' -]{2,80}/giu },
  { kind: 'USERNAME', regex: /\b(?:user ?name|login id)\s*[:=-]\s*[A-Z0-9._@-]{2,80}/giu },
  { kind: 'EMPLOYEE_ID', regex: /\b(?:employee|staff|personnel)\s*(?:id|code|number|no\.?)\s*[:=-]\s*[A-Z0-9._/-]{2,80}/giu },
  { kind: 'ACCOUNT_ID', regex: /\b(?:customer|member|subscriber|account)\s*(?:id|code|number|no\.?)\s*[:=-]\s*[A-Z0-9._/-]{2,80}/giu },
  { kind: 'ADDRESS', regex: /\b(?:residential address|postal address|home address|address)\s*[:=-]\s*[^\r\n]{5,120}/giu },
];

export function detectPii(text: string, knownValues: readonly string[] = []): TextFinding[] {
  const findings: TextFinding[] = [];
  for (const { kind, regex } of PATTERNS) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      if (match.index !== undefined) findings.push({ start: match.index, end: match.index + match[0].length, kind });
    }
  }
  for (const known of knownValues) {
    const needle = known.trim();
    if (needle.length < 3) continue;
    let offset = 0;
    const haystack = text.toLocaleLowerCase();
    const normalized = needle.toLocaleLowerCase();
    while ((offset = haystack.indexOf(normalized, offset)) !== -1) {
      findings.push({ start: offset, end: offset + needle.length, kind: 'KNOWN' });
      offset += needle.length;
    }
  }
  // Resolve overlaps by protection priority, rather than by detector order.
  // A broad Grade 3 label (for example `Username: ...`) must never hide a
  // narrower invariant or Grade 2 match (for example an email address).
  // Grade filtering happens before this function's result is consumed, while
  // priority remains useful for the full detector result and pixel redaction.
  const priority = (kind: string): number => {
    const category = categoryForFinding(kind);
    return CATEGORY_MINIMUM_GRADE[category];
  };
  const ordered = findings.sort((a, b) =>
    a.start - b.start || priority(a.kind) - priority(b.kind) ||
    (b.end - b.start) - (a.end - a.start),
  );
  const accepted: TextFinding[] = [];
  for (const candidate of ordered) {
    const overlaps = accepted.filter((item) => item.start < candidate.end && candidate.start < item.end);
    if (overlaps.length === 0) {
      accepted.push(candidate);
      continue;
    }
    const strongest = Math.min(...overlaps.map((item) => priority(item.kind)));
    if (priority(candidate.kind) < strongest) {
      for (const item of overlaps) accepted.splice(accepted.indexOf(item), 1);
      accepted.push(candidate);
    }
  }
  return accepted.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function findingsForGrade(text: string, knownValues: readonly string[], grade: PrivacyGrade): TextFinding[] {
  return detectPii(text, knownValues).filter((finding) => shouldRedactFinding(finding.kind, grade));
}

export function sanitizeText(
  text: string,
  knownValues: readonly string[] = [],
  maxLength = 300,
  privacyGrade: PrivacyGrade = 3,
): string {
  const clipped = text.replace(/\s+/gu, ' ').trim().slice(0, maxLength);
  const findings = findingsForGrade(clipped, knownValues, privacyGrade);
  if (findings.length === 0) return clipped;
  let result = '';
  let cursor = 0;
  for (const finding of findings) {
    result += clipped.slice(cursor, finding.start);
    result += `[REDACTED:${finding.kind}]`;
    cursor = finding.end;
  }
  return result + clipped.slice(cursor);
}

export type FieldPrivacyInput = Readonly<{
  type?: string | undefined;
  autocomplete?: string | undefined;
  name?: string | undefined;
  id?: string | undefined;
  placeholder?: string | undefined;
  ariaLabel?: string | undefined;
}>;

export function classifySensitiveField(input: FieldPrivacyInput): PrivacyCategory | null {
  const type = (input.type ?? '').toLowerCase();
  if (type === 'password') return 'credential';
  if (type === 'email' || type === 'tel') return 'contact';

  const autocomplete = (input.autocomplete ?? '').toLowerCase();
  if (/current-password|new-password|one-time-code/u.test(autocomplete)) return 'credential';
  if (/\bcc-|transaction-/u.test(autocomplete)) return 'financial';
  if (/\bemail\b|\btel(?:-|\b)/u.test(autocomplete)) return 'contact';
  if (/street-address|address-line|postal-code|country|locality/u.test(autocomplete)) return 'location';
  if (/\bbday(?:-|\b)/u.test(autocomplete)) return 'date-of-birth';
  if (/\busername\b/u.test(autocomplete)) return 'username';
  if (/\b(?:name|given-name|additional-name|family-name|nickname)\b/u.test(autocomplete)) return 'name';

  const metadata = [input.name, input.id, input.placeholder, input.ariaLabel]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/gu, ' ');
  if (/pass(?:word|code)|\bsecret\b|api.?key|access.?token|refresh.?token|auth(?:entication)?.?token|private.?key|recovery.?code|one.?time.?code|\botp\b|\bcvv\b|\bcvc\b|security.?code|(?:login|transaction|security|atm|upi)?.?\bpin\b/u.test(metadata)) return 'credential';
  if (/aadhaar|aadhar|pan.?number|passport|\bssn\b|social.?security/u.test(metadata)) return 'government-id';
  if (/credit.?card|debit.?card|card.?number|cc.?number|bank.?account|account.?number|routing.?number|\biban\b|\bupi\b|\bifsc\b/u.test(metadata)) return 'financial';
  if (/e.?mail|phone|mobile|telephone|contact.?number/u.test(metadata)) return 'contact';
  if (/street.?address|postal.?address|home.?address|residential.?address|postal.?code|\bpincode\b/u.test(metadata)) return 'location';
  if (/date.?of.?birth|birth.?date|\bdob\b/u.test(metadata)) return 'date-of-birth';
  if (/ip.?address/u.test(metadata)) return 'network';
  if (/(?:customer|member|subscriber).?(?:id|code|number|no\b)/u.test(metadata)) return 'account-id';
  if (/(?:employee|staff|personnel).?(?:id|code|number|no\b)/u.test(metadata)) return 'professional-id';
  if (/\buser.?name\b|\blogin.?id\b/u.test(metadata)) return 'username';
  if (/^(?:full |customer |employee |passenger |account holder )?name\b/u.test(metadata.trim())) return 'name';
  return null;
}

export function isSensitiveField(input: FieldPrivacyInput, privacyGrade: PrivacyGrade = 3): RedactionKind | null {
  const category = classifySensitiveField(input);
  if (!category || !shouldRedactCategory(category, privacyGrade)) return null;
  return (input.type ?? '').toLowerCase() === 'password' ? 'password' : 'sensitive-field';
}

export function pseudoContentNeedsMask(beforeContent: string, afterContent: string): boolean {
  return [beforeContent, afterContent].some((content) => {
    const normalized = content.trim().toLowerCase();
    return normalized !== '' && normalized !== 'none' && normalized !== 'normal' && normalized !== '""' && normalized !== "''";
  });
}

export function classifySensitiveTextLabel(value: string): PrivacyCategory | null {
  const label = value.replace(/\s+/gu, ' ').trim().toLowerCase().replace(/[:\-]$/u, '').trim();
  if (/^(?:password|passcode|secret|token|api key|api token|access token|refresh token|otp|one time code|pin|cvv|cvc|security code)$/u.test(label)) return 'credential';
  if (/^(?:pan|pan number|aadhaar|aadhar|passport|passport number|ssn|social security number)$/u.test(label)) return 'government-id';
  if (/^(?:card|card number|credit card|debit card|account number|bank account|bank account number|upi|upi id|ifsc|iban)$/u.test(label)) return 'financial';
  if (/^(?:email|e-mail|phone|mobile|telephone|contact number)$/u.test(label)) return 'contact';
  if (/^(?:address|home address|postal address|residential address|postal code|pincode)$/u.test(label)) return 'location';
  if (/^(?:date of birth|dob|birth date)$/u.test(label)) return 'date-of-birth';
  if (/^(?:ip|ip address)$/u.test(label)) return 'network';
  if (/^(?:customer|member|subscriber) (?:id|code|number)$/u.test(label)) return 'account-id';
  if (/^(?:full |customer |employee |passenger |account holder )?name$/u.test(label)) return 'name';
  if (/^(?:username|user name|login id)$/u.test(label)) return 'username';
  if (/^(?:employee|staff|personnel) (?:id|code|number)$/u.test(label)) return 'professional-id';
  return null;
}

export function isSensitiveTextLabel(value: string, privacyGrade: PrivacyGrade = 3): boolean {
  const category = classifySensitiveTextLabel(value);
  return category !== null && shouldRedactCategory(category, privacyGrade);
}

export function inputValueNeedsMask(
  type: string,
  value: string,
  knownValues: readonly string[] = [],
  privacyGrade: PrivacyGrade = 3,
): boolean {
  const normalizedType = type.toLowerCase();
  if (!value || ['checkbox', 'radio', 'button', 'submit', 'reset', 'hidden', 'image'].includes(normalizedType)) return false;
  if (normalizedType === 'password') return true;
  if (findingsForGrade(value, knownValues, privacyGrade).length > 0) return true;
  return shouldRedactCategory('unknown-populated-field', privacyGrade);
}

export function mergeBounds(items: readonly Bounds[]): Bounds[] {
  const result: { x: number; y: number; width: number; height: number }[] = [];
  for (const item of items) {
    if (item.width <= 0 || item.height <= 0) continue;
    const existing = result.find((candidate) => overlaps(candidate, item));
    if (!existing) {
      result.push({ ...item });
      continue;
    }
    const right = Math.max(existing.x + existing.width, item.x + item.width);
    const bottom = Math.max(existing.y + existing.height, item.y + item.height);
    existing.x = Math.min(existing.x, item.x);
    existing.y = Math.min(existing.y, item.y);
    existing.width = right - existing.x;
    existing.height = bottom - existing.y;
  }
  return result;
}

function overlaps(a: Bounds, b: Bounds): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

const UNSAFE_KEYS = new Set([
  'html',
  'innerhtml',
  'outerhtml',
  'textcontent',
  'value',
  'password',
  'cookie',
  'cookies',
  'localstorage',
  'sessionstorage',
  'screenshot',
  'dataurl',
  'raw',
  'rawdom',
  'accessibilitytree',
]);

export function assertNoUnsafeKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoUnsafeKeys(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key.toLowerCase())) throw new Error(`Unsafe outbound field: ${key}`);
    assertNoUnsafeKeys(child);
  }
}

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function assertNoCanaries(serialized: string, canaries: readonly string[]): void {
  const haystack = serialized.toLocaleLowerCase();
  for (const raw of canaries) {
    const value = raw.trim();
    if (value.length < 3) continue;
    const forms = [value, encodeURIComponent(value), utf8Base64(value)];
    for (const form of forms) {
      if (haystack.includes(form.toLocaleLowerCase())) throw new Error('Outbound privacy canary detected');
    }
  }
}

export async function pseudonymizeOrigin(origin: string, key: CryptoKey): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(origin));
  const alias = Array.from(new Uint8Array(signature).slice(0, 10), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `https://site-${alias}.invalid`;
}
