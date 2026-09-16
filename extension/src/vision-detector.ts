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
 * The runtime selects the unified YOLO implementation when its model asset
 * is packaged. UltraFace remains a deliberately supported compatibility
 * fallback so a model-free development build can still fail closed or run
 * face-only checks without changing callers.
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
 * It is selected only when the unified YOLO model asset is absent.
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
