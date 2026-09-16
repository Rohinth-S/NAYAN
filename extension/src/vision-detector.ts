/**
 * Approach B: unified multi-class vision detector interface.
 *
 * Replaces the Approach A multi-model ensemble (UltraFace + separate
 * document detectors) with a single YOLOv8n/v10n forward pass that
 * detects faces AND Indian document IDs (aadhaar_card, pan_card,
 * voter_id, driving_license, passport, signature) simultaneously.
 *
 * This reduces Layer-2 inference cost by ~50% compared to running
 * separate models for each detection class.
 *
 * Currently wraps the existing UltraFace detector as a compatibility
 * shim. When the unified YOLOv8n/v10n model is available, swap the
 * implementation without changing any caller code.
 */

import type { Bounds, SanitizedObservation, VisionDetectionClass } from './types';

export type VisionDetection = Readonly<{
  /** The detected object class. */
  class: VisionDetectionClass;
  /** Bounding box in image coordinates. */
  bounds: Bounds;
  /** Detection confidence from the model. */
  confidence: number;
}>;

export type VisionDetectionResult = Readonly<{
  /** Which execution backend was used. */
  backend: SanitizedObservation['privacy']['detectorBackend'];
  /** Which model architecture produced these detections. */
  arch: 'ultraface' | 'yolov8n' | 'yolov10n';
  /** All detections from the unified forward pass. */
  detections: readonly VisionDetection[];
}>;

/**
 * Abstract interface for the unified vision detector.
 * Callers depend on this interface, not on a specific model implementation.
 */
export interface UnifiedVisionDetector {
  /** Current detector backend state. */
  readonly state: SanitizedObservation['privacy']['detectorBackend'];

  /** Human-readable diagnostic for the last failure. */
  readonly diagnostic: string;

  /**
   * Run detection on a screenshot bitmap. Returns all detected objects
   * across all supported classes in a single result.
   */
  detect(bitmap: ImageBitmap): Promise<VisionDetectionResult>;
}

/**
 * Adapter that wraps the existing LocalFaceDetector as a UnifiedVisionDetector.
 * This preserves backward compatibility while the unified YOLOv8n/v10n model
 * is being trained and exported.
 *
 * When the unified model is ready:
 * 1. Create a new class implementing UnifiedVisionDetector
 * 2. Replace the import in sanitizer-offscreen.ts / sanitizer-direct.ts
 * 3. The rest of the pipeline (redaction, validation, egress) works unchanged
 */
export class UltraFaceAdapter implements UnifiedVisionDetector {
  private faceDetector: {
    state: SanitizedObservation['privacy']['detectorBackend'];
    diagnostic: string;
    detect(bitmap: ImageBitmap): Promise<{
      backend: SanitizedObservation['privacy']['detectorBackend'];
      boxes: readonly Bounds[];
    }>;
  };

  constructor(faceDetector: UltraFaceAdapter['faceDetector']) {
    this.faceDetector = faceDetector;
  }

  get state(): SanitizedObservation['privacy']['detectorBackend'] {
    return this.faceDetector.state;
  }

  get diagnostic(): string {
    return this.faceDetector.diagnostic;
  }

  async detect(bitmap: ImageBitmap): Promise<VisionDetectionResult> {
    const result = await this.faceDetector.detect(bitmap);

    // Convert face-only results to unified detection format.
    // Confidence is set to 1.0 for UltraFace detections since the
    // threshold is already applied internally.
    const detections: VisionDetection[] = result.boxes.map((box) => ({
      class: 'face' as const,
      bounds: box,
      confidence: 1.0,
    }));

    return {
      backend: result.backend,
      arch: 'ultraface' as const,
      detections,
    };
  }
}

/**
 * Stub for the future unified YOLOv8n/v10n detector.
 * Drop a trained ONNX model at extension/models/yolo-privacy-v1.onnx
 * and implement this class to replace UltraFaceAdapter.
 */
// export class UnifiedYoloDetector implements UnifiedVisionDetector {
//   async detect(bitmap: ImageBitmap): Promise<VisionDetectionResult> {
//     // Single forward pass: face + aadhaar_card + pan_card + voter_id
//     //                      + driving_license + passport + signature
//     throw new Error('Not yet implemented — awaiting trained model');
//   }
// }
