import { describe, expect, it, vi } from 'vitest';
import { CaptureChangedError, capturePause, retryStableCapture } from '../src/capture-retry';

describe('bounded fresh capture recovery', () => {
  it('discards a stale capture and returns only a new one', async () => {
    const capture = vi.fn().mockRejectedValueOnce(new CaptureChangedError()).mockResolvedValue('fresh snapshot');
    const progress = vi.fn();
    expect(await retryStableCapture(capture, progress)).toBe('fresh snapshot');
    expect(capture).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenCalledWith(2);
  });
  it('blocks continuously changing pages after three attempts', async () => {
    const capture = vi.fn().mockRejectedValue(new CaptureChangedError());
    await expect(retryStableCapture(capture, vi.fn())).rejects.toThrow('Page keeps changing');
    expect(capture).toHaveBeenCalledTimes(3);
  });
  it.each(['Active tab changed', 'Document or origin changed', 'Server authentication failed', 'Detector failed'])('does not retry %s', async message => {
    const capture = vi.fn().mockRejectedValue(new Error(message));
    await expect(retryStableCapture(capture, vi.fn())).rejects.toThrow(message);
    expect(capture).toHaveBeenCalledTimes(1);
  });
  it('stops before retry if cancelled', async () => {
    const controller = new AbortController();
    const capture = vi.fn(async () => { controller.abort(new Error('Stopped')); throw new CaptureChangedError(); });
    await expect(retryStableCapture(capture, vi.fn(), controller.signal)).rejects.toThrow('Stopped');
    expect(capture).toHaveBeenCalledTimes(1);
  });
  it('cancels a settling wait promptly', async () => {
    const controller = new AbortController();
    const waiting = capturePause(controller.signal, 10000);
    controller.abort(new Error('Stopped'));
    await expect(waiting).rejects.toThrow('Stopped');
  });
});
