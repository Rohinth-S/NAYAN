import { LocalFaceDetector } from './face-detector';
import { sanitizeRaster } from './image-redactor';
import { sanitizeText } from './privacy';
import type { PrivacyGrade } from './privacy-policy';
import type { RawDomSnapshot } from './types';

const detector = new LocalFaceDetector();

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
  ) {
    return sanitizeRaster(
      screenshot,
      dom,
      detector,
      allowFullMaskFallback,
      privacyGrade,
      (label) => sanitizeText(label, canaries, 300, privacyGrade),
    );
  },
};
