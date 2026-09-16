import { CATEGORY_MINIMUM_GRADE, categoryForFinding, normalizePrivacyGrade, type PrivacyCategory, type PrivacyGrade } from './privacy-policy';
import { detectPii, sanitizeText } from './privacy';
import type { Bounds } from './types';
import { normalizeForDetection } from './text-normalization';

export const PERCEPTION_VERSION = '1.1.0';
export const PERCEPTION_BUDGET = Object.freeze({ pixels: 4_194_304, texts: 192, characters: 1500, milliseconds: 120_000 });
export type DetectorFinding = Readonly<{
  category: PrivacyCategory;
  confidence: number;
  bounds: Bounds;
  source: 'ocr' | 'ner' | 'barcode' | 'regex';
  minimumPrivacyGrade: PrivacyGrade;
  modelVersion: string;
}>;
export type TextRegion = Readonly<{ text: string; bounds: Bounds }>;
export type OcrRegion = TextRegion & Readonly<{ confidence: number }>;
export type Entity = Readonly<{ entity: string; score: number }>;
export interface PerceptionRuntime {
  ocr(image: OffscreenCanvas): Promise<readonly OcrRegion[]>;
  entities(text: string): Promise<readonly Entity[]>;
  barcodes(image: OffscreenCanvas): Promise<readonly Bounds[]>;
  close(): Promise<void>;
}
export type PerceptionResult = Readonly<{
  findings: readonly DetectorFinding[];
  safeTexts: readonly string[];
  durationMs: number;
  modelVersion: string;
}>;
const labels: Readonly<Record<string, PrivacyCategory>> = {
  PER: 'name', PERSON: 'name', LOC: 'location', LOCATION: 'location',
  ORG: 'professional-id', ORGANIZATION: 'professional-id',
  DATE: 'date-of-birth', AGE: 'unknown-populated-field', MISC: 'unknown-populated-field',
};

export function validBounds(box: Bounds, width: number, height: number): boolean {
  return !!box && [box.x, box.y, box.width, box.height].every(Number.isFinite)
    && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0
    && box.x + box.width <= width && box.y + box.height <= height;
}

export function entityCategory(entity: Entity): PrivacyCategory {
  if (!entity || typeof entity.entity !== 'string' || !Number.isFinite(entity.score) || entity.score < 0 || entity.score > 1) {
    throw new Error('Invalid local detector output');
  }
  const category = labels[entity.entity.replace(/^[BI]-/u, '')];
  if (!category) throw new Error('Invalid local detector category');
  // Uncertain positive predictions are not silently thrown away.
  return entity.score < 0.8 ? 'uninspectable' : category;
}

export async function perceive(
  runtime: PerceptionRuntime,
  canvas: OffscreenCanvas,
  regions: readonly TextRegion[],
  texts: readonly string[],
  grade: PrivacyGrade,
  knownValues: readonly string[],
): Promise<PerceptionResult> {
  const started = performance.now();
  grade = normalizePrivacyGrade(grade);
  if (canvas.width * canvas.height > PERCEPTION_BUDGET.pixels || canvas.width <= 0 || canvas.height <= 0
    || regions.length + texts.length > PERCEPTION_BUDGET.texts) throw new Error('Local perception budget exceeded');
  const findings: DetectorFinding[] = [];
  // Cache only within this frame. No raw text or inference cache survives capture.
  const cache = new Map<string, Promise<PrivacyCategory | null>>();
  async function classify(text: string): Promise<PrivacyCategory | null> {
    if (typeof text !== 'string' || text.length > PERCEPTION_BUDGET.characters) throw new Error('Local perception text budget exceeded');
    if (!text.trim()) return null;
    let pending = cache.get(text);
    if (!pending) {
      pending = (async () => {
        const categories = detectPii(text, knownValues).map(f => categoryForFinding(f.kind));
        const entities = await runtime.entities(normalizeForDetection(text));
        if (!Array.isArray(entities) || entities.length > 512) throw new Error('Invalid local detector output');
        categories.push(...entities.map(entityCategory));
        return categories.filter(c => CATEGORY_MINIMUM_GRADE[c] <= grade)
          .sort((a, b) => CATEGORY_MINIMUM_GRADE[a] - CATEGORY_MINIMUM_GRADE[b])[0] ?? null;
      })();
      cache.set(text, pending);
    }
    return pending;
  }
  const add = (category: PrivacyCategory, confidence: number, bounds: Bounds, source: DetectorFinding['source']) => {
    if (!validBounds(bounds, canvas.width, canvas.height) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error('Invalid local detector bounds');
    }
    findings.push({ category, confidence, bounds: { ...bounds }, source, minimumPrivacyGrade: CATEGORY_MINIMUM_GRADE[category], modelVersion: PERCEPTION_VERSION });
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const safeTexts: string[] = [];
        for (const text of texts) {
          const category = await classify(text);
          safeTexts.push(category ? '[REDACTED:' + category.toUpperCase().replaceAll('-', '_') + ']' : sanitizeText(text, knownValues, 2000, grade));
        }
        for (const region of regions) {
          if (!validBounds(region.bounds, canvas.width, canvas.height)) throw new Error('Invalid local detector bounds');
          const category = await classify(region.text);
          if (category) add(category, 1, region.bounds, 'ner');
        }
        const lines = await runtime.ocr(canvas);
        if (!Array.isArray(lines) || lines.length > PERCEPTION_BUDGET.texts) throw new Error('Invalid local OCR output');
        for (const line of lines) {
          if (!validBounds(line.bounds, canvas.width, canvas.height) || !Number.isFinite(line.confidence)
            || line.confidence < 0 || line.confidence > 1) throw new Error('Invalid local OCR output');
          const category = line.confidence < 0.7 ? 'uninspectable' : await classify(line.text);
          if (category) add(category, line.confidence, line.bounds, 'ocr');
        }
        const codes = await runtime.barcodes(canvas);
        if (!Array.isArray(codes) || codes.length > 128) throw new Error('Invalid local barcode output');
        // Every decoded code can embed an identifier or opaque lookup token.
        for (const bounds of codes) add('uninspectable', 1, bounds, 'barcode');
        return { findings, safeTexts, durationMs: performance.now() - started, modelVersion: PERCEPTION_VERSION };
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Local perception timed out')), PERCEPTION_BUDGET.milliseconds); }),
    ]);
  } catch {
    await runtime.close().catch(() => undefined);
    // Model messages may contain raw tokens or URLs; never reflect them.
    throw new Error('Local perception failed; transmission blocked');
  } finally {
    clearTimeout(timer);
    cache.clear();
  }
}
