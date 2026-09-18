/** Retry only a same-document capture race, never an uncertain side effect. */
export class CaptureChangedError extends Error {
  constructor() { super('Document changed during capture or local sanitization'); }
}

export async function retryStableCapture<T>(capture: () => Promise<T>, onRetry: (attempt: number) => void, signal?: AbortSignal): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal?.throwIfAborted();
    try {
      const result = await capture();
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof CaptureChangedError)) throw error;
      if (attempt === 3) throw new Error('Page keeps changing during capture. Stop scrolling or wait for the page to finish loading, then retry.');
      onRetry(attempt + 1);
    }
  }
  throw new Error('Stable capture unavailable');
}

export function capturePause(signal?: AbortSignal, ms = 350): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
