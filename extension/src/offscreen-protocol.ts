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
  highAssuranceMode?: boolean;
  canaries: readonly string[];
  privacyGrade: PrivacyGrade;
  task?: string;
}>;

export type OffscreenRequest = OffscreenSanitizeRequest;

export type OffscreenResponse =
  | { target: typeof OFFSCREEN_TARGET; requestId: string; ok: true; type: 'SANITIZE_RESULT'; raster: SanitizedRaster }
  | { target: typeof OFFSCREEN_TARGET; requestId: string; ok: false; error: string };

export function isOffscreenMessage(message: unknown): boolean {
  return !!message && typeof message === 'object' && 'target' in message && message.target === OFFSCREEN_TARGET;
}

export function isTrustedBackgroundSender(sender: chrome.runtime.MessageSender, extensionId: string, backgroundUrl: string): boolean {
  // Content scripts carry sender.tab. Chrome can omit the URL for the
  // extension service worker, while some Chrome versions report the worker's
  // extension origin (`chrome-extension://<id>/`) instead of the script URL.
  // Keep the check origin-bound and allow only that root or the known
  // background script; popup/options pages must remain excluded.
  if (sender.id !== extensionId || sender.tab != null) return false;
  if (sender.url === undefined || sender.url === backgroundUrl) return true;
  try {
    const actual = new URL(sender.url);
    const expected = new URL(backgroundUrl);
    if (actual.origin !== expected.origin || actual.hash) return false;
    return actual.pathname === '' || actual.pathname === '/' || actual.pathname === expected.pathname;
  } catch {
    return false;
  }
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
    (request.highAssuranceMode !== undefined && typeof request.highAssuranceMode !== 'boolean') ||
    !isPrivacyGrade(request.privacyGrade) ||
    !validCanaries(request.canaries) ||
    (request.task !== undefined && (typeof request.task !== 'string' || request.task.length > 2000)) ||
    !request.dom || typeof request.dom !== 'object' ||
    !Array.isArray(request.dom.elements) || !Array.isArray(request.dom.redactions) ||
    !request.dom.viewport || !Number.isFinite(request.dom.viewport.width) || !Number.isFinite(request.dom.viewport.height) ||
    request.dom.viewport.width <= 0 || request.dom.viewport.height <= 0
  ) throw new Error('Invalid local sanitization request');
}
