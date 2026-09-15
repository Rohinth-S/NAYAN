/**
 * Chrome permits at most two captureVisibleTab calls per second. Reserving
 * slots synchronously also keeps concurrent preview/run requests inside that
 * limit. The extra margin avoids failures caused by timer jitter.
 */
export const MIN_CAPTURE_INTERVAL_MS = 550;

export class CaptureRateGate {
  private nextAllowedAt = 0;

  constructor(private readonly intervalMs = MIN_CAPTURE_INTERVAL_MS) {
    if (!Number.isFinite(intervalMs) || intervalMs < 500) {
      throw new Error('Capture interval must preserve the browser rate limit');
    }
  }

  reserve(nowMs: number): number {
    if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error('Capture clock is invalid');
    const reservedAt = Math.max(nowMs, this.nextAllowedAt);
    this.nextAllowedAt = reservedAt + this.intervalMs;
    return reservedAt - nowMs;
  }
}
