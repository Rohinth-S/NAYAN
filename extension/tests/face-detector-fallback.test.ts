import { afterEach, describe, expect, it, vi } from 'vitest';

const { createSession, webGpuSession, wasmSession } = vi.hoisted(() => {
  vi.stubGlobal('__FACE_MODEL_INCLUDED__', true);
  vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } });
  vi.stubGlobal('navigator', { gpu: { requestAdapter: vi.fn().mockResolvedValue({}) } });
  class TestCanvas {
    width = 320;
    height = 240;
    getContext() {
      return {
        drawImage: vi.fn(),
        getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4) }),
      };
    }
  }
  vi.stubGlobal('OffscreenCanvas', TestCanvas);
  const webGpu = {
    inputNames: ['input'],
    run: vi.fn().mockRejectedValue(new Error('WebGPU operator is unsupported')),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const wasm = {
    inputNames: ['input'],
    run: vi.fn().mockResolvedValue({
      boxes: { dims: [1, 1, 4], data: Float32Array.from([0.1, 0.1, 0.4, 0.4]) },
      scores: { dims: [1, 1, 2], data: Float32Array.from([0.1, 0.95]) },
    }),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const create = vi.fn(async (_model: string, options: { executionProviders?: readonly string[] }) =>
    options.executionProviders?.[0] === 'webgpu' ? webGpu : wasm);
  return { createSession: create, webGpuSession: webGpu, wasmSession: wasm };
});

vi.mock('onnxruntime-web/webgpu', () => ({
  env: { wasm: {} },
  InferenceSession: { create: createSession },
  Tensor: class {
    constructor(public readonly type: string, public readonly data: Float32Array, public readonly dims: number[]) {}
  },
}));

import { LocalFaceDetector } from '../src/face-detector';

afterEach(() => {
  vi.clearAllMocks();
});

describe('LocalFaceDetector backend recovery', () => {
  it('retries a WebGPU inference failure through WASM', async () => {
    const detector = new LocalFaceDetector();
    const bitmap = { width: 320, height: 240 } as unknown as ImageBitmap;

    const result = await detector.detect(bitmap);

    expect(result.backend).toBe('wasm');
    expect(result.boxes).toHaveLength(1);
    expect(createSession).toHaveBeenNthCalledWith(1, 'chrome-extension://test/models/version-RFB-320.onnx', expect.objectContaining({ executionProviders: ['webgpu'] }));
    expect(createSession).toHaveBeenNthCalledWith(2, 'chrome-extension://test/models/version-RFB-320.onnx', expect.objectContaining({ executionProviders: ['wasm'] }));
    expect(webGpuSession.run).toHaveBeenCalledTimes(1);
    expect(webGpuSession.release).toHaveBeenCalledTimes(1);
    expect(wasmSession.run).toHaveBeenCalledTimes(1);
    expect(detector.state).toBe('wasm');
  });
});
