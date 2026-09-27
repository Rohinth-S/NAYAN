/** Local-only matching rules for transferring values between selected tabs. */

export function normalizedTransferLabel(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
}

export function transferLabelKey(value: string): string {
  const normalized = normalizedTransferLabel(value);
  if (/\b(?:e mail|email)\b/u.test(normalized)) return 'email';
  if (/\b(?:phone|mobile|telephone)(?: number)?\b/u.test(normalized)) return 'phone';
  if (/\b(?:home|postal|residential|street) address\b|^address$/u.test(normalized)) return 'address';
  if (/\bcity\b|\blocality\b/u.test(normalized)) return 'city';
  if (/\b(?:date of birth|birth date|dob)\b/u.test(normalized)) return 'date-of-birth';
  if (/\b(?:full|preferred|given|family) name\b|^name$/u.test(normalized)) return 'name';
  if (/\b(?:employee|staff|personnel) (?:id|code|number)\b/u.test(normalized)) return 'employee-id';
  if (/\b(?:customer|member|subscriber) (?:id|code|number)\b/u.test(normalized)) return 'account-id';
  return normalized;
}

export function transferLabelMatches(source: string, target: string): boolean {
  const left = normalizedTransferLabel(source);
  const right = normalizedTransferLabel(target);
  if (!left || !right) return false;
  if (left === right) return true;
  const sourceKey = transferLabelKey(left);
  return sourceKey === transferLabelKey(right);
}
