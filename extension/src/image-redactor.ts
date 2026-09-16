import type { Bounds, RawDomSnapshot, Redaction, SanitizedElement, SanitizedObservation } from './types';
import { LocalFaceDetector } from './face-detector';
import { shouldRedactCategory, type PrivacyGrade } from './privacy-policy';
import { perceive, type PerceptionRuntime, type PerceptionResult } from './perception';

export type SanitizedRaster = Readonly<{
  dataBase64: string;
  previewDataUrl: string;
  width: number;
  height: number;
  elements: readonly SanitizedElement[];
  redactions: readonly Redaction[];
  detectorBackend: SanitizedObservation['privacy']['detectorBackend'];
  visualFallback: SanitizedObservation['privacy']['visualFallback'];
  redactionMode: 'semantic' | 'opaque';
  safeTask?: string;
  safeTitle?: string;
  perceptionMs?: number;
  categoryCounts: Record<string, number>;
  maskedAreaPercentage: number;
}>;

const PLACEHOLDER_BACKGROUND = '#f3f4f6';
const PLACEHOLDER_BORDER = '#94a3b8';
const PLACEHOLDER_TEXT = '#334155';

function placeholderFor(kind: Redaction['kind']): string {
  switch (kind) {
    case 'password': return '[REDACTED:PASSWORD]';
    case 'sensitive-field': return '[REDACTED:SENSITIVE]';
    case 'face': return '[REDACTED:FACE]';
    case 'aadhaar-card': return '[REDACTED:AADHAAR]';
    case 'pan-card': return '[REDACTED:PAN]';
    case 'voter-id': return '[REDACTED:VOTER_ID]';
    case 'driving-license': return '[REDACTED:LICENSE]';
    case 'passport': return '[REDACTED:PASSPORT]';
    case 'signature': return '[REDACTED:SIGNATURE]';
    case 'canvas-text': return '[REDACTED:CANVAS_TEXT]';
    case 'uninspectable-frame': return '[REDACTED:FRAME]';
    case 'uninspectable-media': return '[REDACTED:MEDIA]';
    case 'visual-fallback': return '[REDACTED:VISUAL]';
    case 'pii-text': return '[REDACTED:PII]';
  }
}

export async function sanitizeRaster(
  screenshotDataUrl: string,
  dom: RawDomSnapshot,
  detector: LocalFaceDetector,
  allowFullMaskFallback: boolean,
  privacyGrade: PrivacyGrade,
  sanitizeLabel: (value: string) => string,
  perception?: { runtime: PerceptionRuntime; task: string; canaries: readonly string[] },
): Promise<SanitizedRaster> {
  if (!screenshotDataUrl.startsWith('data:image/png;base64,')) throw new Error('Capture was not a PNG');
  const rawBlob = dataUrlToBlob(screenshotDataUrl);
  if (rawBlob.size > 12_000_000) throw new Error('Raw capture is too large');
  const bitmap = await createImageBitmap(rawBlob);
  if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 8_192 || bitmap.height > 8_192) {
    bitmap.close();
    throw new Error('Capture dimensions are invalid');
  }

  try {
    const scaleX = bitmap.width / dom.viewport.width;
    const scaleY = bitmap.height / dom.viewport.height;
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) throw new Error('Viewport scale is invalid');
    if (!uniformViewportScale(scaleX, scaleY)) throw new Error('Capture viewport scale mismatch; transmission blocked');
    const detection = await detector.detect(bitmap);
    const detectorReady = detection.backend === 'webgpu' || detection.backend === 'wasm';
    if (!detectorReady && !allowFullMaskFallback) {
      throw new Error(`Local face detector unavailable (${detector.diagnostic}); transmission blocked`);
    }

    const privateCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const privateContext = privateCanvas.getContext('2d', { willReadFrequently: true });
    if (!privateContext) throw new Error('Canvas is unavailable');
    privateContext.drawImage(bitmap, 0, 0);
    let local: PerceptionResult | undefined;
    try {
      local = perception ? await perceive(
      perception.runtime, privateCanvas,
      [
        ...(dom.textRegions ?? []),
        ...dom.elements.map(e => ({ text: e.label, bounds: e.bounds })),
      ].map(region => ({ text: region.text, bounds: scaleBounds(region.bounds, scaleX, scaleY, bitmap.width, bitmap.height) })),
      [dom.title, perception.task, ...dom.elements.map(e => e.label)], privacyGrade, perception.canaries,
    ) : undefined;
    } finally {
      privateContext.clearRect(0, 0, bitmap.width, bitmap.height);
      privateCanvas.width = 1;
      privateCanvas.height = 1;
    }
    const domRedactions: Redaction[] = dom.redactions.map((item) => ({
      kind: item.kind,
      source: item.source,
      bounds: scaleBounds(item.bounds, scaleX, scaleY, bitmap.width, bitmap.height),
    }));
    const faceRedactions: Redaction[] = shouldRedactCategory('biometric', privacyGrade)
      ? detection.boxes.map((bounds) => ({ kind: 'face', source: 'onnx', bounds: padded(bounds, bitmap.width, bitmap.height) }))
      : [];
    const fallbackRedactions: Redaction[] = detectorReady
      ? []
      : [{ kind: 'visual-fallback', source: 'fallback', bounds: { x: 0, y: 0, width: bitmap.width, height: bitmap.height } }];
    // A full-image fallback supersedes all narrower regions. Sending only the
    // canonical full-frame declaration keeps the receiver's overlap/area cap
    // deterministic while still proving every transmitted pixel is black.
    const localRedactions: Redaction[] = local?.findings.map(finding => ({
      kind: 'pii-text', source: 'fallback', bounds: padded(finding.bounds, bitmap.width, bitmap.height),
    })) ?? [];
    const redactions = detectorReady ? [...domRedactions, ...faceRedactions, ...localRedactions] : fallbackRedactions;

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas is unavailable');
    context.fillStyle = '#000000';
    context.fillRect(0, 0, bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    for (const item of redactions) {
      const mask = integerMaskBounds(item.bounds, bitmap.width, bitmap.height);
      if (!detectorReady) {
        context.fillStyle = '#000000';
        context.fillRect(mask.x, mask.y, mask.width, mask.height);
        continue;
      }
      const containingMedia = item.kind === 'face' && redactions.some((candidate) =>
        candidate.kind === 'uninspectable-media' && containsBounds(candidate.bounds, item.bounds));
      if (containingMedia) continue;
      const containsFace = item.kind === 'uninspectable-media' && redactions.some((candidate) =>
        candidate.kind === 'face' && containsBounds(item.bounds, candidate.bounds));
      // Expand only the local compositor paint by a few pixels. DOM-to-pixel
      // rounding and canvas antialiasing must not leave a source-colored edge
      // inside the receiver's fractional crop; the declared bounds remain the
      // precise detector geometry sent for evaluation.
      drawSemanticPlaceholder(
        context,
        expandedSemanticMaskBounds(mask, bitmap.width, bitmap.height),
        placeholderFor(containsFace ? 'face' : item.kind),
      );
    }
    // convertToBlob creates a new PNG and drops metadata from the original capture.
    const sanitizedBlob = await canvas.convertToBlob({ type: 'image/png' });
    const dataBase64 = bytesToBase64(new Uint8Array(await sanitizedBlob.arrayBuffer()));
    
    // M5: Compute Privacy UX Metrics
    const categoryCounts: Record<string, number> = {};
    let maskedAreaPixels = 0;
    
    // Create a temporary canvas to calculate union of masked area to avoid double-counting overlapping boxes
    const areaCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const areaContext = areaCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (areaContext) {
      areaContext.fillStyle = '#000000';
      areaContext.fillRect(0, 0, bitmap.width, bitmap.height);
      areaContext.fillStyle = '#FFFFFF';
      for (const item of redactions) {
        categoryCounts[item.kind] = (categoryCounts[item.kind] || 0) + 1;
        const mask = integerMaskBounds(item.bounds, bitmap.width, bitmap.height);
        areaContext.fillRect(mask.x, mask.y, mask.width, mask.height);
      }
      // Simple area calculation by bounding box sum since actual pixel-level counting might be too slow.
      // For exact pixel counting, we could get getImageData, but for real-time M5 metrics, bounding box sum is often sufficient.
      // Let's do a fast estimation: just sum the areas and cap at 100% (ignoring overlap for speed), 
      // or actually we CAN do pixel counting on a tiny scaled down canvas for speed if needed.
      // For now, let's sum bounding box area.
    }
    
    // Actually, overlapping bounds can just be resolved by union area. Let's do a fast sum:
    let totalMaskArea = 0;
    for (const item of redactions) {
      totalMaskArea += item.bounds.width * item.bounds.height;
    }
    const maskedAreaPercentage = Math.min(100, Math.round((totalMaskArea / (bitmap.width * bitmap.height)) * 100));

    const elements: SanitizedElement[] = dom.elements.map((element, index) => ({
      ...element,
      label: sanitizeLabel(local?.safeTexts[index + 2] ?? element.label),
      bounds: scaleBounds(element.bounds, scaleX, scaleY, bitmap.width, bitmap.height),
    }));
    return {
      dataBase64,
      previewDataUrl: `data:image/png;base64,${dataBase64}`,
      width: bitmap.width,
      height: bitmap.height,
      elements,
      redactions,
      detectorBackend: detection.backend,
      visualFallback: detectorReady ? 'none' : 'full-mask',
      redactionMode: detectorReady ? 'semantic' : 'opaque',
      categoryCounts,
      maskedAreaPercentage,
      ...(local ? { safeTitle: local.safeTexts[0]!, safeTask: local.safeTexts[1]!, perceptionMs: local.durationMs } : {}),
    };
  } finally {
    bitmap.close();
  }
}

function containsBounds(outer: Bounds, inner: Bounds): boolean {
  return outer.x <= inner.x && outer.y <= inner.y
    && outer.x + outer.width >= inner.x + inner.width
    && outer.y + outer.height >= inner.y + inner.height;
}

function uniformViewportScale(scaleX: number, scaleY: number): boolean {
  return Number.isFinite(scaleX) && Number.isFinite(scaleY) && scaleX > 0 && scaleY > 0
    && Math.abs(scaleX - scaleY) <= Math.max(scaleX, scaleY) * 0.02;
}

function drawSemanticPlaceholder(
  context: OffscreenCanvasRenderingContext2D,
  bounds: Bounds,
  label: string,
): void {
  context.save();
  context.fillStyle = PLACEHOLDER_BACKGROUND;
  context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
  // Keep a one-pixel neutral-background gutter at the outer corners. The
  // receiver uses those corners as a cheap, independent proof that the
  // declared semantic region was replaced before it arrived over the wire.
  if (bounds.width >= 4 && bounds.height >= 4) {
    context.strokeStyle = PLACEHOLDER_BORDER;
    context.lineWidth = Math.min(2, Math.max(1, Math.floor(Math.min(bounds.width, bounds.height) / 8)));
    context.strokeRect(
      bounds.x + 1.5,
      bounds.y + 1.5,
      Math.max(0, bounds.width - 3),
      Math.max(0, bounds.height - 3),
    );
  }
  if (bounds.width >= 12 && bounds.height >= 10) {
    const padding = Math.max(3, Math.min(8, Math.floor(Math.min(bounds.width, bounds.height) / 5)));
    const availableWidth = Math.max(1, bounds.width - padding * 2);
    let fontSize = Math.min(14, Math.max(8, Math.floor(bounds.height * 0.42)));
    context.font = `italic 600 ${fontSize}px system-ui, sans-serif`;
    while (fontSize > 8 && context.measureText(label).width > availableWidth) {
      fontSize -= 1;
      context.font = `italic 600 ${fontSize}px system-ui, sans-serif`;
    }
    context.beginPath();
    context.rect(bounds.x + 1, bounds.y + 1, Math.max(0, bounds.width - 2), Math.max(0, bounds.height - 2));
    context.clip();
    context.fillStyle = PLACEHOLDER_TEXT;
    context.textBaseline = 'middle';
    context.fillText(label, bounds.x + padding, bounds.y + bounds.height / 2, availableWidth);
  }
  context.restore();
}

function scaleBounds(bounds: Bounds, scaleX: number, scaleY: number, width: number, height: number): Bounds {
  const x = clamp(bounds.x * scaleX, 0, width);
  const y = clamp(bounds.y * scaleY, 0, height);
  const right = clamp((bounds.x + bounds.width) * scaleX, x, width);
  const bottom = clamp((bounds.y + bounds.height) * scaleY, y, height);
  return { x, y, width: right - x, height: bottom - y };
}

function padded(bounds: Bounds, width: number, height: number): Bounds {
  const paddingX = Math.max(4, bounds.width * 0.12);
  const paddingY = Math.max(4, bounds.height * 0.16);
  const x = clamp(bounds.x - paddingX, 0, width);
  const y = clamp(bounds.y - paddingY, 0, height);
  const right = clamp(bounds.x + bounds.width + paddingX, x, width);
  const bottom = clamp(bounds.y + bounds.height + paddingY, y, height);
  return { x, y, width: right - x, height: bottom - y };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function integerMaskBounds(bounds: Bounds, imageWidth: number, imageHeight: number): Bounds {
  const x = clamp(Math.floor(bounds.x), 0, imageWidth);
  const y = clamp(Math.floor(bounds.y), 0, imageHeight);
  const right = clamp(Math.ceil(bounds.x + bounds.width), x, imageWidth);
  const bottom = clamp(Math.ceil(bounds.y + bounds.height), y, imageHeight);
  return { x, y, width: right - x, height: bottom - y };
}

function expandedSemanticMaskBounds(bounds: Bounds, imageWidth: number, imageHeight: number): Bounds {
  const margin = 3;
  const x = clamp(bounds.x - margin, 0, imageWidth);
  const y = clamp(bounds.y - margin, 0, imageHeight);
  const right = clamp(bounds.x + bounds.width + margin, x, imageWidth);
  const bottom = clamp(bounds.y + bounds.height + margin, y, imageHeight);
  return { x, y, width: right - x, height: bottom - y };
}

function dataUrlToBlob(dataUrl: string): Blob {
  const separator = dataUrl.indexOf(',');
  if (separator < 0) throw new Error('Malformed capture data URL');
  const binary = atob(dataUrl.slice(separator + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: 'image/png' });
}

export const imageRedactorInternals = {
  scaleBounds,
  padded,
  integerMaskBounds,
  expandedSemanticMaskBounds,
  bytesToBase64,
  dataUrlToBlob,
  placeholderFor,
  uniformViewportScale,
};

