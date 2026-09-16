/**
 * Approach B: 3-tier canvas-app PII mitigation — with full DBNet integration.
 *
 * Addresses the canvas-app privacy gap identified in the RFC — dense text
 * PII in Google Docs, Figma, and similar canvas-rendered applications was
 * explicitly out-of-scope in Approach A.
 *
 * Tiers:
 *   1. Visual-object redaction (default) — standard redaction pipeline
 *   2. DBNet detection-only blind masking — text region detection that
 *      masks all detected text regions as [REDACTED:CANVAS_TEXT]
 *      WITHOUT performing OCR (no text content leaves the device)
 *   3. Manual escalation — user-initiated full-canvas mask when automated
 *      detection is insufficient
 */

import { DbnetTextDetector, type TextRegionDetection } from './dbnet-detector';
import type { Bounds, CanvasPrivacyTier, RedactionKind } from './types';

export type CanvasTextRegion = Readonly<{
  bounds: Bounds;
  confidence: number;
}>;

export type CanvasPrivacyResult = Readonly<{
  tier: CanvasPrivacyTier;
  regions: readonly CanvasTextRegion[];
  /** Whether the DBNet model was available for Tier 2. */
  dbnetAvailable: boolean;
}>;

/** Shared DBNet detector instance — initialized on first use. */
const dbnetDetector = new DbnetTextDetector();

/** Feature flag for DBNet canvas text detection. */
let dbnetEnabled = false;

/**
 * Check whether the current element is a canvas-app container.
 * Canvas apps render text into <canvas> elements rather than DOM text nodes,
 * making them invisible to DOM-based PII detection.
 */
export function isCanvasApp(element: Element): boolean {
  if (element instanceof HTMLCanvasElement) return true;
  const tag = element.tagName.toLowerCase();
  if (tag === 'canvas') return true;
  return false;
}

/**
 * Determine the appropriate canvas privacy tier for a detected canvas element.
 * Falls through from the requested tier to the best available tier.
 */
export function resolveCanvasTier(
  requested: CanvasPrivacyTier,
  _canvasElement: Element,
): CanvasPrivacyTier {
  if (requested === 'visual-redaction') return 'visual-redaction';
  if (requested === 'dbnet-blind-mask') {
    return (dbnetEnabled && dbnetDetector.state !== 'missing') ? 'dbnet-blind-mask' : 'manual-escalation';
  }
  return 'manual-escalation';
}

/**
 * Apply canvas privacy at the resolved tier.
 * For Tier 2, runs DBNet inference on the canvas bitmap to find text regions.
 */
export async function applyCanvasPrivacy(
  tier: CanvasPrivacyTier,
  canvasBounds: Bounds,
  bitmap?: ImageBitmap,
): Promise<CanvasPrivacyResult> {
  switch (tier) {
    case 'visual-redaction':
      return { tier, regions: [], dbnetAvailable: dbnetDetector.available };

    case 'dbnet-blind-mask': {
      if (!bitmap || !dbnetDetector.available) {
        // Fall through to manual escalation
        return {
          tier: 'manual-escalation',
          regions: [{ bounds: canvasBounds, confidence: 1.0 }],
          dbnetAvailable: dbnetDetector.available,
        };
      }
      const result = await dbnetDetector.detect(bitmap);
      const regions: CanvasTextRegion[] = result.regions.map((r: TextRegionDetection) => ({
        bounds: r.bounds,
        confidence: r.confidence,
      }));
      // If DBNet found no text regions, don't silently leave canvas unprotected
      if (regions.length === 0) {
        return {
          tier: 'manual-escalation',
          regions: [{ bounds: canvasBounds, confidence: 1.0 }],
          dbnetAvailable: true,
        };
      }
      return { tier, regions, dbnetAvailable: true };
    }

    case 'manual-escalation':
      return {
        tier,
        regions: [{ bounds: canvasBounds, confidence: 1.0 }],
        dbnetAvailable: dbnetDetector.available,
      };
  }
}

/**
 * Map canvas privacy results to redaction entries.
 */
export function canvasRegionsToRedactions(
  result: CanvasPrivacyResult,
): Array<{ kind: RedactionKind; source: 'dbnet' | 'fallback'; bounds: Bounds; confidence?: number }> {
  if (result.tier === 'visual-redaction') return [];

  const source = result.tier === 'dbnet-blind-mask' ? 'dbnet' as const : 'fallback' as const;
  const kind: RedactionKind = result.tier === 'dbnet-blind-mask' ? 'canvas-text' : 'uninspectable-media';

  return result.regions.map((region) => ({
    kind,
    source,
    bounds: region.bounds,
    confidence: region.confidence,
  }));
}

/**
 * Enable or disable the DBNet feature flag.
 * Called from settings when the user opts in to Tier 2 canvas detection.
 */
export function setDbnetEnabled(enabled: boolean): void {
  dbnetEnabled = enabled;
}

export function isDbnetEnabled(): boolean {
  return dbnetEnabled;
}

/** Expose detector state for diagnostics. */
export function getDbnetState(): {
  enabled: boolean;
  available: boolean;
  backend: string;
  diagnostic: string;
} {
  return {
    enabled: dbnetEnabled,
    available: dbnetDetector.available,
    backend: dbnetDetector.state,
    diagnostic: dbnetDetector.diagnostic,
  };
}
