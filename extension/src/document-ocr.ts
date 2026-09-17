import { createWorker, PSM, type Worker } from 'tesseract.js';
import { runtimeUrl } from './webext';
import type { Bounds } from './types';
import { shouldRedactCategory, type PrivacyCategory, type PrivacyGrade } from './privacy-policy';

/**
 * This detector is deliberately narrower than the general perception bundle.
 * It is used only for image regions that the DOM collector cannot inspect.
 * The wire protocol receives the resulting boxes and categories, never OCR
 * text or an image crop.
 */
export const DOCUMENT_OCR_VERSION = 'tesseract-eng-credential-v2-contrast';
export const DOCUMENT_OCR_MIN_CONFIDENCE = 0.72;
export const DOCUMENT_OCR_MAX_MEDIA_REGIONS = 8;
export const DOCUMENT_OCR_MAX_PIXELS = 4_194_304;
export const DOCUMENT_OCR_TIMEOUT_MS = 12_000;
export type DocumentOcrWord = Readonly<{
  text: string;
  confidence: number;
  bounds: Bounds;
}>;

export type DocumentOcrLine = Readonly<{
  text: string;
  confidence: number;
  bounds: Bounds;
  words?: readonly DocumentOcrWord[];
}>;

export type DocumentSecret = Readonly<{
  kind: 'aadhaar-card' | 'pan-card' | 'sensitive-field';
  secretType:
    | 'aadhaar-number'
    | 'name'
    | 'date-of-birth'
    | 'gender'
    | 'address'
    | 'mobile'
    | 'pan'
    | 'card-number'
    | 'expiry'
    | 'cvv';
  bounds: Bounds;
  confidence: number;
  mediaBounds: Bounds;
}>;

/** Document identity must not override the category's user-selected grade. */
export const DOCUMENT_FIELD_CATEGORIES: Readonly<Record<DocumentSecret['secretType'], PrivacyCategory>> = {
  'aadhaar-number': 'government-id', pan: 'government-id',
  'card-number': 'financial', expiry: 'financial', cvv: 'credential',
  name: 'name', 'date-of-birth': 'date-of-birth',
  mobile: 'contact', address: 'location', gender: 'unknown-populated-field',
};

export function shouldRedactDocumentSecret(type: DocumentSecret['secretType'], grade: PrivacyGrade): boolean {
  return shouldRedactCategory(DOCUMENT_FIELD_CATEGORIES[type], grade);
}

export function requiredDocumentFields(kind: DocumentClassification['kind'], grade: PrivacyGrade): DocumentSecret['secretType'][] {
  const fields: DocumentSecret['secretType'][] = kind === 'credit-card'
    ? ['card-number', 'expiry', 'cvv', 'name']
    : kind === 'pan-card' ? ['pan', 'name', 'date-of-birth']
    : ['aadhaar-number', 'name', 'date-of-birth', 'gender', 'mobile', 'address'];
  return fields.filter(type => shouldRedactDocumentSecret(type, grade));
}

export type DocumentClassification = Readonly<{
  kind: 'aadhaar-card' | 'credit-card' | 'pan-card';
  bounds: Bounds;
  confidence: number;
}>;

export type DocumentOcrResult = Readonly<{
  documents: readonly DocumentClassification[];
  secrets: readonly DocumentSecret[];
  durationMs: number;
  modelVersion: string;
}>;

/**
 * A coarse, page supplied hint for an image-only document.  This deliberately
 * carries a type and geometry only; it never carries OCR text or the source
 * element.  Hints are advisory and the classifier still requires every
 * credential field before it can narrow a fail-closed media mask.
 */
export type DocumentOcrMediaHint = Readonly<{
  bounds: Bounds;
  documentType?: 'aadhaar-card' | 'pan-card' | 'credit-card' | 'unknown';
}>;

export interface DocumentOcrRuntime {
  scan(
    image: OffscreenCanvas,
    mediaBounds: readonly Bounds[],
    mediaHints?: readonly DocumentOcrMediaHint[],
    privacyGrade?: PrivacyGrade,
  ): Promise<DocumentOcrResult>;
  close(): Promise<void>;
}

type CandidateLine = Readonly<{
  line: DocumentOcrLine;
  mediaBounds: Bounds;
}>;

function compact(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/gu, '');
}

function normalized(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function intersectsMedia(line: Bounds, media: Bounds): boolean {
  const left = Math.max(line.x, media.x);
  const top = Math.max(line.y, media.y);
  const right = Math.min(line.x + line.width, media.x + media.width);
  const bottom = Math.min(line.y + line.height, media.y + media.height);
  const area = Math.max(0, right - left) * Math.max(0, bottom - top);
  return area >= Math.min(line.width * line.height, media.width * media.height) * 0.45;
}

function unionBounds(items: readonly Bounds[]): Bounds | null {
  if (!items.length) return null;
  const left = Math.min(...items.map(item => item.x));
  const top = Math.min(...items.map(item => item.y));
  const right = Math.max(...items.map(item => item.x + item.width));
  const bottom = Math.max(...items.map(item => item.y + item.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function lineOrMatchingWordBounds(line: DocumentOcrLine, predicate: (text: string) => boolean): Bounds {
  const words = (line.words ?? []).filter(word => predicate(word.text));
  return unionBounds(words.map(word => word.bounds)) ?? line.bounds;
}

const DOCUMENT_FIELD_LABELS: Readonly<Record<DocumentSecret['secretType'], readonly string[]>> = {
  'aadhaar-number': ['AADHAAR', 'NUMBER'],
  name: ['NAME'],
  'date-of-birth': ['DATE', 'OF', 'BIRTH'],
  gender: ['GENDER'],
  address: ['ADDRESS'],
  mobile: ['MOBILE'],
  pan: ['PAN'],
  'card-number': ['CARD', 'NUMBER'],
  expiry: ['VALID', 'THRU'],
  cvv: ['SECURITY', 'CODE'],
};

function wordToken(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/gu, '');
}

function fieldLabelPattern(secretType: DocumentSecret['secretType']): RegExp {
  switch (secretType) {
    case 'aadhaar-number': return /\b(?:aadhaar|aadhar)(?:\s+number)?\b\s*[:\-]?\s*/iu;
    case 'name': return /\b(?:full\s+name|name)\b\s*[:\-]?\s*/iu;
    case 'date-of-birth': return /\b(?:date\s+of\s+birth|dob|birth\s+date)\b\s*[:\-]?\s*/iu;
    case 'gender': return /\b(?:gender|sex)\b\s*[:\-]?\s*/iu;
    case 'address': return /\b(?:residential\s+address|address)\b\s*[:\-]?\s*/iu;
    case 'mobile': return /\b(?:mobile|phone|telephone)\b\s*[:\-]?\s*/iu;
    case 'pan': return /\b(?:permanent\s+account\s+number|pan)\b\s*[:\-]?\s*/iu;
    case 'card-number': return /\b(?:card\s+number|number)\b\s*[:\-]?\s*/iu;
    case 'expiry': return /\b(?:valid\s+thru|expiry|expires?)\b\s*[:\-]?\s*/iu;
    case 'cvv': return /\b(?:security\s+code|cvv|cvc)\b\s*[:\-]?\s*/iu;
  }
}

/** Keep the public field heading visible and return only the value pixels. */
function valueBoundsAfterLabel(line: DocumentOcrLine, secretType: DocumentSecret['secretType']): Bounds {
  const words = line.words ?? [];
  const expected = DOCUMENT_FIELD_LABELS[secretType];
  const tokens = words.map(word => wordToken(word.text));
  for (let start = 0; start <= tokens.length - expected.length; start += 1) {
    if (!expected.every((token, offset) => tokens[start + offset] === token)) continue;
    const valueWords = words.slice(start + expected.length)
      .filter(word => wordToken(word.text).length > 0);
    const bounds = unionBounds(valueWords.map(word => word.bounds));
    if (bounds) return bounds;
  }

  // A browser OCR build may omit word geometry. Use the character position
  // of the canonical label to derive a value-only fallback box.
  const match = fieldLabelPattern(secretType).exec(line.text);
  if (match) {
    const valueStart = match.index + match[0].length;
    if (valueStart < line.text.length) {
      const ratio = Math.max(0, Math.min(1, valueStart / Math.max(1, line.text.length)));
      const x = line.bounds.x + line.bounds.width * ratio;
      return {
        x,
        y: line.bounds.y,
        width: Math.max(1, line.bounds.x + line.bounds.width - x),
        height: line.bounds.height,
      };
    }
  }
  return line.bounds;
}

function digitWordIn(text: string): boolean {
  return /^\d{3,19}$/u.test(text.trim());
}

function luhnValid(value: string): boolean {
  if (!/^\d{13,19}$/u.test(value)) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function cardNumberIn(text: string): boolean {
  const matches = normalized(text).match(/(?<!\d)(?:\d[\s-]?){13,19}(?!\d)/gu) ?? [];
  return matches.some(candidate => luhnValid(candidate.replace(/\D/gu, '')));
}

function panIn(text: string): boolean {
  return /\b[A-Z]{5}\s*\d{4}\s*[A-Z]\b/iu.test(text);
}

function aadhaarIn(text: string): boolean {
  // Aadhaar-style identifiers are emitted as three four-digit groups. The
  // grouping requirement prevents a country code plus phone number from
  // being mistaken for an identity number.
  const matches = normalized(text).match(/(?<!\d)\d{4}[\s-]\d{4}[\s-]\d{4}(?!\d)/gu) ?? [];
  if (matches.some(candidate => compact(candidate).length === 12)) return true;
  // OCR occasionally removes spaces. Only accept an ungrouped twelve-digit
  // token when the same line explicitly names it as an Aadhaar identifier.
  return /\baadhaar(?:\s+number)?\b[^\d]{0,16}\d{12}\b/iu.test(text);
}

function cardContextIn(text: string): boolean {
  return /\b(?:visa|mastercard|amex|credit|debit|card|valid\s+thru|validity|expiry|expires?|cvv|cvc|security\s+code)\b/iu.test(text);
}

function cardContextScore(text: string): number {
  const terms = [
    /\bvisa\b/iu,
    /\bmastercard\b/iu,
    /\bamex\b/iu,
    /\bcredit\b/iu,
    /\bdebit\b/iu,
    /\bcard\b/iu,
    /\bvalid\s+thru\b/iu,
    /\bvalidity\b/iu,
    /\bexpiry\b/iu,
    /\bexpires?\b/iu,
    /\bcvv\b/iu,
    /\bcvc\b/iu,
    /\bsecurity\s+code\b/iu,
  ];
  return terms.reduce((score, term) => score + (term.test(text) ? 1 : 0), 0);
}

function panContextIn(text: string): boolean {
  return /\b(?:pan|permanent\s+account\s+number|income\s+tax|tax\s+department)\b/iu.test(text);
}

function aadhaarContextIn(text: string): boolean {
  return /\b(?:aadhaar|aadhar|uidai|unique\s+identification|identity\s+card|synthetic\s+identity)\b/iu.test(text);
}

function aadhaarSecretTypeIn(text: string): DocumentSecret['secretType'] | null {
  if (aadhaarIn(text)) return 'aadhaar-number';
  if (/\b(?:date\s+of\s+birth|dob|year\s+of\s+birth)\b/iu.test(text)) return 'date-of-birth';
  if (/\b(?:full\s+name|name)\s*[:\-]/iu.test(text)) return 'name';
  if (/\b(?:gender|sex)\s*[:\-]/iu.test(text)) return 'gender';
  if (/\b(?:address|residential\s+address)\s*[:\-]/iu.test(text)) return 'address';
  if (/\b(?:mobile|phone|telephone)\s*[:\-]/iu.test(text)) return 'mobile';
  return null;
}

function documentShapeLikely(media: Bounds): boolean {
  const aspectRatio = media.width / media.height;
  return Number.isFinite(aspectRatio) && aspectRatio >= 1.2 && aspectRatio <= 2.4;
}

function expiryIn(text: string): boolean {
  // Tesseract can prepend one stray digit to a small expiry (for example
  // `08/29` -> `038/29`). Validate every one- or two-digit suffix of the
  // month token instead of requiring a perfect word boundary. The caller
  // still requires card context plus card-number, expiry and CVV coverage, so
  // this tolerance cannot by itself unmask an arbitrary date on a photo.
  const matches = text.match(/(?<!\d)\d{1,3}\s*[/-]\s*\d{2,4}(?!\d)/gu) ?? [];
  return matches.some((match) => {
    const monthToken = match.split(/[/-]/u)[0]?.replace(/\s+/gu, '') ?? '';
    return [monthToken, monthToken.slice(-1), monthToken.slice(-2)]
      .some(candidate => /^(?:0?[1-9]|1[0-2])$/u.test(candidate));
  });
}

function cvvIn(text: string): boolean {
  return /\b(?:cvv|cvc|security\s+code)\b[^\d]{0,20}\d{3,4}\b/iu.test(text);
}

function cvvLabelIn(text: string): boolean {
  return /\b(?:cvv|cvc|security\s+code)\b/iu.test(text);
}

function standaloneCvvValueIn(text: string): boolean {
  return /^\D*\d{3,4}\D*$/u.test(text);
}

function dateValueIn(text: string): boolean {
  return /(?<!\d)\d{1,2}\s*[/-]\s*\d{1,2}\s*[/-]\s*\d{2,4}(?!\d)/u.test(text);
}

function nameValueIn(text: string): boolean {
  const normalizedText = normalized(text);
  return /^[\p{L}][\p{L}.' -]{2,80}$/u.test(normalizedText)
    && normalizedText.split(/\s+/u).length >= 2
    && !/\b(?:income|tax|department|government|republic|account|number|date|birth|signature)\b/iu.test(normalizedText);
}

function labelOnly(text: string, secretType: DocumentSecret['secretType']): boolean {
  return text.replace(fieldLabelPattern(secretType), '').replace(/[:\-\s]/gu, '') === '';
}

function valueLineBelowLabel(
  candidates: readonly CandidateLine[],
  label: CandidateLine,
  predicate: (text: string) => boolean,
): CandidateLine | undefined {
  const labelBottom = label.line.bounds.y + label.line.bounds.height;
  return candidates
    .filter(candidate => candidate !== label
      && predicate(candidate.line.text)
      && candidate.line.bounds.y >= labelBottom - 4
      && candidate.line.bounds.y - labelBottom <= Math.max(90, label.line.bounds.height * 4)
      && Math.abs(candidate.line.bounds.x - label.line.bounds.x) <= Math.max(120, label.line.bounds.width))
    .sort((left, right) => left.line.bounds.y - right.line.bounds.y)[0];
}

function labelledDocumentValue(
  candidates: readonly CandidateLine[],
  secretType: 'name' | 'date-of-birth',
  predicate: (text: string) => boolean,
): { line: DocumentOcrLine; bounds: Bounds } | undefined {
  const inline = candidates.find(candidate => fieldLabelPattern(secretType).test(candidate.line.text)
    && !labelOnly(candidate.line.text, secretType)
    && predicate(candidate.line.text.replace(fieldLabelPattern(secretType), '')));
  if (inline) return { line: inline.line, bounds: valueBoundsAfterLabel(inline.line, secretType) };

  const label = candidates.find(candidate => labelOnly(candidate.line.text, secretType));
  if (!label) return undefined;
  const value = valueLineBelowLabel(candidates, label, predicate);
  return value ? { line: value.line, bounds: value.line.bounds } : undefined;
}

function hintedPanValue(
  candidates: readonly CandidateLine[],
  panLine: CandidateLine,
  secretType: 'name' | 'date-of-birth',
): { line: DocumentOcrLine; bounds: Bounds } | undefined {
  const predicate = secretType === 'name' ? nameValueIn : dateValueIn;
  const panBottom = panLine.line.bounds.y + panLine.line.bounds.height;
  const value = candidates
    .filter(candidate => candidate !== panLine
      && predicate(candidate.line.text)
      && candidate.line.bounds.y >= panBottom - 6
      && candidate.line.bounds.y - panBottom <= Math.max(220, panLine.line.bounds.height * 12))
    .sort((left, right) => left.line.bounds.y - right.line.bounds.y)[0];
  return value ? { line: value.line, bounds: value.line.bounds } : undefined;
}

/** Cardholder captions may be separate or share a row with expiry/CVV. */
function cardholderValue(candidates: readonly CandidateLine[], numberLine: CandidateLine): { line: DocumentOcrLine; bounds: Bounds } | undefined {
  const labelled = labelledDocumentValue(candidates, 'name', nameValueIn);
  if (labelled) return labelled;
  for (const candidate of candidates) {
    const line = candidate.line;
    if (line.bounds.y < numberLine.line.bounds.y + numberLine.line.bounds.height) continue;
    const words = line.words ?? [];
    // Stop at the first numeric field; never include expiry/CVV in the name.
    const firstDigit = words.findIndex(word => /\d/u.test(word.text));
    const nameWords = (firstDigit < 0 ? words : words.slice(0, firstDigit))
      .filter(word => !/^(?:cardholder|name)[:\-]?$/iu.test(word.text));
    const nameText = nameWords.length ? nameWords.map(word => word.text).join(' ') : line.text;
    if (!nameValueIn(nameText) || /\b(?:bank|card|cardholder|valid|thru|security|code|payment|instrument|synthetic|evaluation)\b/iu.test(nameText)) continue;
    const bounds = unionBounds(nameWords.map(word => word.bounds)) ?? line.bounds;
    return { line, bounds };
  }
  return undefined;
}

function near(label: Bounds, value: Bounds): boolean {
  const labelCenterX = label.x + label.width / 2;
  const valueCenterX = value.x + value.width / 2;
  const verticalGap = Math.abs((value.y + value.height / 2) - (label.y + label.height / 2));
  return verticalGap <= Math.max(64, label.height * 3)
    && Math.abs(labelCenterX - valueCenterX) <= Math.max(label.width, value.width) + 80;
}

// Layout ornaments can be grouped into a text line and depress its average
// confidence. Recover only high-confidence words for classification, but
// preserve the original line bounds to cover uncertain value characters.
function recoverConfidentWords(line: DocumentOcrLine): DocumentOcrLine {
  if (line.confidence >= DOCUMENT_OCR_MIN_CONFIDENCE) return line;
  const words = (line.words ?? []).filter(word => word.confidence >= DOCUMENT_OCR_MIN_CONFIDENCE);
  const bounds = unionBounds(words.map(word => word.bounds));
  if (!words.length || !bounds) return line;
  return {
    text: words.map(word => word.text).join(' '),
    confidence: words.reduce((sum, word) => sum + word.confidence, 0) / words.length,
    bounds: line.bounds,
    words: line.words ?? [],
  };
}

function confidenceFor(lines: readonly DocumentOcrLine[]): number {
  if (!lines.length) return 0;
  return Math.max(0, Math.min(1, lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length));
}

function cardNumberBounds(line: DocumentOcrLine): Bounds {
  return lineOrMatchingWordBounds(line, digitWordIn);
}

function cvvBounds(line: DocumentOcrLine): Bounds {
  return lineOrMatchingWordBounds(line, standaloneCvvValueIn);
}

/**
 * On downscaled card artwork Tesseract can omit the small "SECURITY CODE"
 * caption while still returning the final three/four digit token with word
 * geometry. A coarse credit-card media hint is sufficient context to treat
 * that trailing token as CVV; the card number and expiry are still required
 * below before any whole-media mask is removed.
 */
function hintedCvvWord(
  line: DocumentOcrLine,
  documentTypeHint: DocumentOcrMediaHint['documentType'],
  expiryBounds: readonly Bounds[],
): DocumentOcrWord | undefined {
  if (documentTypeHint !== 'credit-card') return undefined;
  const words = (line.words ?? []).filter(word => standaloneCvvValueIn(word.text));
  if (!expiryBounds.some(bounds => near(bounds, line.bounds))) return undefined;
  if (words.length) return words[words.length - 1];
  return undefined;
}

function hintForMedia(
  media: Bounds,
  hints: readonly DocumentOcrMediaHint[],
): DocumentOcrMediaHint['documentType'] {
  // Hints are produced from the same DOM box as mediaBounds and scaled by the
  // caller together with that box.  Keep a small tolerance for fractional
  // device-pixel rounding, but never match a merely nearby image.
  // `mediaBounds` may be the union of an image and an overlaid portrait (the
  // demo identity fixtures intentionally use that composition), while the
  // hint is emitted for the document image alone. Exact equality therefore
  // fails even though the two boxes describe the same card. Match only a
  // strong geometric overlap so a nearby unrelated image can never lend a
  // document type to this crop.
  const match = hints
    .filter(hint => sameBounds(hint.bounds, media) || overlapRatio(hint.bounds, media) >= 0.82)
    .sort((left, right) => overlapRatio(right.bounds, media) - overlapRatio(left.bounds, media))[0];
  return match?.documentType;
}

function overlapRatio(a: Bounds, b: Bounds): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return smaller > 0 ? intersection / smaller : 0;
}

function sameBounds(a: Bounds, b: Bounds): boolean {
  const tolerance = Math.max(0.75, Math.max(a.width, a.height, b.width, b.height) * 0.002);
  return Math.abs(a.x - b.x) <= tolerance
    && Math.abs(a.y - b.y) <= tolerance
    && Math.abs(a.width - b.width) <= tolerance
    && Math.abs(a.height - b.height) <= tolerance;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) throw new Error('Local document OCR timed out');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Local document OCR timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Converts OCR lines into a credential-only result. Keeping this pure makes
 * the safety decision testable without loading a model in Vitest.
 */
export function classifyDocumentOcr(
  lines: readonly DocumentOcrLine[],
  mediaBounds: readonly Bounds[],
  mediaHints: readonly DocumentOcrMediaHint[] = [],
): Omit<DocumentOcrResult, 'durationMs'> {
  const documents: DocumentClassification[] = [];
  const secrets: DocumentSecret[] = [];

  for (const media of mediaBounds.slice(0, DOCUMENT_OCR_MAX_MEDIA_REGIONS)) {
    if (!documentShapeLikely(media)) continue;
    const candidates: CandidateLine[] = lines
      .map(recoverConfidentWords)
      .filter(line => line.confidence >= DOCUMENT_OCR_MIN_CONFIDENCE && intersectsMedia(line.bounds, media))
      .map(line => ({ line, mediaBounds: media }));
    if (!candidates.length) continue;

    const allText = candidates.map(item => item.line.text).join(' ');
    const panLine = candidates.find(item => panIn(item.line.text));
    const aadhaarLine = candidates.find(item => aadhaarIn(item.line.text));
    const cardLine = candidates.find(item => cardNumberIn(item.line.text));
    const isAadhaarDocument = aadhaarLine !== undefined && aadhaarContextIn(allText);
    const isPanDocument = panLine !== undefined && panContextIn(allText);
    const documentTypeHint = hintForMedia(media, mediaHints);
    // A valid Luhn sequence alone is not enough. Requiring document context
    // prevents a random number in an image from being treated as a card.  A
    // trusted coarse credit-card hint may supply the missing word “credit” in
    // a low-resolution crop, but it cannot waive field-level coverage below.
    const isCardDocument = cardLine !== undefined
      && ((cardContextIn(allText) && cardContextScore(allText) >= 2)
        || documentTypeHint === 'credit-card');

    if (isAadhaarDocument) {
      const confidence = confidenceFor(candidates
        .filter(item => item.line.confidence >= DOCUMENT_OCR_MIN_CONFIDENCE)
        .map(item => item.line));
      if (confidence >= DOCUMENT_OCR_MIN_CONFIDENCE) {
        documents.push({ kind: 'aadhaar-card', bounds: media, confidence });
        for (const candidate of candidates) {
          const secretType = aadhaarSecretTypeIn(candidate.line.text);
          if (!secretType) continue;
          secrets.push({
            kind: 'aadhaar-card',
            secretType,
            bounds: valueBoundsAfterLabel(candidate.line, secretType),
            confidence: candidate.line.confidence,
            mediaBounds: media,
          });
        }
      }
      continue;
    }

    if (isPanDocument) {
      const confidence = confidenceFor(candidates
        .filter(item => item.line.confidence >= DOCUMENT_OCR_MIN_CONFIDENCE)
        .map(item => item.line));
      if (confidence >= DOCUMENT_OCR_MIN_CONFIDENCE) {
        documents.push({ kind: 'pan-card', bounds: media, confidence });
        secrets.push({
          kind: 'pan-card',
          secretType: 'pan',
          bounds: lineOrMatchingWordBounds(panLine.line, panIn),
          confidence: panLine.line.confidence,
          mediaBounds: media,
        });
        // Browser-scale OCR can read the large PAN values while dropping the
        // tiny NAME/DOB captions. Once PAN identity and document context are
        // independently proven, the extension-local hint may associate the
        // first plausible value below the PAN. This can only add masks.
        const panName = labelledDocumentValue(candidates, 'name', nameValueIn)
          ?? (documentTypeHint === 'pan-card'
            ? hintedPanValue(candidates, panLine, 'name')
            : undefined);
        if (panName) {
          secrets.push({
            kind: 'pan-card',
            secretType: 'name',
            bounds: panName.bounds,
            confidence: panName.line.confidence,
            mediaBounds: media,
          });
        }
        const panDateOfBirth = labelledDocumentValue(candidates, 'date-of-birth', dateValueIn)
          ?? (documentTypeHint === 'pan-card'
            ? hintedPanValue(candidates, panLine, 'date-of-birth')
            : undefined);
        if (panDateOfBirth) {
          secrets.push({
            kind: 'pan-card',
            secretType: 'date-of-birth',
            bounds: panDateOfBirth.bounds,
            confidence: panDateOfBirth.line.confidence,
            mediaBounds: media,
          });
        }
      }
      continue;
    }

    if (!isCardDocument) continue;
    const confidence = confidenceFor(candidates
      .filter(item => item.line.confidence >= DOCUMENT_OCR_MIN_CONFIDENCE)
      .map(item => item.line));
    if (confidence < DOCUMENT_OCR_MIN_CONFIDENCE) continue;
    const cardSecrets: DocumentSecret[] = [{
      kind: 'sensitive-field',
      secretType: 'card-number',
      bounds: cardNumberBounds(cardLine.line),
      confidence: cardLine.line.confidence,
      mediaBounds: media,
    }];

    const expiryCandidates = candidates.filter(candidate => expiryIn(candidate.line.text));
    const expiryBounds = expiryCandidates.map(candidate => candidate.line.bounds);
    const cvvLabels = candidates.filter(candidate => cvvLabelIn(candidate.line.text));
    for (const candidate of candidates) {
      const text = candidate.line.text;
      if (candidate === cardLine) continue;
      if (expiryIn(text)) {
        cardSecrets.push({
          kind: 'sensitive-field',
          secretType: 'expiry',
          bounds: lineOrMatchingWordBounds(candidate.line, expiryIn),
          confidence: candidate.line.confidence,
          mediaBounds: media,
        });
      }
      const cvvWord = (candidate.line.words ?? []).find(word => standaloneCvvValueIn(word.text));
      // If a small card crop separates the value from its "security code"
      // label, use the explicit local card hint plus proximity to the expiry
      // line as a conservative association. The full card-number/expiry/CVV
      // coverage gate below still has to pass.
      const hintedCvv = hintedCvvWord(candidate.line, documentTypeHint, expiryBounds);
      const hasNearbyCvvWord = cvvWord !== undefined
        && cvvLabels.some(label => near(label.line.bounds, cvvWord.bounds));
      if (cvvIn(text) || hasNearbyCvvWord || hintedCvv !== undefined || (standaloneCvvValueIn(text)
        && cvvLabels.some(label => near(label.line.bounds, candidate.line.bounds)))) {
        cardSecrets.push({
          kind: 'sensitive-field',
          secretType: 'cvv',
          bounds: cvvWord?.bounds ?? hintedCvv?.bounds ?? cvvBounds(candidate.line),
          confidence: candidate.line.confidence,
          mediaBounds: media,
        });
      }
    }
    const cardholder = cardholderValue(candidates, cardLine);
    if (cardholder) cardSecrets.push({
      kind: 'sensitive-field', secretType: 'name', bounds: cardholder.bounds,
      confidence: cardholder.line.confidence, mediaBounds: media,
    });
    // A hint only supplies coarse document identity.  Keep the original
    // fail-closed behavior by requiring the PAN, expiry and CVV before any
    // media-wide mask can be removed by the caller.
    const requiredCardSecrets: readonly DocumentSecret['secretType'][] = ['card-number', 'expiry', 'cvv'];
    if (!requiredCardSecrets.every(secretType => cardSecrets.some(secret => secret.secretType === secretType))) continue;
    documents.push({ kind: 'credit-card', bounds: media, confidence });
    secrets.push(...cardSecrets);
  }

  return {
    documents,
    // The same line can be emitted by overlapping media boxes. De-duplicate
    // geometry so metrics and receiver overlap checks stay deterministic.
    secrets: secrets.filter((secret, index, all) => all.findIndex(other =>
      other.secretType === secret.secretType
      && Math.abs(other.bounds.x - secret.bounds.x) < 0.5
      && Math.abs(other.bounds.y - secret.bounds.y) < 0.5
      && Math.abs(other.bounds.width - secret.bounds.width) < 0.5
      && Math.abs(other.bounds.height - secret.bounds.height) < 0.5) === index),
    modelVersion: DOCUMENT_OCR_VERSION,
  };
}

function cropCanvas(image: OffscreenCanvas, media: Bounds): {
  canvas: OffscreenCanvas;
  origin: Bounds;
  scale: number;
} {
  const x = Math.max(0, Math.floor(media.x));
  const y = Math.max(0, Math.floor(media.y));
  const right = Math.min(image.width, Math.ceil(media.x + media.width));
  const bottom = Math.min(image.height, Math.ceil(media.y + media.height));
  const width = Math.max(1, right - x);
  const height = Math.max(1, bottom - y);
  // Upscaling small cards materially improves OCR while the per-crop and
  // total-pixel caps keep the extension responsive.
  // The demo cards render at roughly 435 CSS pixels wide.  A 1,000-pixel
  // target leaves the credit-card expiry as an ambiguous token (for example
  // `038/29`), which prevents the complete-field safety gate from selecting
  // the precise redactions.  A 1,300-pixel target reaches the existing 3x
  // cap for these cards while staying under the aggregate OCR pixel budget.
  const scale = Math.min(3, Math.max(1, 1_300 / Math.max(width, height)));
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.min(2_048, Math.round(width * scale))),
    Math.max(1, Math.min(2_048, Math.round(height * scale))),
  );
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Local OCR canvas unavailable');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, x, y, width, height, 0, 0, canvas.width, canvas.height);
  // Browser screenshots often downsample light card text over a saturated
  // background.  A local grayscale/contrast pass restores the character
  // edges before Tesseract sees the crop (and never leaves this canvas).  The
  // pixel loop is bounded by DOCUMENT_OCR_MAX_PIXELS across all crops.
  try {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < pixels.data.length; index += 4) {
      const luminance = (pixels.data[index] ?? 0) * 0.299
        + (pixels.data[index + 1] ?? 0) * 0.587
        + (pixels.data[index + 2] ?? 0) * 0.114;
      const contrasted = Math.max(0, Math.min(255, (luminance - 128) * 1.8 + 128));
      pixels.data[index] = contrasted;
      pixels.data[index + 1] = contrasted;
      pixels.data[index + 2] = contrasted;
    }
    context.putImageData(pixels, 0, 0);
  } catch {
    // Some browser implementations disallow readback from an OffscreenCanvas;
    // the unprocessed crop remains valid and the normal confidence gate still
    // fails closed when OCR cannot prove the required fields.
  }
  return { canvas, origin: { x, y, width, height }, scale };
}

export function createBrowserDocumentOcrRuntime(): DocumentOcrRuntime {
  let workerPromise: Promise<Worker> | undefined;
  function worker(): Promise<Worker> {
    workerPromise ??= createWorker(['eng'], 1, {
      workerPath: runtimeUrl('ocr/worker.min.js'),
      corePath: runtimeUrl('ocr/core'),
      langPath: runtimeUrl('ocr/lang-data'),
      workerBlobURL: false,
      gzip: false,
      cacheMethod: 'none',
      logger: () => undefined,
      errorHandler: () => undefined,
    }).then(async instance => {
      await instance.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        preserve_interword_spaces: '1',
        user_defined_dpi: '220',
      });
      return instance;
    });
    return workerPromise;
  }

  return {
    async scan(image, mediaBounds, mediaHints = [], privacyGrade = 3) {
      const started = performance.now();
      const deadline = started + DOCUMENT_OCR_TIMEOUT_MS;
      if (image.width <= 0 || image.height <= 0) throw new Error('Local OCR image is empty');
      const selected = mediaBounds
        .filter(item => item.width > 0 && item.height > 0 && documentShapeLikely(item))
        .slice(0, DOCUMENT_OCR_MAX_MEDIA_REGIONS);
      const lines: DocumentOcrLine[] = [];
      let pixels = 0;
      for (const media of selected) {
        const crop = cropCanvas(image, media);
        pixels += crop.canvas.width * crop.canvas.height;
        if (pixels > DOCUMENT_OCR_MAX_PIXELS) {
          crop.canvas.width = 1;
          crop.canvas.height = 1;
          break;
        }
        try {
          const instance = await withTimeout(worker(), Math.max(1, deadline - performance.now()));
          // Sparse text preserves independent card columns. Retry a single
          // block only when that crop has incomplete credential coverage.
          for (const mode of [PSM.SPARSE_TEXT, PSM.SINGLE_BLOCK]) {
            await instance.setParameters({ tessedit_pageseg_mode: mode });
            const result = await withTimeout(
              instance.recognize(crop.canvas, {}, { blocks: true }),
              Math.max(1, deadline - performance.now()),
            );
            const blocks = result.data.blocks;
            if (!Array.isArray(blocks)) throw new Error('OCR geometry unavailable');
            for (const block of blocks) {
              for (const paragraph of block.paragraphs ?? []) {
                for (const line of paragraph.lines ?? []) {
                  const lineBounds = {
                    x: crop.origin.x + line.bbox.x0 / crop.scale,
                    y: crop.origin.y + line.bbox.y0 / crop.scale,
                    width: (line.bbox.x1 - line.bbox.x0) / crop.scale,
                    height: (line.bbox.y1 - line.bbox.y0) / crop.scale,
                  };
                  const words = (line.words ?? []).map(word => ({
                    text: word.text,
                    confidence: word.confidence / 100,
                    bounds: {
                      x: crop.origin.x + word.bbox.x0 / crop.scale,
                      y: crop.origin.y + word.bbox.y0 / crop.scale,
                      width: (word.bbox.x1 - word.bbox.x0) / crop.scale,
                      height: (word.bbox.y1 - word.bbox.y0) / crop.scale,
                    },
                  }));
                  lines.push({
                    text: line.text,
                    confidence: line.confidence / 100,
                    bounds: lineBounds,
                    words,
                  });
                }
              }
            }
            const partial = classifyDocumentOcr(lines, [media], mediaHints);
            const kind = partial.documents[0]?.kind;
            const required = kind ? requiredDocumentFields(kind, privacyGrade) : [];
            if (kind && required.every(type => partial.secrets.some(secret => secret.secretType === type))) break;
          }
        } finally {
          crop.canvas.width = 1;
          crop.canvas.height = 1;
        }
      }
      const classified = classifyDocumentOcr(lines, selected, mediaHints);
      return {
        ...classified,
        durationMs: performance.now() - started,
      };
    },
    async close() {
      const pending = workerPromise;
      workerPromise = undefined;
      void pending?.then(instance => instance.terminate()).catch(() => undefined);
    },
  };
}

export const documentOcrInternals = {
  luhnValid,
  cardNumberIn,
  aadhaarIn,
  panIn,
  cardContextIn,
  cardContextScore,
  panContextIn,
  aadhaarContextIn,
  aadhaarSecretTypeIn,
  valueBoundsAfterLabel,
  labelledDocumentValue,
  hintedPanValue,
  dateValueIn,
  nameValueIn,
  documentShapeLikely,
  expiryIn,
  cvvIn,
  digitWordIn,
  standaloneCvvValueIn,
  normalized,
  compact,
  intersectsMedia,
  hintedCvvWord,
  overlapRatio,
  withTimeout,
};
