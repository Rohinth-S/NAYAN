/**
 * Approach B: DBNet text region detector for canvas-app PII mitigation.
 *
 * Performs detection-only blind text masking — it finds text regions in
 * canvas-rendered content (Google Docs, Figma, etc.) WITHOUT performing
 * OCR. No text content ever leaves the device; only bounding boxes of
 * detected text regions are returned for masking as [REDACTED:CANVAS_TEXT].
 *
 * Architecture:
 *   - Input: resized image (max dimension 736), normalized, NCHW layout
 *   - Output: probability map [1, 1, H, W] of text presence per pixel
 *   - Postprocessing: threshold → contour detection → bounding boxes
 *
 * Model file expected at: extension/models/dbnet-text-det.onnx
 * Reference: "Real-time Scene Text Detection with Differentiable Binarization"
 */

import * as ort from 'onnxruntime-web/webgpu';
import type { Bounds, SanitizedObservation } from './types';
import { runtimeUrl } from './webext';

declare const __DBNET_MODEL_INCLUDED__: boolean;

const DBNET_MAX_DIM = 736;
const DBNET_BINARY_THRESHOLD = 0.3;
const DBNET_BOX_THRESHOLD = 0.6;
const DBNET_MIN_BOX_AREA = 64;
const DBNET_MEAN = [0.485, 0.456, 0.406] as const;
const DBNET_STD = [0.229, 0.224, 0.225] as const;

export type TextRegionDetection = Readonly<{
  bounds: Bounds;
  confidence: number;
}>;

export type DbnetResult = Readonly<{
  backend: SanitizedObservation['privacy']['detectorBackend'];
  regions: readonly TextRegionDetection[];
}>;

export class DbnetTextDetector {
  private session: ort.InferenceSession | null = null;
  private backend: SanitizedObservation['privacy']['detectorBackend'] =
    (typeof __DBNET_MODEL_INCLUDED__ !== 'undefined' && __DBNET_MODEL_INCLUDED__) ? 'error' : 'missing';
  private initialization: Promise<void> | null = null;
  private failure =
    (typeof __DBNET_MODEL_INCLUDED__ !== 'undefined' && __DBNET_MODEL_INCLUDED__) ? 'not initialized' : 'model missing';

  get state(): SanitizedObservation['privacy']['detectorBackend'] {
    return this.backend;
  }

  get diagnostic(): string {
    return this.failure;
  }

  get available(): boolean {
    return this.backend === 'webgpu' || this.backend === 'wasm';
  }

  /**
   * Detect text regions in a canvas screenshot.
   * Returns bounding boxes of detected text — NO text content is extracted.
   */
  async detect(bitmap: ImageBitmap): Promise<DbnetResult> {
    await this.initialize();
    if (!this.session || !['webgpu', 'wasm'].includes(this.backend)) {
      return { backend: this.backend, regions: [] };
    }

    try {
      const { tensor, scaleW, scaleH, resizedW, resizedH } = preprocessDbnet(bitmap);
      const outputs = await this.session.run({ [this.session.inputNames[0]!]: tensor });
      const probMap = Object.values(outputs)[0]!;
      const regions = decodeProbabilityMap(probMap, resizedW, resizedH, scaleW, scaleH);
      return { backend: this.backend, regions };
    } catch (error) {
      reportFailure('inference', error);
      this.failure = failureDetail(error);
      return { backend: this.backend, regions: [] };
    }
  }

  // ---------- initialization ----------

  private async initialize(): Promise<void> {
    if (this.session || this.backend === 'missing') return;
    if (this.initialization) return this.initialization;
    this.initialization = this.initializeOnce();
    await this.initialization;
  }

  private async initializeOnce(): Promise<void> {
    if (typeof __DBNET_MODEL_INCLUDED__ === 'undefined' || !__DBNET_MODEL_INCLUDED__) {
      this.backend = 'missing';
      return;
    }

    ort.env.wasm.wasmPaths = {
      mjs: runtimeUrl('wasm/ort-wasm-simd-threaded.jsep.mjs'),
      wasm: runtimeUrl('wasm/ort-wasm-simd-threaded.jsep.wasm'),
    };
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const model = runtimeUrl('models/dbnet-text-det.onnx');

    // Probe WebGPU
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
        });
        this.backend = 'webgpu';
        return;
      } catch (error) {
        reportFailure('WebGPU initialization', error);
        this.failure = failureDetail(error);
        this.session = null;
      }
    }

    // WASM fallback
    try {
      this.session = await ort.InferenceSession.create(model, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      this.backend = 'wasm';
      this.failure = '';
    } catch (error) {
      reportFailure('WASM initialization', error);
      this.failure = failureDetail(error);
      this.session = null;
      this.backend = 'error';
    }
  }
}

// ---------- preprocessing ----------

function preprocessDbnet(bitmap: ImageBitmap): {
  tensor: ort.Tensor;
  scaleW: number;
  scaleH: number;
  resizedW: number;
  resizedH: number;
} {
  // Resize keeping aspect ratio, max dimension = 736, round to multiple of 32
  const ratio = Math.min(DBNET_MAX_DIM / bitmap.width, DBNET_MAX_DIM / bitmap.height);
  const resizedW = roundTo32(Math.round(bitmap.width * ratio));
  const resizedH = roundTo32(Math.round(bitmap.height * ratio));
  const scaleW = bitmap.width / resizedW;
  const scaleH = bitmap.height / resizedH;

  const canvas = new OffscreenCanvas(resizedW, resizedH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is unavailable');
  ctx.drawImage(bitmap, 0, 0, resizedW, resizedH);

  const pixels = ctx.getImageData(0, 0, resizedW, resizedH).data;
  const float32 = new Float32Array(3 * resizedW * resizedH);
  const plane = resizedW * resizedH;

  for (let i = 0; i < plane; i++) {
    const px = i * 4;
    // ImageNet normalization: (pixel/255 - mean) / std
    float32[i] = ((pixels[px]! / 255) - DBNET_MEAN[0]) / DBNET_STD[0];
    float32[plane + i] = ((pixels[px + 1]! / 255) - DBNET_MEAN[1]) / DBNET_STD[1];
    float32[plane * 2 + i] = ((pixels[px + 2]! / 255) - DBNET_MEAN[2]) / DBNET_STD[2];
  }

  return {
    tensor: new ort.Tensor('float32', float32, [1, 3, resizedH, resizedW]),
    scaleW,
    scaleH,
    resizedW,
    resizedH,
  };
}

function roundTo32(value: number): number {
  return Math.max(32, Math.round(value / 32) * 32);
}

// ---------- postprocessing ----------

/**
 * Convert the probability map into bounding boxes of text regions.
 * This performs detection only — no text recognition/OCR.
 */
function decodeProbabilityMap(
  probTensor: ort.Tensor,
  resizedW: number,
  resizedH: number,
  scaleW: number,
  scaleH: number,
): TextRegionDetection[] {
  const data = probTensor.data as Float32Array;
  const mapH = probTensor.dims[2]!;
  const mapW = probTensor.dims[3]!;

  // Binary threshold to create text mask
  const binary = new Uint8Array(mapH * mapW);
  for (let i = 0; i < data.length; i++) {
    binary[i] = Number(data[i]) > DBNET_BINARY_THRESHOLD ? 1 : 0;
  }

  // Connected component analysis via flood-fill to find text regions
  const visited = new Uint8Array(mapH * mapW);
  const regions: TextRegionDetection[] = [];

  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const idx = y * mapW + x;
      if (binary[idx] === 0 || visited[idx] === 1) continue;

      // Flood fill to find connected component
      let minX = x, maxX = x, minY = y, maxY = y;
      let sumScore = 0;
      let pixelCount = 0;
      const stack: Array<[number, number]> = [[x, y]];

      while (stack.length > 0) {
        const [cx, cy] = stack.pop()!;
        const ci = cy * mapW + cx;
        if (cx < 0 || cx >= mapW || cy < 0 || cy >= mapH) continue;
        if (visited[ci] === 1 || binary[ci] === 0) continue;

        visited[ci] = 1;
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);
        sumScore += Number(data[ci]);
        pixelCount++;

        // 4-connected neighbors
        stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
      }

      const boxW = maxX - minX + 1;
      const boxH = maxY - minY + 1;
      const area = boxW * boxH;
      if (area < DBNET_MIN_BOX_AREA) continue;

      const avgScore = sumScore / pixelCount;
      if (avgScore < DBNET_BOX_THRESHOLD) continue;

      // Scale back to original image coordinates
      regions.push({
        bounds: {
          x: minX * scaleW,
          y: minY * scaleH,
          width: boxW * scaleW,
          height: boxH * scaleH,
        },
        confidence: avgScore,
      });
    }
  }

  return regions;
}

// ---------- diagnostics ----------

function reportFailure(stage: string, error: unknown): void {
  console.warn(`[privacy-agent] DBNet text detector ${stage} failed (${failureDetail(error)})`);
}

function failureDetail(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message.slice(0, 240)}` : 'unknown error';
}

/** Exported for testing. */
export const dbnetInternals = { preprocessDbnet, decodeProbabilityMap, roundTo32 };
