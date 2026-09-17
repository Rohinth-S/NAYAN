/**
 * Approach B: Unified YOLOv8-nano / YOLOv10-nano multi-class detector.
 *
 * Single-pass ONNX inference that detects faces AND Indian document IDs:
 *   face, aadhaar_card, pan_card, voter_id, driving_license, passport, signature
 *
 * Architecture:
 *   - Input: 640×640 RGB, letterbox-padded, normalized [0,1], NCHW layout
 *   - YOLOv8n output: [1, 4+num_classes, num_detections] → transpose → NMS
 *   - YOLOv10n output: [1, num_detections, 6] → no NMS needed (end-to-end)
 *
 * Model file expected at: extension/models/yolo-privacy-v1.onnx
 * Export command (reference):
 *   yolo export model=yolo-privacy-v1.pt format=onnx imgsz=640 simplify
 */

import * as ort from 'onnxruntime-web/webgpu';
import type { Bounds, SanitizedObservation, VisionDetectionClass } from './types';
import type { VisionDetection, VisionDetectionResult, UnifiedVisionDetector } from './vision-detector';
import { runtimeUrl } from './webext';

declare const __YOLO_MODEL_INCLUDED__: boolean;

const YOLO_INPUT_SIZE = 640;
const SCORE_THRESHOLD = 0.45;
const NMS_IOU_THRESHOLD = 0.50;

/** Class index → detection class mapping (matches training label order). */
const CLASS_MAP: readonly VisionDetectionClass[] = [
  'face',
  'aadhaar_card',
  'pan_card',
  'voter_id',
  'driving_license',
  'passport',
  'signature',
];

type DetectorVariant = 'yolov8n' | 'yolov10n';

/**
 * Detect the model variant from output tensor shapes.
 * YOLOv8n: output shape [1, 4+num_classes, num_boxes] → needs transpose + NMS
 * YOLOv10n: output shape [1, num_boxes, 6] → end-to-end, no NMS needed
 */
function detectVariant(output: ort.Tensor): DetectorVariant {
  const dims = output.dims;
  // YOLOv10n: [1, N, 6] where 6 = [x1, y1, x2, y2, score, class_id]
  if (dims.length === 3 && dims[2] === 6) return 'yolov10n';
  // YOLOv8n: [1, 4+num_classes, N]
  return 'yolov8n';
}

export class UnifiedYoloDetector implements UnifiedVisionDetector {
  private session: ort.InferenceSession | null = null;
  private backend: SanitizedObservation['privacy']['detectorBackend'] =
    (typeof __YOLO_MODEL_INCLUDED__ !== 'undefined' && __YOLO_MODEL_INCLUDED__) ? 'error' : 'missing';
  private initialization: Promise<void> | null = null;
  private wasmFallback: Promise<boolean> | null = null;
  private failure =
    (typeof __YOLO_MODEL_INCLUDED__ !== 'undefined' && __YOLO_MODEL_INCLUDED__) ? 'not initialized' : 'model missing';
  private variant: DetectorVariant = 'yolov8n';

  get state(): SanitizedObservation['privacy']['detectorBackend'] {
    return this.backend;
  }

  get diagnostic(): string {
    return this.failure;
  }

  async detect(bitmap: ImageBitmap): Promise<VisionDetectionResult> {
    await this.initialize();
    if (!this.session || !['webgpu', 'wasm'].includes(this.backend)) {
      return { backend: this.backend, arch: this.variant, detections: [] };
    }

    const { tensor, scale, padX, padY } = preprocessYolo(bitmap);
    const backendAtStart = this.backend;
    const sessionAtStart = this.session;

    try {
      return await this.runInference(tensor, bitmap.width, bitmap.height, scale, padX, padY);
    } catch (error) {
      reportFailure('inference', error);

      // WebGPU → WASM fallback (same pattern as UltraFace)
      if (backendAtStart === 'webgpu') {
        const gpuFailure = failureDetail(error);
        await this.releaseSession(sessionAtStart);
        if (await this.initializeWasm(gpuFailure)) {
          try {
            const retry = preprocessYolo(bitmap);
            return await this.runInference(retry.tensor, bitmap.width, bitmap.height, retry.scale, retry.padX, retry.padY);
          } catch (wasmError) {
            reportFailure('WASM inference', wasmError);
            this.failure = `WebGPU: ${gpuFailure}; WASM: ${failureDetail(wasmError)}`.slice(0, 480);
          }
        }
      } else {
        this.failure = failureDetail(error);
      }
      this.backend = 'error';
      this.session = null;
      return { backend: 'error', arch: this.variant, detections: [] };
    }
  }

  private async runInference(
    input: ort.Tensor,
    imgWidth: number,
    imgHeight: number,
    scale: number,
    padX: number,
    padY: number,
  ): Promise<VisionDetectionResult> {
    const session = this.session;
    if (!session || !['webgpu', 'wasm'].includes(this.backend)) {
      return { backend: this.backend, arch: this.variant, detections: [] };
    }

    const outputs = await session.run({ [session.inputNames[0]!]: input });
    const outputTensor = Object.values(outputs)[0]!;
    this.variant = detectVariant(outputTensor);

    const detections = this.variant === 'yolov10n'
      ? decodeYolov10(outputTensor, imgWidth, imgHeight, scale, padX, padY)
      : decodeYolov8(outputTensor, imgWidth, imgHeight, scale, padX, padY);

    return { backend: this.backend, arch: this.variant, detections };
  }

  // ---------- initialization ----------

  private async initialize(): Promise<void> {
    if (this.session || this.backend === 'missing') return;
    if (this.initialization) return this.initialization;
    this.initialization = this.initializeOnce();
    await this.initialization;
  }

  private async initializeOnce(): Promise<void> {
    if (typeof __YOLO_MODEL_INCLUDED__ === 'undefined' || !__YOLO_MODEL_INCLUDED__) {
      this.backend = 'missing';
      return;
    }

    ort.env.wasm.wasmPaths = {
      mjs: runtimeUrl('wasm/ort-wasm-simd-threaded.jsep.mjs'),
      wasm: runtimeUrl('wasm/ort-wasm-simd-threaded.jsep.wasm'),
    };
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const model = runtimeUrl('models/yolo-privacy-v1.onnx');

    // Probe WebGPU adapter availability
    const gpu = (navigator as Navigator & {
      gpu?: { requestAdapter(options?: { powerPreference?: string }): Promise<unknown | null> };
    }).gpu;
    let hasAdapter = false;
    if (gpu) {
      try { hasAdapter = (await gpu.requestAdapter({ powerPreference: 'low-power' })) !== null; }
      catch { hasAdapter = false; }
    }

    if (hasAdapter) {
      try {
        this.session = await ort.InferenceSession.create(model, {
          executionProviders: ['webgpu'],
          graphOptimizationLevel: 'all',
          logSeverityLevel: 3,
        });
        this.backend = 'webgpu';
        return;
      } catch (error) {
        reportFailure('WebGPU initialization', error);
        this.failure = failureDetail(error);
        this.session = null;
      }
    }
    await this.initializeWasm();
  }

  private async initializeWasm(previousFailure = ''): Promise<boolean> {
    if (this.session && this.backend === 'wasm') return true;
    if (this.wasmFallback) return this.wasmFallback;
    const creating = (async () => {
      try {
        const model = runtimeUrl('models/yolo-privacy-v1.onnx');
        this.session = await ort.InferenceSession.create(model, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
          logSeverityLevel: 3,
        });
        this.backend = 'wasm';
        this.failure = '';
        return true;
      } catch (error) {
        reportFailure('WASM initialization', error);
        const wasmFailure = failureDetail(error);
        this.failure = previousFailure
          ? `WebGPU: ${previousFailure}; WASM: ${wasmFailure}`.slice(0, 480)
          : wasmFailure;
        this.session = null;
        this.backend = 'error';
        return false;
      }
    })();
    this.wasmFallback = creating;
    try { return await creating; }
    finally { if (this.wasmFallback === creating) this.wasmFallback = null; }
  }

  private async releaseSession(expected: ort.InferenceSession | null): Promise<void> {
    if (!expected || this.session !== expected) return;
    this.session = null;
    try { await expected.release(); }
    catch (error) { reportFailure('session release', error); }
  }
}

// ---------- preprocessing ----------

function preprocessYolo(bitmap: ImageBitmap): {
  tensor: ort.Tensor;
  scale: number;
  padX: number;
  padY: number;
} {
  // Letterbox resize to 640×640 preserving aspect ratio
  const scale = Math.min(YOLO_INPUT_SIZE / bitmap.width, YOLO_INPUT_SIZE / bitmap.height);
  const newW = Math.round(bitmap.width * scale);
  const newH = Math.round(bitmap.height * scale);
  const padX = Math.round((YOLO_INPUT_SIZE - newW) / 2);
  const padY = Math.round((YOLO_INPUT_SIZE - newH) / 2);

  const canvas = new OffscreenCanvas(YOLO_INPUT_SIZE, YOLO_INPUT_SIZE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is unavailable');

  // Fill with gray (114/255 ≈ 0.447) — standard YOLO letterbox padding
  ctx.fillStyle = '#727272';
  ctx.fillRect(0, 0, YOLO_INPUT_SIZE, YOLO_INPUT_SIZE);
  ctx.drawImage(bitmap, padX, padY, newW, newH);

  const pixels = ctx.getImageData(0, 0, YOLO_INPUT_SIZE, YOLO_INPUT_SIZE).data;
  const float32 = new Float32Array(3 * YOLO_INPUT_SIZE * YOLO_INPUT_SIZE);
  const plane = YOLO_INPUT_SIZE * YOLO_INPUT_SIZE;

  for (let i = 0; i < plane; i++) {
    const px = i * 4;
    // Normalize to [0, 1] — NCHW layout
    float32[i] = pixels[px]! / 255;
    float32[plane + i] = pixels[px + 1]! / 255;
    float32[plane * 2 + i] = pixels[px + 2]! / 255;
  }

  return {
    tensor: new ort.Tensor('float32', float32, [1, 3, YOLO_INPUT_SIZE, YOLO_INPUT_SIZE]),
    scale,
    padX,
    padY,
  };
}

// ---------- YOLOv8n postprocessing (requires NMS) ----------

type Candidate = VisionDetection & { score: number };

function decodeYolov8(
  output: ort.Tensor,
  imgWidth: number,
  imgHeight: number,
  scale: number,
  padX: number,
  padY: number,
): VisionDetection[] {
  // YOLOv8n output: [1, 4+num_classes, num_detections]
  const data = output.data as Float32Array;
  const numClasses = CLASS_MAP.length;
  const rows = 4 + numClasses;         // e.g. 11 = 4 + 7
  const numDetections = output.dims[2]!;
  const candidates: Candidate[] = [];

  for (let d = 0; d < numDetections; d++) {
    // Find best class
    let bestClass = 0;
    let bestScore = -Infinity;
    for (let c = 0; c < numClasses; c++) {
      const score = Number(data[(4 + c) * numDetections + d]);
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }
    if (!Number.isFinite(bestScore) || bestScore < SCORE_THRESHOLD) continue;

    // Decode box (cx, cy, w, h) → (x1, y1, x2, y2) in input space
    const cx = Number(data[0 * numDetections + d]);
    const cy = Number(data[1 * numDetections + d]);
    const bw = Number(data[2 * numDetections + d]);
    const bh = Number(data[3 * numDetections + d]);
    const x1 = cx - bw / 2;
    const y1 = cy - bh / 2;
    const x2 = cx + bw / 2;
    const y2 = cy + bh / 2;

    // Map from letterbox coordinates back to original image
    const bounds = letterboxToOriginal(x1, y1, x2, y2, scale, padX, padY, imgWidth, imgHeight);
    if (!bounds) continue;

    candidates.push({
      class: CLASS_MAP[bestClass]!,
      bounds,
      confidence: bestScore,
      score: bestScore,
    });
  }

  return nms(candidates, NMS_IOU_THRESHOLD).map(({ score: _, ...det }) => det);
}

// ---------- YOLOv10n postprocessing (end-to-end, no NMS) ----------

function decodeYolov10(
  output: ort.Tensor,
  imgWidth: number,
  imgHeight: number,
  scale: number,
  padX: number,
  padY: number,
): VisionDetection[] {
  // YOLOv10n output: [1, num_detections, 6] where 6 = [x1, y1, x2, y2, score, class_id]
  const data = output.data as Float32Array;
  const numDetections = output.dims[1]!;
  const detections: VisionDetection[] = [];

  for (let d = 0; d < numDetections; d++) {
    const offset = d * 6;
    const x1 = Number(data[offset]);
    const y1 = Number(data[offset + 1]);
    const x2 = Number(data[offset + 2]);
    const y2 = Number(data[offset + 3]);
    const score = Number(data[offset + 4]);
    const classId = Math.round(Number(data[offset + 5]));

    if (!Number.isFinite(score) || score < SCORE_THRESHOLD) continue;
    if (classId < 0 || classId >= CLASS_MAP.length) continue;

    const bounds = letterboxToOriginal(x1, y1, x2, y2, scale, padX, padY, imgWidth, imgHeight);
    if (!bounds) continue;

    detections.push({
      class: CLASS_MAP[classId]!,
      bounds,
      confidence: score,
    });
  }

  return detections;
}

// ---------- coordinate transforms ----------

function letterboxToOriginal(
  x1: number, y1: number, x2: number, y2: number,
  scale: number, padX: number, padY: number,
  imgWidth: number, imgHeight: number,
): Bounds | null {
  // Remove letterbox padding and scale back to original coordinates
  const ox1 = clamp((x1 - padX) / scale, 0, imgWidth);
  const oy1 = clamp((y1 - padY) / scale, 0, imgHeight);
  const ox2 = clamp((x2 - padX) / scale, 0, imgWidth);
  const oy2 = clamp((y2 - padY) / scale, 0, imgHeight);
  const w = ox2 - ox1;
  const h = oy2 - oy1;
  if (w <= 0 || h <= 0) return null;
  return { x: ox1, y: oy1, width: w, height: h };
}

// ---------- NMS ----------

function nms(candidates: readonly Candidate[], threshold: number): Candidate[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const accepted: Candidate[] = [];
  while (sorted.length) {
    const best = sorted.shift()!;
    accepted.push(best);
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (iou(best.bounds, sorted[i]!.bounds) > threshold) sorted.splice(i, 1);
    }
  }
  return accepted;
}

function iou(a: Bounds, b: Bounds): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// ---------- diagnostics ----------

function reportFailure(stage: string, error: unknown): void {
  const detail = failureDetail(error);
  console.warn(`[privacy-agent] YOLO unified detector ${stage} failed (${detail})`);
}

function failureDetail(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message.slice(0, 240)}` : 'unknown error';
}

/** Exported for testing. */
export const yoloInternals = { preprocessYolo, decodeYolov8, decodeYolov10, nms, iou, CLASS_MAP };
