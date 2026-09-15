import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isOffscreenMessage, isTrustedBackgroundSender, OFFSCREEN_TARGET, validateOffscreenRequest, type OffscreenRequest } from '../src/offscreen-protocol';
import type { RawDomSnapshot } from '../src/types';

vi.hoisted(() => { vi.stubGlobal('__FACE_MODEL_INCLUDED__', true); });
import { OffscreenSanitizer } from '../src/sanitizer-offscreen';

const dom: RawDomSnapshot = {
  documentId: 'document-1', documentRevision: 1, origin: 'https://private.invalid', title: 'Local only',
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 }, elements: [], redactions: [],
};
const png = 'data:image/png;base64,iVBORw0KGgo=';
const request: OffscreenRequest = {
  target: OFFSCREEN_TARGET, type: 'SANITIZE_CAPTURE', requestId: '12345678-1234-1234-1234-123456789abc',
  screenshot: png, dom, allowFullMaskFallback: false, canaries: ['Local-only private value'], privacyGrade: 3,
};
describe('offscreen local message boundary', () => {
  it('accepts only the same extension background context', () => {
    const id = 'own-extension';
    const background = `chrome-extension://${id}/background.js`;
    expect(isTrustedBackgroundSender({ id }, id, background)).toBe(true);
    expect(isTrustedBackgroundSender({ id, url: background }, id, background)).toBe(true);
    expect(isTrustedBackgroundSender({ id: 'other-extension' }, id, background)).toBe(false);
    expect(isTrustedBackgroundSender({ id, url: `chrome-extension://${id}/popup.html` }, id, background)).toBe(false);
    expect(isTrustedBackgroundSender({ id, url: 'https://private.invalid', tab: { id: 1 } as chrome.tabs.Tab }, id, background)).toBe(false);
    expect(isTrustedBackgroundSender({}, id, background)).toBe(false);
  });

  it('identifies IPC without consuming popup commands', () => {
    expect(isOffscreenMessage(request)).toBe(true);
    expect(isOffscreenMessage({ type: 'GET_STATUS' })).toBe(false);
    expect(isOffscreenMessage(null)).toBe(false);
  });

  it('accepts bounded local raster requests and rejects external image URLs or malformed metadata', () => {
    expect(() => validateOffscreenRequest(request)).not.toThrow();
    for (const patch of [
      { screenshot: 'https://private.invalid/screenshot.png' },
      { screenshot: 'data:image/jpeg;base64,AAAA' },
      { requestId: 'wrong' },
      { canaries: [3] },
      { canaries: ['x'.repeat(501)] },
      { allowFullMaskFallback: 'true' },
      { privacyGrade: 4 },
      { dom: { ...dom, viewport: { ...dom.viewport, width: 0 } } },
      { dom: { ...dom, viewport: { ...dom.viewport, height: Infinity } } },
    ]) expect(() => validateOffscreenRequest({ ...request, ...patch })).toThrow('Invalid local sanitization request');
  });

});

describe('Chrome offscreen sanitizer routing', () => {
  let createDocument: ReturnType<typeof vi.fn>;
  let hasDocument: ReturnType<typeof vi.fn>;
  let sendMessage: ReturnType<typeof vi.fn>;
  let api: typeof chrome;
  const raster = {
    dataBase64: 'sanitized-only', previewDataUrl: 'data:image/png;base64,sanitized-only', width: 800, height: 600,
    elements: [], redactions: [], detectorBackend: 'wasm', visualFallback: 'none', redactionMode: 'semantic',
  };

  beforeEach(() => {
    createDocument = vi.fn().mockResolvedValue(undefined);
    hasDocument = vi.fn().mockResolvedValue(false);
    sendMessage = vi.fn(async (value: OffscreenRequest) => ({
      target: OFFSCREEN_TARGET, requestId: value.requestId, ok: true, type: 'SANITIZE_RESULT', raster,
    }));
    api = { offscreen: { createDocument, hasDocument }, runtime: { sendMessage } } as unknown as typeof chrome;
  });

  it('creates one offscreen document for concurrent local requests and returns only its sanitized result', async () => {
    const sanitizer = new OffscreenSanitizer(api);
    const results = await Promise.all([
      sanitizer.sanitize(png, dom, false, request.canaries, 3),
      sanitizer.sanitize(png, dom, false, request.canaries, 3),
    ]);
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenCalledWith(expect.objectContaining({ url: 'offscreen.html', reasons: ['BLOBS'] }));
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]).toHaveLength(1); // No external extension ID or network endpoint.
    expect(sendMessage.mock.calls[0]![0]).toEqual(expect.objectContaining({ screenshot: png, dom, canaries: request.canaries }));
    expect(results).toEqual([raster, raster]);
    expect(sanitizer.state).toBe('wasm');
  });

  it('reuses an existing document after the service worker restarts', async () => {
    hasDocument.mockResolvedValue(true);
    await new OffscreenSanitizer(api).sanitize(png, dom, false, [], 3);
    expect(createDocument).not.toHaveBeenCalled();
  });

  it('blocks mismatched or failed replies without falling back to raw captures', async () => {
    for (const response of [undefined, { target: OFFSCREEN_TARGET, requestId: 'wrong', ok: true, raster }, { ok: false }]) {
      sendMessage.mockResolvedValue(response);
      const sanitizer = new OffscreenSanitizer(api);
      await expect(sanitizer.sanitize(png, dom, false, [], 3)).rejects.toThrow('transmission blocked');
      expect(sanitizer.state).toBe('error');
    }
  });

  it('sends nothing when local document creation fails, and permits a later retry', async () => {
    createDocument.mockRejectedValueOnce(new Error('Creation failed'));
    const sanitizer = new OffscreenSanitizer(api);
    await expect(sanitizer.sanitize(png, dom, false, [], 3)).rejects.toThrow('Creation failed');
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(sanitizer.sanitize(png, dom, false, [], 3)).resolves.toEqual(raster);
    expect(createDocument).toHaveBeenCalledTimes(2);
  });
});
