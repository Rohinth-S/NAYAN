import * as ort from 'onnxruntime-web/webgpu';
import type { Bounds, SanitizedObservation } from './types';
import { runtimeUrl } from './webext';

declare const __FACE_MODEL_INCLUDED__: boolean;

export type FaceDetectionResult = Readonly<{
  backend: SanitizedObservation['privacy']['detectorBackend'];
  boxes: readonly Bounds[];
}>;

type Candidate = Bounds & { score: number };

export class LocalFaceDetector {
  private session: ort.InferenceSession | null = null;
  private backend: 'webgpu' | 'wasm' | 'missing' | 'error' = __FACE_MODEL_INCLUDED__ ? 'error' : 'missing';
  private initialization: Promise<void> | null = null;
  private wasmFallback: Promise<boolean> | null = null;
  private failure = __FACE_MODEL_INCLUDED__ ? 'not initialized' : 'model missing';

  get state(): SanitizedObservation['privacy']['detectorBackend'] {
    return this.backend;
  }

  get diagnostic(): string {
    return this.failure;
  }

  async detect(bitmap: ImageBitmap): Promise<FaceDetectionResult> {
    await this.initialize();
    if (!this.session || !['webgpu', 'wasm'].includes(this.backend)) return { backend: this.backend, boxes: [] };

    // Keep preprocessing outside the inference recovery path. If the browser
    // cannot provide a canvas/ImageBitmap, retrying a different execution
    // provider cannot fix that local capability failure.
    const input = preprocess(bitmap);
    const backendAtStart = this.backend;
    const sessionAtStart = this.session;
    try {
      return await this.runInference(input, bitmap);
    } catch (error) {
      reportDetectorFailure('inference', error);

      // A WebGPU session can initialize successfully and still fail on the
      // first graph execution (driver/model operator support varies widely).
      // Retry the same frame through the deterministic WASM backend before
      // failing closed. This keeps WebGPU as the fast path without making it
      // a single point of failure on laptops and managed browsers.
      if (backendAtStart === 'webgpu') {
        const webGpuFailure = detectorFailureDetail(error);
        await this.releaseSession(sessionAtStart);
        if (await this.initializeWasm(webGpuFailure)) {
          try {
            return await this.runInference(preprocess(bitmap), bitmap);
          } catch (wasmError) {
            reportDetectorFailure('WASM inference', wasmError);
            this.failure = `WebGPU inference: ${webGpuFailure}; WASM inference: ${detectorFailureDetail(wasmError)}`.slice(0, 480);
          }
        }
      } else {
        this.failure = detectorFailureDetail(error);
      }
      this.backend = 'error';
      this.session = null;
      return { backend: 'error', boxes: [] };
    }
  }

  private async runInference(input: ort.Tensor, bitmap: ImageBitmap): Promise<FaceDetectionResult> {
    const session = this.session;
    if (!session || !['webgpu', 'wasm'].includes(this.backend)) {
      return { backend: this.backend, boxes: [] };
    }
    const outputs = await session.run({ [session.inputNames[0]!]: input });
    const tensors = Object.values(outputs);
    const boxes = tensors.find((tensor) => tensor.dims.length === 3 && tensor.dims.at(-1) === 4);
    const scores = tensors.find((tensor) => tensor.dims.length === 3 && tensor.dims.at(-1) === 2);
    if (!boxes || !scores) throw new Error('Unexpected UltraFace output tensors');
    return { backend: this.backend, boxes: decodeUltraFace(boxes, scores, bitmap.width, bitmap.height) };
  }

  private async initialize(): Promise<void> {
    if (this.session || this.backend === 'missing') return;
    if (this.initialization) return this.initialization;
    this.initialization = this.initializeOnce();
    await this.initialization;
  }

  private async initializeOnce(): Promise<void> {
    if (!__FACE_MODEL_INCLUDED__) {
      this.backend = 'missing';
      return;
    }
    // Both resources are packaged with the extension. Chrome initializes this
    // runtime in an offscreen document, where the loader's import() is allowed.
    ort.env.wasm.wasmPaths = {
      mjs: runtimeUrl('wasm/ort-wasm-simd-threaded.jsep.mjs'),
      wasm: runtimeUrl('wasm/ort-wasm-simd-threaded.jsep.wasm'),
    };
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const model = runtimeUrl('models/version-RFB-320.onnx');

    // Some headless, virtualized, and policy-managed browsers expose
    // navigator.gpu even when no adapter is available. Trying that unusable
    // backend can leave ONNX Runtime unable to initialize its WASM fallback,
    // so confirm an adapter exists before selecting WebGPU.
    const gpu = (navigator as Navigator & {
      gpu?: { requestAdapter(options?: { powerPreference?: 'low-power' | 'high-performance' }): Promise<unknown | null> };
    }).gpu;
    let hasWebGpuAdapter = false;
    if (gpu) {
      try {
        hasWebGpuAdapter = (await gpu.requestAdapter({ powerPreference: 'low-power' })) !== null;
      } catch {
        hasWebGpuAdapter = false;
      }
    }

    let webGpuFailure = '';
    if (hasWebGpuAdapter) {
      try {
        this.session = await ort.InferenceSession.create(model, {
          executionProviders: ['webgpu'],
          graphOptimizationLevel: 'all',
        });
        this.backend = 'webgpu';
        return;
      } catch (error) {
        reportDetectorFailure('WebGPU initialization', error);
        webGpuFailure = detectorFailureDetail(error);
        this.failure = webGpuFailure;
        this.session = null;
      }
    }
    await this.initializeWasm(webGpuFailure);
  }

  private async initializeWasm(previousFailure = ''): Promise<boolean> {
    if (this.session && this.backend === 'wasm') return true;
    if (this.wasmFallback) return this.wasmFallback;
    const creating = (async () => {
      try {
        const model = runtimeUrl('models/version-RFB-320.onnx');
        this.session = await ort.InferenceSession.create(model, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        });
        this.backend = 'wasm';
        this.failure = '';
        return true;
      } catch (error) {
        reportDetectorFailure('WASM initialization', error);
        const wasmFailure = detectorFailureDetail(error);
        this.failure = previousFailure
          ? `WebGPU initialization: ${previousFailure}; WASM initialization: ${wasmFailure}`.slice(0, 480)
          : wasmFailure;
        this.session = null;
        this.backend = 'error';
        return false;
      }
    })();
    this.wasmFallback = creating;
    try {
      return await creating;
    } finally {
      if (this.wasmFallback === creating) this.wasmFallback = null;
    }
  }

  private async releaseSession(expected: ort.InferenceSession | null): Promise<void> {
    // Another concurrent capture may already have replaced the failed GPU
    // session with WASM. Never release that newer session accidentally.
    if (!expected || this.session !== expected) return;
    this.session = null;
    try {
      await expected.release();
    } catch (error) {
      reportDetectorFailure('WebGPU release', error);
    }
  }
}

function reportDetectorFailure(stage: string, error: unknown): void {
  const detail = detectorFailureDetail(error);
  // Model/runtime diagnostics contain no page content and help distinguish a
  // missing browser capability from a corrupt packaged model.
  console.warn(`[privacy-agent] UltraFace ${stage} failed (${detail})`);
}

function detectorFailureDetail(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message.slice(0, 240)}` : 'unknown error';
}

function preprocess(bitmap: ImageBitmap): ort.Tensor {
  const width = 320;
  const height = 240;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas is unavailable');
  context.drawImage(bitmap, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const tensor = new Float32Array(3 * width * height);
  const plane = width * height;
  for (let index = 0; index < plane; index += 1) {
    const pixel = index * 4;
    tensor[index] = (pixels[pixel]! - 127) / 128;
    tensor[plane + index] = (pixels[pixel + 1]! - 127) / 128;
    tensor[plane * 2 + index] = (pixels[pixel + 2]! - 127) / 128;
  }
  return new ort.Tensor('float32', tensor, [1, 3, height, width]);
}

function decodeUltraFace(
  boxTensor: ort.Tensor,
  scoreTensor: ort.Tensor,
  imageWidth: number,
  imageHeight: number,
  scoreThreshold = 0.72,
): Bounds[] {
  const boxData = boxTensor.data as Float32Array;
  const scoreData = scoreTensor.data as Float32Array;
  const count = Math.min(Math.floor(boxData.length / 4), Math.floor(scoreData.length / 2));
  const candidates: Candidate[] = [];
  for (let index = 0; index < count; index += 1) {
    const score = Number(scoreData[index * 2 + 1]);
    if (!Number.isFinite(score) || score < scoreThreshold) continue;
    const x1 = clamp(Number(boxData[index * 4]), 0, 1) * imageWidth;
    const y1 = clamp(Number(boxData[index * 4 + 1]), 0, 1) * imageHeight;
    const x2 = clamp(Number(boxData[index * 4 + 2]), 0, 1) * imageWidth;
    const y2 = clamp(Number(boxData[index * 4 + 3]), 0, 1) * imageHeight;
    if (x2 <= x1 || y2 <= y1) continue;
    candidates.push({ x: x1, y: y1, width: x2 - x1, height: y2 - y1, score });
  }
  return nms(candidates, 0.35).map(({ x, y, width, height }) => ({ x, y, width, height }));
}

function nms(candidates: readonly Candidate[], threshold: number): Candidate[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const accepted: Candidate[] = [];
  while (sorted.length) {
    const best = sorted.shift()!;
    accepted.push(best);
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      if (intersectionOverUnion(best, sorted[index]!) > threshold) sorted.splice(index, 1);
    }
  }
  return accepted;
}

function intersectionOverUnion(a: Bounds, b: Bounds): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const ultraFaceInternals = { decodeUltraFace, nms, intersectionOverUnion };
