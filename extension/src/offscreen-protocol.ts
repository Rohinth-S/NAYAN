import type { SanitizedRaster } from './image-redactor';
import type { RawDomSnapshot } from './types';
import { isPrivacyGrade, type PrivacyGrade } from './privacy-policy';

export const OFFSCREEN_TARGET = 'privacy-offscreen' as const;

export type OffscreenSanitizeRequest = Readonly<{
  target: typeof OFFSCREEN_TARGET;
  type: 'SANITIZE_CAPTURE';
  requestId: string;
  screenshot: string;
  dom: RawDomSnapshot;
  allowFullMaskFallback: boolean;
  canaries: readonly string[];
  privacyGrade: PrivacyGrade;
}>;

export type OffscreenRequest = OffscreenSanitizeRequest;

export type OffscreenResponse =
  | { target: typeof OFFSCREEN_TARGET; requestId: string; ok: true; type: 'SANITIZE_RESULT'; raster: SanitizedRaster }
  | { target: typeof OFFSCREEN_TARGET; requestId: string; ok: false; error: string };

export function isOffscreenMessage(message: unknown): boolean {
  return !!message && typeof message === 'object' && 'target' in message && message.target === OFFSCREEN_TARGET;
}

export function isTrustedBackgroundSender(sender: chrome.runtime.MessageSender, extensionId: string, backgroundUrl: string): boolean {
  // Content scripts carry sender.tab; extension pages have a specific URL.
  // Chrome can omit the URL for the extension service worker.
  return sender.id === extensionId && sender.tab === undefined && (sender.url === undefined || sender.url === backgroundUrl);
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/u.test(value);
}

function validCanaries(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 100 &&
    value.every((item: unknown) => typeof item === 'string' && item.length <= 500);
}

export function validateOffscreenRequest(value: unknown): asserts value is OffscreenRequest {
  if (!isOffscreenMessage(value)) throw new Error('Invalid local sanitization request');
  const request = value as Partial<OffscreenRequest>;
  if (
    request.type !== 'SANITIZE_CAPTURE' ||
    !validRequestId(request.requestId) ||
    typeof request.screenshot !== 'string' || !request.screenshot.startsWith('data:image/png;base64,') || request.screenshot.length > 16_000_022 ||
    typeof request.allowFullMaskFallback !== 'boolean' ||
    !isPrivacyGrade(request.privacyGrade) ||
    !validCanaries(request.canaries) ||
    !request.dom || typeof request.dom !== 'object' ||
    !Array.isArray(request.dom.elements) || !Array.isArray(request.dom.redactions) ||
    !request.dom.viewport || !Number.isFinite(request.dom.viewport.width) || !Number.isFinite(request.dom.viewport.height) ||
    request.dom.viewport.width <= 0 || request.dom.viewport.height <= 0
  ) throw new Error('Invalid local sanitization request');
}
