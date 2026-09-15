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
    .catch(() => sendResponse({
      target: OFFSCREEN_TARGET, requestId: request.requestId, ok: false, error: 'Local sanitization failed',
    } satisfies OffscreenResponse));
  return true;
});
