import { normalizePrivacyGrade } from './privacy-policy';
import type { ExtensionSettings } from './types';

export const PERSISTED_SETTING_KEYS = ['endpoint', 'maxSteps', 'allowFullMaskFallback', 'highAssuranceMode', 'autoApproveLocalDemo', 'privacyGrade'] as const;

export type PersistedSettings = Readonly<Pick<
  ExtensionSettings,
  'endpoint' | 'maxSteps' | 'allowFullMaskFallback' | 'highAssuranceMode' | 'autoApproveLocalDemo' | 'privacyGrade'
>>;

/** Store only durable, non-secret preferences. Tasks, API keys and canaries stay in memory. */
export function serializePersistedSettings(settings: ExtensionSettings): PersistedSettings {
  return {
    endpoint: settings.endpoint,
    maxSteps: settings.maxSteps,
    allowFullMaskFallback: settings.allowFullMaskFallback,
    highAssuranceMode: settings.highAssuranceMode,
    autoApproveLocalDemo: settings.autoApproveLocalDemo,
    privacyGrade: normalizePrivacyGrade(settings.privacyGrade),
  };
}
