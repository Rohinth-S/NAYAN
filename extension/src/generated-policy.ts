/** Generated policy registry. Do not edit by hand. */
export const PROTOCOL_VERSION = '1.0' as const;
export const REGISTRY_VERSION = '1.1.0' as const;
export const REGISTRY_DIGEST = 'sha256:839a8d0a22a6b6f44e0645f64685121d894237405ef9bebdc4bb43e063aa449e' as const;
export const MINIMUM_GRADES = {
  'credential': 1,
  'government-id': 1,
  'financial': 1,
  'biometric': 1,
  'custom': 1,
  'uninspectable': 1,
  'contact': 2,
  'location': 2,
  'date-of-birth': 2,
  'network': 2,
  'account-id': 2,
  'name': 3,
  'username': 3,
  'professional-id': 3,
  'unknown-populated-field': 3,
} as const;
export const INVARIANT_CATEGORIES = [
  'credential',
  'government-id',
  'financial',
  'biometric',
  'custom',
  'uninspectable',
] as const;
