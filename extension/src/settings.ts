import { normalizePrivacyGrade } from './privacy-policy';
import type { ExtensionSettings } from './types';

export const PERSISTED_SETTING_KEYS = ['endpoint', 'maxSteps', 'allowFullMaskFallback', 'privacyGrade'] as const;

export type PersistedSettings = Readonly<Pick<
  ExtensionSettings,
  'endpoint' | 'maxSteps' | 'allowFullMaskFallback' | 'privacyGrade'
>>;

/** Store only durable, non-secret preferences. Tasks, API keys and canaries stay in memory. */
export function serializePersistedSettings(settings: ExtensionSettings): PersistedSettings {
  return {
    endpoint: settings.endpoint,
    maxSteps: settings.maxSteps,
    allowFullMaskFallback: settings.allowFullMaskFallback,
    privacyGrade: normalizePrivacyGrade(settings.privacyGrade),
  };
}
