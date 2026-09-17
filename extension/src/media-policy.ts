/**
 * Local media classification hints used by the DOM collector.
 *
 * The default is deliberately `unknown`, which remains fail-closed and is
 * masked as opaque media. A page may provide a semantic hint for a known
 * public object fixture, while document and person media continue through the
 * normal local OCR/face-redaction paths.
 */
export type MediaKind = 'document' | 'person' | 'object' | 'unknown';
export type DocumentMediaType = 'aadhaar-card' | 'pan-card' | 'credit-card' | 'unknown';

const DOCUMENT_HINT = /\b(?:aadhaar|aadhar|uidai|pan\s*card|credit\s*card|debit\s*card|identity\s*(?:card|document)|passport|voter(?:\s|-)?id|driving\s*licen[cs]e|government\s*id|document)\b/iu;
const PERSON_HINT = /\b(?:person|portrait|profile\s*photo|face|selfie|human|headshot)\b/iu;

/**
 * A public object is only preserved when the page opts in with an explicit
 * `data-privacy-media-kind="object"` (or equivalent) marker. This prevents a
 * missing/ambiguous alt string from silently turning into an unredacted image.
 */
const OBJECT_HINT = /\b(?:object|product|landscape|diagram|illustration|logo|icon|public\s*image)\b/iu;

function explicitKind(element: Element): MediaKind | null {
  const value = [
    element.getAttribute('data-privacy-media-kind'),
    element.getAttribute('data-sih-media-kind'),
    element.getAttribute('data-privacy-kind'),
  ].find(Boolean)?.trim().toLowerCase();
  if (!value) return null;
  if (value === 'document' || value === 'person' || value === 'object') return value;
  return 'unknown';
}

function semanticText(element: Element): string {
  const source = element.getAttribute('src') ?? element.getAttribute('data') ?? '';
  const alt = element.getAttribute('alt') ?? '';
  const title = element.getAttribute('title') ?? '';
  const aria = element.getAttribute('aria-label') ?? '';
  return `${alt} ${title} ${aria} ${source}`.replace(/\s+/gu, ' ').trim();
}

/**
 * Return only a coarse, non-content document hint for the local OCR pass.
 * The hint is never included in the sanitized observation. It improves OCR
 * classification for synthetic or clearly labelled fixtures whose rendered
 * typography may omit words such as “credit”.
 */
export function classifyDocumentType(element: Element): DocumentMediaType {
  const explicit = [
    element.getAttribute('data-privacy-document-type'),
    element.getAttribute('data-sih-document-type'),
  ].find(Boolean)?.trim().toLowerCase();
  if (explicit === 'aadhaar' || explicit === 'aadhar' || explicit === 'aadhaar-card') return 'aadhaar-card';
  if (explicit === 'pan' || explicit === 'pan-card') return 'pan-card';
  if (explicit === 'credit' || explicit === 'credit-card' || explicit === 'debit-card') return 'credit-card';

  const text = semanticText(element);
  if (/\b(?:aadhaar|aadhar|uidai)\b/iu.test(text)) return 'aadhaar-card';
  if (/\b(?:pan\s*card|permanent\s+account\s+number|income\s+tax)\b/iu.test(text)) return 'pan-card';
  if (/\b(?:credit|debit)\s+card\b/iu.test(text)) return 'credit-card';
  return 'unknown';
}

export function classifyMediaElement(element: Element): MediaKind {
  const direct = explicitKind(element);
  if (direct) return direct;

  // `<picture>` and custom media wrappers often carry the hint on their
  // descendant image. Prefer an explicit child marker over wrapper prose.
  for (const child of Array.from(element.querySelectorAll('img, source'))) {
    const childKind = explicitKind(child);
    if (childKind) return childKind;
  }

  const text = semanticText(element);
  if (DOCUMENT_HINT.test(text)) return 'document';
  if (PERSON_HINT.test(text)) return 'person';
  // Semantic object words are only a best-effort classification. They do not
  // override a document/person match and are primarily useful for the demo's
  // clearly labelled, synthetic product fixture.
  if (OBJECT_HINT.test(text) && element.hasAttribute('data-privacy-media-kind')) return 'object';
  return 'unknown';
}

export const mediaPolicyInternals = {
  explicitKind,
  semanticText,
  classifyMediaElement,
  classifyDocumentType,
};
