import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureDocumentSource } from '../src/document-source';

const bounds = { x: 10, y: 20, width: 300, height: 200 };
class TestImage {
  complete = true;
  naturalWidth = 900;
  naturalHeight = 600;
  parentElement = null;
  getBoundingClientRect() { return bounds; }
}
function setup(overrides: Record<string, string> = {}, tainted = false) {
  const canvas = { width: 0, height: 0, toDataURL: vi.fn(() => {
    if (tainted) throw new DOMException('Tainted canvas', 'SecurityError');
    return 'data:image/png;base64,localpixels';
  }), getContext: () => ({ fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() }) };
  const createElement = vi.fn(() => canvas);
  vi.stubGlobal('HTMLImageElement', TestImage);
  vi.stubGlobal('document', { createElement });
  vi.stubGlobal('getComputedStyle', () => ({ transform: 'none', filter: 'none', mixBlendMode: 'normal', opacity: '1', ...overrides }));
  return { image: new TestImage() as unknown as Element, canvas, createElement };
}
afterEach(() => vi.unstubAllGlobals());

describe('local document image source', () => {
  it('keeps original loaded pixels for OCR at reduced page zoom and releases the temporary canvas', () => {
    const { image, canvas } = setup();
    expect(captureDocumentSource(image, bounds, 1_000_000)).toEqual({ dataUrl: 'data:image/png;base64,localpixels', width: 900, height: 600 });
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
  });
  it('falls back for cross-origin images instead of fetching or requesting permissions', () => {
    const { image, canvas } = setup({}, true);
    expect(captureDocumentSource(image, bounds, 1_000_000)).toBeUndefined();
    expect(canvas.width).toBe(1);
  });
  it('rejects clipped, letterboxed and distorted geometry', () => {
    const { image, createElement } = setup();
    expect(captureDocumentSource(image, { ...bounds, height: 160 }, 1_000_000)).toBeUndefined();
    (image as unknown as TestImage).naturalHeight = 900;
    expect(captureDocumentSource(image, bounds, 1_000_000)).toBeUndefined();
    expect(createElement).not.toHaveBeenCalled();
  });
  it.each([{ filter: 'blur(2px)' }, { transform: 'rotate(10deg)' }, { opacity: '0.5' }, { paddingLeft: '5px' }])('rejects CSS that changes the source-to-screen mapping: %o', style => {
    const { image } = setup(style);
    expect(captureDocumentSource(image, bounds, 1_000_000)).toBeUndefined();
  });
  it('enforces a cumulative pixel budget before allocating a canvas', () => {
    const { image, createElement } = setup();
    expect(captureDocumentSource(image, bounds, 200_000)).toBeUndefined();
    expect(createElement).not.toHaveBeenCalled();
  });
  it('does not use partially loaded image data', () => {
    const { image } = setup();
    (image as unknown as TestImage).complete = false;
    expect(captureDocumentSource(image, bounds, 1_000_000)).toBeUndefined();
  });
});
