import { describe, expect, it } from 'vitest';
import { yoloInternals } from '../src/yolo-detector';

describe('YOLO Detector Internals', () => {
  it('correctly maps classes', () => {
    expect(yoloInternals.CLASS_MAP).toContain('face');
    expect(yoloInternals.CLASS_MAP).toContain('aadhaar_card');
  });

  it('computes IOU correctly', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 5, y: 5, width: 10, height: 10 };
    const iou = yoloInternals.iou(a, b);
    expect(iou).toBeGreaterThan(0.1);
    expect(iou).toBeLessThan(0.3);
  });

  it('performs NMS correctly', () => {
    const candidates = [
      { class: 'face' as const, bounds: { x: 0, y: 0, width: 10, height: 10 }, confidence: 0.9, score: 0.9 },
      { class: 'face' as const, bounds: { x: 1, y: 1, width: 9, height: 9 }, confidence: 0.8, score: 0.8 }, // Should be suppressed
      { class: 'passport' as const, bounds: { x: 100, y: 100, width: 50, height: 50 }, confidence: 0.85, score: 0.85 },
    ];
    
    const results = yoloInternals.nms(candidates, 0.5);
    expect(results.length).toBe(2);
    expect(results[0]?.class).toBe('face');
    expect(results[1]?.class).toBe('passport');
  });
});
