import type { Bounds } from './types';

export type LocalDocumentImage = Readonly<{ dataUrl: string; width: number; height: number }>;
export const DOCUMENT_SOURCE_PIXEL_BUDGET = 4_194_304;

/** Read already-loaded image pixels on this device; never fetch its URL. */
export function captureDocumentSource(element: Element, bounds: Bounds, pixelBudget: number): LocalDocumentImage | undefined {
  if (!(element instanceof HTMLImageElement) || !element.complete || element.naturalWidth < 1 || element.naturalHeight < 1) return;
  const rect = element.getBoundingClientRect();
  // A clipped or cover-fit image cannot use a whole-image coordinate map.
  if (Math.abs(bounds.width - rect.width) > 0.5 || Math.abs(bounds.height - rect.height) > 0.5) return;
  if (Math.abs((rect.width / rect.height) / (element.naturalWidth / element.naturalHeight) - 1) > 0.015) return;
  for (let parent: Element | null = element; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.transform !== 'none' || style.filter !== 'none' || style.mixBlendMode !== 'normal' || Number(style.opacity) !== 1) return;
  }
  const style = getComputedStyle(element);
  if (['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'borderLeftWidth', 'borderRightWidth', 'borderTopWidth', 'borderBottomWidth']
    .some(key => Number.parseFloat(style[key as keyof CSSStyleDeclaration] as string) > 0)) return;
  const scale = Math.min(1, 1_600 / Math.max(element.naturalWidth, element.naturalHeight));
  const width = Math.max(1, Math.round(element.naturalWidth * scale));
  const height = Math.max(1, Math.round(element.naturalHeight * scale));
  if (width * height > pixelBudget) return;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(element, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/png');
    if (dataUrl.length > 3_000_000) return;
    return { dataUrl, width, height };
  } catch {
    // Cross-origin canvas restrictions keep this on screenshot OCR. No new
    // network request or site permission is made to obtain source pixels.
    return;
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}
