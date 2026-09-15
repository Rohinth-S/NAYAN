import { isOffscreenMessage, isTrustedBackgroundSender, OFFSCREEN_TARGET, validateOffscreenRequest, type OffscreenResponse } from './offscreen-protocol';
import { localSanitizer } from './sanitizer-direct';
import { ext, runtimeUrl } from './webext';

ext.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isOffscreenMessage(message) || !isTrustedBackgroundSender(sender, ext.runtime.id, runtimeUrl('background.js'))) return false;
  try {
    validateOffscreenRequest(message);
  } catch {
    sendResponse({ target: OFFSCREEN_TARGET, requestId: '', ok: false, error: 'Invalid local sanitization request' });
    return false;
  }
  const request = message;
  void localSanitizer.sanitize(
    request.screenshot,
    request.dom,
    request.allowFullMaskFallback,
    request.canaries,
    request.privacyGrade,
  )
    .then((raster) => sendResponse({
      target: OFFSCREEN_TARGET, requestId: request.requestId, ok: true, type: 'SANITIZE_RESULT', raster,
    } satisfies OffscreenResponse))
    .catch((error: unknown) => sendResponse({
      target: OFFSCREEN_TARGET, requestId: request.requestId, ok: false,
      // This stays inside extension-local IPC. Keep it bounded and omit any
      // request/page data so the popup can distinguish detector/runtime
      // failures while preserving the fail-closed network boundary.
      error: localSanitizationError(error),
    } satisfies OffscreenResponse));
  return true;
});

function localSanitizationError(error: unknown): string {
  if (!(error instanceof Error)) return 'Local sanitization failed';
  const detail = error.message.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 240);
  return detail ? `Local sanitization failed: ${detail}` : 'Local sanitization failed';
}
