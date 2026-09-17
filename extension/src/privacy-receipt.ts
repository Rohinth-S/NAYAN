import type { PrivacyReceipt, SanitizedObservation } from './types';

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytesFromBase64(value));
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function categoryCounts(observation: SanitizedObservation): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const redaction of observation.redactions) counts[redaction.kind] = (counts[redaction.kind] ?? 0) + 1;
  return counts;
}

export async function createPrivacyReceipt(
  observation: SanitizedObservation,
  maskedAreaPercentage: number,
  transmissionMode: PrivacyReceipt['transmissionMode'],
  requestCount: number,
  sent: boolean,
): Promise<PrivacyReceipt> {
  return {
    requestCount: Math.max(0, Math.floor(requestCount)),
    privacyGrade: observation.privacy.grade,
    detectorBackend: observation.privacy.detectorBackend,
    redactionCategories: categoryCounts(observation),
    maskedAreaPercentage: Math.min(100, Math.max(0, Math.round(maskedAreaPercentage))),
    imageSha256: await sha256Base64(observation.image.dataBase64),
    redactionMode: observation.privacy.redactionMode ?? 'opaque',
    transmissionMode,
    sent,
  };
}

export function markPrivacyReceiptSent(receipt: PrivacyReceipt, requestCount: number): PrivacyReceipt {
  return { ...receipt, requestCount: Math.max(receipt.requestCount, Math.floor(requestCount)), sent: true };
}

export const privacyReceiptInternals = { bytesFromBase64, sha256Base64, categoryCounts };
