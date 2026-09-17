import { assertNoCanaries, findingsForGrade } from './privacy';
import type { SanitizedObservation } from './types';

/**
 * Last-mile local DLP gate. User-controlled text fields are classified again
 * immediately before egress. Structural fields (UUIDs, bounds, enum values,
 * and detector metadata) are validated by `validateObservation` and are not
 * treated as free text: serializing those fields and running PII regexes over
 * them creates false positives from coordinates, IDs, and schema keys. The
 * complete payload is still scanned for configured canaries below and again
 * by the egress gateway.
 */
export function assertFinalDlpClear(
  observation: SanitizedObservation,
  canaries: readonly string[],
): void {
  const textFields = [
    observation.page.title,
    observation.task,
    ...observation.elements.map(element => element.label),
  ];
  assertNoCanaries(JSON.stringify(observation), canaries);
  const suspicious = findingsForGrade(textFields.join('\n'), canaries, observation.privacy.grade);
  if (suspicious.length > 0) throw new Error('Final local DLP gate blocked outbound metadata');
}

export const dlpInternals = { assertFinalDlpClear };
