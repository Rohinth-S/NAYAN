import { describe, expect, it } from 'vitest';
import type * as ort from 'onnxruntime-web';
import { ultraFaceInternals } from '../src/face-detector';

function tensor(dims: readonly number[], data: readonly number[]): ort.Tensor {
  return { dims: [...dims], data: Float32Array.from(data) } as unknown as ort.Tensor;
}

describe('UltraFace post-processing', () => {
  it('scales normalized boxes and removes overlapping detections', () => {
    const boxes = tensor([1, 3, 4], [
      0.1, 0.2, 0.4, 0.6,
      0.11, 0.21, 0.39, 0.59,
      0.7, 0.1, 0.9, 0.4,
    ]);
    const scores = tensor([1, 3, 2], [0.01, 0.99, 0.02, 0.95, 0.03, 0.93]);
    const result = ultraFaceInternals.decodeUltraFace(boxes, scores, 1_000, 500);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ x: 100.00000149011612, y: 100.00000149011612, width: 300.00000447034836, height: 200.00001043081284 });
    expect(result[1]!.x).toBeCloseTo(700);
  });

  it('drops low-confidence and invalid boxes', () => {
    const boxes = tensor([1, 2, 4], [0.1, 0.1, 0.2, 0.2, 0.8, 0.8, 0.4, 0.4]);
    const scores = tensor([1, 2, 2], [0.9, 0.2, 0.1, 0.99]);
    expect(ultraFaceInternals.decodeUltraFace(boxes, scores, 100, 100)).toEqual([]);
  });
});
