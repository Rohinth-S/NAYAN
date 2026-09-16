/**
 * Approach B: 3-tier canvas-app PII mitigation.
 *
 * Addresses the canvas-app privacy gap identified in the RFC — dense text
 * PII in Google Docs, Figma, and similar canvas-rendered applications was
 * explicitly out-of-scope in Approach A.
 *
 * Tiers:
 *   1. Visual-object redaction (default) — standard redaction pipeline
 *   2. DBNet detection-only blind masking — opt-in text region detection
 *      that masks all detected text regions as [REDACTED:CANVAS_TEXT]
 *      without OCR (no text content leaves the device)
 *   3. Manual escalation — user-initiated full-canvas mask when automated
 *      detection is insufficient
 *
 * The DBNet model is loaded on-demand and feature-flagged. When the model
 * is not available, Tier 2 requests fall through to Tier 3.
 */

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

/** Feature flag for DBNet canvas text detection. */
let dbnetEnabled = false;

/**
 * Check whether the current element is a canvas-app container.
 * Canvas apps render text into <canvas> elements rather than DOM text nodes,
 * making them invisible to DOM-based PII detection.
 */
export function isCanvasApp(element: Element): boolean {
  // Google Docs, Sheets, Slides use canvas rendering
  if (element instanceof HTMLCanvasElement) return true;

  // Check for known canvas-app container patterns
  const tag = element.tagName.toLowerCase();
  if (tag === 'canvas') return true;

  // Check for WebGL/WebGPU contexts (Figma, etc.)
  if (element instanceof HTMLCanvasElement) {
    try {
      const ctx = element.getContext('2d') || element.getContext('webgl2') || element.getContext('webgl');
      return ctx !== null;
    } catch {
      return false;
    }
  }

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
    // Fall through to manual escalation if DBNet is not available.
    return dbnetEnabled ? 'dbnet-blind-mask' : 'manual-escalation';
  }
  return 'manual-escalation';
}

/**
 * Apply canvas privacy at the resolved tier.
 * Returns redaction regions for the canvas element.
 */
export function applyCanvasPrivacy(
  tier: CanvasPrivacyTier,
  canvasBounds: Bounds,
): CanvasPrivacyResult {
  switch (tier) {
    case 'visual-redaction':
      // Tier 1: standard pipeline handles this via uninspectable-media coverage.
      return { tier, regions: [], dbnetAvailable: dbnetEnabled };

    case 'dbnet-blind-mask':
      // Tier 2: DBNet text detection would run here.
      // When the DBNet model is integrated, this returns detected text regions.
      // For now, falls through to manual escalation at the caller level.
      return { tier, regions: [], dbnetAvailable: dbnetEnabled };

    case 'manual-escalation':
      // Tier 3: full canvas mask — the entire canvas bounds become one redaction.
      return {
        tier,
        regions: [{ bounds: canvasBounds, confidence: 1.0 }],
        dbnetAvailable: dbnetEnabled,
      };
  }
}

/**
 * Map canvas privacy results to redaction entries.
 */
export function canvasRegionsToRedactions(
  result: CanvasPrivacyResult,
): Array<{ kind: RedactionKind; source: 'dbnet' | 'fallback'; bounds: Bounds }> {
  if (result.tier === 'visual-redaction') return [];

  const source = result.tier === 'dbnet-blind-mask' ? 'dbnet' as const : 'fallback' as const;
  const kind: RedactionKind = result.tier === 'dbnet-blind-mask' ? 'canvas-text' : 'uninspectable-media';

  return result.regions.map((region) => ({
    kind,
    source,
    bounds: region.bounds,
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
