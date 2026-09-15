import { describe, expect, it } from 'vitest';
import { CaptureRateGate, MIN_CAPTURE_INTERVAL_MS } from '../src/capture-rate-gate';

describe('captureVisibleTab rate gate', () => {
  it('allows the first capture immediately and spaces later captures', () => {
    const gate = new CaptureRateGate();
    expect(gate.reserve(1_000)).toBe(0);
    expect(gate.reserve(1_000)).toBe(MIN_CAPTURE_INTERVAL_MS);
    expect(gate.reserve(1_100)).toBe((2 * MIN_CAPTURE_INTERVAL_MS) - 100);
  });

  it('recovers without delay after an idle period', () => {
    const gate = new CaptureRateGate();
    gate.reserve(500);
    expect(gate.reserve(2_000)).toBe(0);
  });

  it.each([499, Number.NaN, Number.POSITIVE_INFINITY])('rejects an unsafe interval of %s', (interval) => {
    expect(() => new CaptureRateGate(interval)).toThrow('rate limit');
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid clock value of %s', (now) => {
    expect(() => new CaptureRateGate().reserve(now)).toThrow('clock');
  });
});
