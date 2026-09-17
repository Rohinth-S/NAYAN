import { shouldRedactCategory, type PrivacyGrade } from './privacy-policy';

/** Capture-local values learned from labelled fields; never persisted or sent. */
export type IdentityValue = Readonly<{ value: string; category: 'name' | 'date-of-birth' }>;

export function identityValueVariants(item: IdentityValue): string[] {
  const value = item.value.trim();
  if (item.category === 'date-of-birth') {
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    const local = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/u.exec(value);
    const parts = iso ? [iso[1], iso[2], iso[3]] : local ? [local[3], local[2]!.padStart(2, '0'), local[1]!.padStart(2, '0')] : null;
    if (parts) return [value, `${parts[0]}-${parts[1]}-${parts[2]}`, `${parts[2]}/${parts[1]}/${parts[0]}`, `${parts[2]}-${parts[1]}-${parts[0]}`];
  }
  return [value];
}

export function identityFindings(text: string, values: readonly IdentityValue[], grade: PrivacyGrade): Array<{ start: number; end: number; kind: string }> {
  const findings: Array<{ start: number; end: number; kind: string }> = [];
  for (const item of values) {
    if (!shouldRedactCategory(item.category, grade)) continue;
    for (const value of identityValueVariants(item)) {
      if (value.length < 3 || value.length > 200) continue;
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\s+/gu, '\\s+');
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
      for (const match of text.matchAll(pattern)) {
        const finding = { start: match.index!, end: match.index! + match[0].length, kind: item.category === 'name' ? 'NAME' : 'DOB' };
        if (!findings.some(previous => previous.start === finding.start && previous.end === finding.end)) findings.push(finding);
      }
    }
  }
  return findings.sort((a, b) => a.start - b.start || b.end - a.end);
}

export function sanitizeIdentityValues(text: string, values: readonly IdentityValue[], grade: PrivacyGrade): string {
  let cursor = 0;
  let result = '';
  for (const finding of identityFindings(text, values, grade)) {
    if (finding.start < cursor) continue;
    result += text.slice(cursor, finding.start) + `[REDACTED:${finding.kind}]`;
    cursor = finding.end;
  }
  return result + text.slice(cursor);
}
