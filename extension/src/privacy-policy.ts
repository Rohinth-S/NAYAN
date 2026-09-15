/** User-selectable privacy policy. A category is hidden when its threshold is
 * less than or equal to the selected grade. Grade 3 is the fail-safe default. */
export const PRIVACY_GRADES = [1, 2, 3] as const;
export type PrivacyGrade = (typeof PRIVACY_GRADES)[number];

export type PrivacyCategory =
  | 'credential'
  | 'government-id'
  | 'financial'
  | 'biometric'
  | 'custom'
  | 'uninspectable'
  | 'contact'
  | 'location'
  | 'date-of-birth'
  | 'network'
  | 'account-id'
  | 'name'
  | 'username'
  | 'professional-id'
  | 'unknown-populated-field';

export const DEFAULT_PRIVACY_GRADE: PrivacyGrade = 3;

/**
 * Grade 1: irreversible/high-impact data and anything that cannot be inspected.
 * Grade 2: Grade 1 plus contact, location and linkable contextual identifiers.
 * Grade 3: Grade 2 plus identity labels and unknown populated form values.
 */
export const CATEGORY_MINIMUM_GRADE: Readonly<Record<PrivacyCategory, PrivacyGrade>> = Object.freeze({
  credential: 1,
  'government-id': 1,
  financial: 1,
  biometric: 1,
  custom: 1,
  uninspectable: 1,
  contact: 2,
  location: 2,
  'date-of-birth': 2,
  network: 2,
  'account-id': 2,
  name: 3,
  username: 3,
  'professional-id': 3,
  'unknown-populated-field': 3,
});

export function isPrivacyGrade(value: unknown): value is PrivacyGrade {
  return value === 1 || value === 2 || value === 3;
}

export function normalizePrivacyGrade(value: unknown): PrivacyGrade {
  return isPrivacyGrade(value) ? value : DEFAULT_PRIVACY_GRADE;
}

export function shouldRedactCategory(category: PrivacyCategory, grade: PrivacyGrade): boolean {
  return CATEGORY_MINIMUM_GRADE[category] <= grade;
}

const FINDING_CATEGORIES: Readonly<Record<string, PrivacyCategory>> = Object.freeze({
  SECRET: 'credential',
  AADHAAR: 'government-id',
  PAN: 'government-id',
  PASSPORT: 'government-id',
  SSN: 'government-id',
  CARD: 'financial',
  BANK_ACCOUNT: 'financial',
  UPI: 'financial',
  IFSC: 'financial',
  GSTIN: 'financial',
  VEHICLE: 'government-id',
  IMEI: 'network',
  MAC: 'network',
  IPV6: 'network',
  KNOWN: 'custom',
  EMAIL: 'contact',
  PHONE: 'contact',
  ADDRESS: 'location',
  DOB: 'date-of-birth',
  IP: 'network',
  ACCOUNT_ID: 'account-id',
  NAME: 'name',
  USERNAME: 'username',
  EMPLOYEE_ID: 'professional-id',
  VISUAL_FALLBACK: 'uninspectable',
  FACE: 'biometric',
  UNINSPECTABLE_FRAME: 'uninspectable',
  UNINSPECTABLE_MEDIA: 'uninspectable',
  face: 'biometric',
  'uninspectable-frame': 'uninspectable',
  'uninspectable-media': 'uninspectable',
  'visual-fallback': 'uninspectable',
});

export function categoryForFinding(kind: string): PrivacyCategory {
  // Newly added detectors fail closed at Grade 3 until the policy explicitly
  // assigns them a lower threshold.
  return FINDING_CATEGORIES[kind] ?? 'unknown-populated-field';
}

export function shouldRedactFinding(kind: string, grade: PrivacyGrade): boolean {
  return shouldRedactCategory(categoryForFinding(kind), grade);
}
