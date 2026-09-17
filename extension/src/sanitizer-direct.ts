import { LocalFaceDetector } from './face-detector';
import { sanitizeRaster } from './image-redactor';
import { sanitizeText } from './privacy';
import type { PrivacyGrade } from './privacy-policy';
import type { RawDomSnapshot } from './types';
import { createBrowserPerceptionRuntime } from './perception-runtime';
import { createBrowserDocumentOcrRuntime } from './document-ocr';
import { UltraFaceAdapter } from './vision-detector';
import { UnifiedYoloDetector } from './yolo-detector';

declare const __PERCEPTION_ENABLED__: boolean;
declare const __OCR_ENABLED__: boolean;
declare const __YOLO_MODEL_INCLUDED__: boolean;
const perception = typeof __PERCEPTION_ENABLED__ !== 'undefined' && __PERCEPTION_ENABLED__ ? createBrowserPerceptionRuntime() : undefined;
const documentOcr = typeof __OCR_ENABLED__ !== 'undefined' && __OCR_ENABLED__ ? createBrowserDocumentOcrRuntime() : undefined;

const faceDetector = new LocalFaceDetector();
const detector = typeof __YOLO_MODEL_INCLUDED__ !== 'undefined' && __YOLO_MODEL_INCLUDED__
  ? new UnifiedYoloDetector()
  : new UltraFaceAdapter(faceDetector);

// Firefox has a document-backed background page. Chrome uses this module only
// inside its offscreen document, never inside the MV3 service worker.
export const localSanitizer = {
  get state() { return detector.state; },
  sanitize(
    screenshot: string,
    dom: RawDomSnapshot,
    allowFullMaskFallback: boolean,
    canaries: readonly string[],
    privacyGrade: PrivacyGrade,
    task = '',
    highAssuranceMode = false,
  ) {
    return sanitizeRaster(
      screenshot,
      dom,
      detector,
      allowFullMaskFallback,
      privacyGrade,
      (label) => sanitizeText(label, canaries, 300, privacyGrade),
      perception ? { runtime: perception, task, canaries } : undefined,
      documentOcr,
      highAssuranceMode,
    );
  },
};
