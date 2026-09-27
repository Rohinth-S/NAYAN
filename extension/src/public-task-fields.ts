/** Values are extracted only from the user's task, never from page instructions. */
export type PublicTaskField = 'preferredName' | 'workEmail' | 'phoneNumber' | 'city' | 'benefitPlan' | 'startDate' | 'requestedCentre' | 'transferType' | 'effectiveDate';

function taskField(label: string): PublicTaskField {
  if (label.endsWith('name')) return 'preferredName';
  if (label.endsWith('email')) return 'workEmail';
  if (/^(?:phone|mobile)/u.test(label)) return 'phoneNumber';
  if (/requested cent(?:re|er)/u.test(label)) return 'requestedCentre';
  if (label === 'transfer type') return 'transferType';
  if (label === 'effective date') return 'effectiveDate';
  if (label === 'city') return 'city';
  if (label === 'benefit plan') return 'benefitPlan';
  return 'startDate';
}

export function extractPublicTaskFields(task: string): Map<PublicTaskField, string> {
  const markers: Array<{ key: PublicTaskField; start: number; end: number }> = [];
  const pattern = /\b(preferred\s+name|applicant\s+name|work\s+email|official\s+email|(?:phone|mobile)(?:\s+number)?|city|benefit\s+plan|coverage\s+start\s+date|requested\s+cent(?:re|er)|transfer\s+type|effective\s+date)\b\s*(?:(?:is|equals?)\s+|[:=]\s*)?/giu;
  for (const match of task.matchAll(pattern)) {
    if (match.index === undefined || !match[1]) continue;
    markers.push({ key: taskField(match[1].toLowerCase().replace(/\s+/gu, ' ')), start: match.index, end: match.index + match[0].length });
  }
  const values = new Map<PublicTaskField, string>();
  for (let index = 0; index < markers.length; index++) {
    const marker = markers[index]!;
    const next = markers[index + 1]?.start ?? task.length;
    const value = task.slice(marker.end, next).trim()
      .replace(/^[,;:\s]+/u, '')
      .replace(/,?\s+(?:then|and then)\s+(?:check|submit|confirm|review|ask)\b[\s\S]*$/iu, '')
      .replace(/[\s,;.]+$/u, '').trim();
    if (value && value.length <= 200 && !values.has(marker.key)) values.set(marker.key, value);
  }
  return values;
}
