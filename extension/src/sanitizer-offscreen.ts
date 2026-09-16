import type { SanitizedRaster } from './image-redactor';
import { OFFSCREEN_TARGET, type OffscreenRequest, type OffscreenResponse } from './offscreen-protocol';
import type { RawDomSnapshot, SanitizedObservation } from './types';
import type { PrivacyGrade } from './privacy-policy';
import { ext } from './webext';

declare const __FACE_MODEL_INCLUDED__: boolean;
declare const __YOLO_MODEL_INCLUDED__: boolean;

const documentCreations = new WeakMap<object, Promise<void>>();

export async function ensureOffscreenDocument(api: typeof chrome): Promise<void> {
  if (!api.offscreen) throw new Error('Local offscreen processing is unavailable');
  const existing = documentCreations.get(api);
  if (existing) return existing;
  const creating = (async () => {
    if (await api.offscreen.hasDocument()) return;
    await api.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS' as chrome.offscreen.Reason],
      justification: 'Run local screenshot decoding, ONNX inference, redaction, and fresh PNG encoding.',
    });
  })();
  documentCreations.set(api, creating);
  try {
    await creating;
  } finally {
    if (documentCreations.get(api) === creating) documentCreations.delete(api);
  }
}

export class OffscreenSanitizer {
  private backend: SanitizedObservation['privacy']['detectorBackend'] =
    (typeof __YOLO_MODEL_INCLUDED__ !== 'undefined' && __YOLO_MODEL_INCLUDED__) ||
    (typeof __FACE_MODEL_INCLUDED__ !== 'undefined' && __FACE_MODEL_INCLUDED__)
      ? 'error'
      : 'missing';

  constructor(private readonly api: typeof chrome) {}

  get state() { return this.backend; }

  async sanitize(
    screenshot: string,
    dom: RawDomSnapshot,
    allowFullMaskFallback: boolean,
    canaries: readonly string[],
    privacyGrade: PrivacyGrade,
    task = '',
  ): Promise<SanitizedRaster> {
    await ensureOffscreenDocument(this.api);
    const request: OffscreenRequest = {
      target: OFFSCREEN_TARGET, type: 'SANITIZE_CAPTURE', requestId: crypto.randomUUID(),
      screenshot, dom, allowFullMaskFallback, canaries, privacyGrade, task,
    };
    // runtime.sendMessage is extension-local IPC, not a server request. This
    // module has no network client; raw captures never enter egress.ts.
    let response: OffscreenResponse | undefined;
    try {
      response = await this.api.runtime.sendMessage(request) as OffscreenResponse | undefined;
    } catch {
      this.backend = 'error';
      throw new Error('Local offscreen document unavailable; transmission blocked');
    }
    if (!response || response.target !== OFFSCREEN_TARGET || response.requestId !== request.requestId ||
      !response.ok || response.type !== 'SANITIZE_RESULT' || !response.raster) {
      this.backend = 'error';
      const detail = response && !response.ok && typeof response.error === 'string'
        ? response.error.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 300)
        : '';
      throw new Error(detail || 'Local offscreen sanitization failed; transmission blocked');
    }
    this.backend = response.raster.detectorBackend;
    return response.raster;
  }
}

export const localSanitizer = new OffscreenSanitizer(ext);
