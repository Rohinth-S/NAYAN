import { afterEach, describe, expect, it, vi } from 'vitest';
import { REASONING_POLL_MS, REASONING_TIMEOUT_MS, sendSanitizedObservation, validateReasoningEndpoint } from '../src/egress';
import { SCHEMA_VERSION, type SanitizedObservation } from '../src/types';

const snapshotId = 'a1abcc51-58de-4bea-abfe-08400f9f0ef7';
const jobId = 'f9a15cf1-6946-4128-a096-5ac4ba20f052';
const cleanObservation: SanitizedObservation = {
  schemaVersion: SCHEMA_VERSION,
  snapshotId,
  documentId: '79dc263f-bdcc-4869-bb83-6efe5cba7f52',
  page: { origin: 'https://site-0123456789abcdef0123.invalid', title: '[REDACTED:KNOWN]' },
  task: 'Submit the form',
  elements: [],
  image: { mime: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', width: 1, height: 1 },
  redactions: [{ kind: 'visual-fallback', source: 'fallback', bounds: { x: 0, y: 0, width: 1, height: 1 } }],
  privacy: { grade: 3, detectorBackend: 'missing', visualFallback: 'full-mask', rawImageRetained: false },
};

function jsonResponse(value: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function pendingJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: SCHEMA_VERSION, snapshotId, jobId, status: 'pending', ...overrides };
}

function completedAction(): Record<string, unknown> {
  return { schemaVersion: SCHEMA_VERSION, snapshotId, action: { type: 'done', message: 'Complete' } };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('single outbound gateway', () => {
  it('allows HTTPS and loopback HTTP only', () => {
    expect(validateReasoningEndpoint('http://127.0.0.1:8765/v1/reason').href).toContain('/v1/reason');
    expect(validateReasoningEndpoint('https://agent.example/v1/reason').href).toContain('/v1/reason');
    expect(() => validateReasoningEndpoint('http://agent.example/v1/reason')).toThrow('HTTPS');
    expect(() => validateReasoningEndpoint('https://user:pass@agent.example/v1/reason')).toThrow('credentials');
    expect(() => validateReasoningEndpoint('https://agent.example/v1/reason?debug=1')).toThrow('query');
  });

  it('supports a synchronous server while sending only the validated observation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completedAction()));
    vi.stubGlobal('fetch', fetchMock);
    await sendSanitizedObservation('https://agent.example/v1/reason', 'local-key', cleanObservation, ['Meera Rao']);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://agent.example/v1/reason');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
    expect(init.headers.prefer).toBe('respond-async');
    expect(init.body).toBe(JSON.stringify(cleanObservation));
    expect(JSON.parse(String(init.body)).privacy.grade).toBe(3);
    expect(init.body).not.toContain('Meera Rao');
  });

  it('submits once and polls with only an opaque job ID until the result is ready', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(pendingJob(), 202))
      .mockResolvedValueOnce(jsonResponse(pendingJob(), 202))
      .mockResolvedValueOnce(jsonResponse(completedAction()));
    vi.stubGlobal('fetch', fetchMock);
    const resultPromise = sendSanitizedObservation(
      'https://agent.example/v1/reason', 'local-key', cleanObservation, ['Meera Rao'],
    );
    await flushPromises();
    await vi.advanceTimersByTimeAsync(REASONING_POLL_MS);
    await vi.advanceTimersByTimeAsync(REASONING_POLL_MS);
    await expect(resultPromise).resolves.toEqual(completedAction());

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://agent.example/v1/reason');
    expect(fetchMock.mock.calls[0]![1].body).toBe(JSON.stringify(cleanObservation));
    for (const call of fetchMock.mock.calls.slice(1)) {
      expect(call[0]).toBe(`https://agent.example/v1/reason/${jobId}`);
      expect(call[1].method).toBe('GET');
      expect(call[1].headers.prefer).toBe('wait=10');
      expect(call[1]).not.toHaveProperty('body');
      expect(JSON.stringify(call)).not.toContain(cleanObservation.image.dataBase64);
      expect(JSON.stringify(call)).not.toContain('Meera Rao');
    }
  });

  it('reports when an asynchronous reasoning request has been accepted', async () => {
    const progress: string[] = [];
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(pendingJob(), 202))
      .mockResolvedValueOnce(jsonResponse(completedAction()));
    vi.stubGlobal('fetch', fetchMock);
    const resultPromise = sendSanitizedObservation(
      'https://agent.example/v1/reason', '', cleanObservation, [], {
        onProgress: (stage) => progress.push(stage),
      },
    );
    await flushPromises();
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(progress).toEqual(['sending', 'accepted']);
    await vi.advanceTimersByTimeAsync(REASONING_POLL_MS);
    await expect(resultPromise).resolves.toEqual(completedAction());
  });

  it('cancels an outstanding reasoning request on caller abort', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = sendSanitizedObservation(
      'https://agent.example/v1/reason', '', cleanObservation, [], { signal: controller.signal },
    );
    await flushPromises();
    controller.abort();
    await expect(pending).rejects.toThrow('Reasoning request cancelled');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not emit a request when the caller is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendSanitizedObservation(
      'https://agent.example/v1/reason', '', cleanObservation, [], { signal: controller.signal },
    )).rejects.toThrow('Reasoning request cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks a leak before any request is emitted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const leaked = { ...cleanObservation, task: 'Account owner Meera Rao' };
    await expect(sendSanitizedObservation('https://agent.example/v1/reason', '', leaked, ['Meera Rao'])).rejects.toThrow('canary');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a response that tries to reintroduce a private canary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      schemaVersion: SCHEMA_VERSION,
      snapshotId,
      action: { type: 'input', elementId: 'e_1234567890abcdef', text: 'Meera Rao' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendSanitizedObservation(
      'https://agent.example/v1/reason', 'local-key', cleanObservation, ['Meera Rao'],
    )).rejects.toThrow('canary');
  });

  it.each([
    pendingJob({ snapshotId: '11111111-1111-4111-8111-111111111111' }),
    pendingJob({ jobId: 'predictable-job' }),
    pendingJob({ extra: true }),
  ])('rejects a malformed async job ticket', async (ticket) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(ticket, 202)));
    await expect(sendSanitizedObservation(
      'https://agent.example/v1/reason', '', cleanObservation, [],
    )).rejects.toThrow('job response is invalid');
  });

  it('rejects a poll response for a different job', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(pendingJob(), 202))
      .mockResolvedValueOnce(jsonResponse(pendingJob({ jobId: 'aaa15cf1-6946-4128-a096-5ac4ba20f052' }), 202));
    vi.stubGlobal('fetch', fetchMock);
    const resultPromise = sendSanitizedObservation('https://agent.example/v1/reason', '', cleanObservation, []);
    const rejection = expect(resultPromise).rejects.toThrow('job response is invalid');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(REASONING_POLL_MS);
    await rejection;
  });

  it('rejects oversized and incorrectly typed successful responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(completedAction(), 200, {
      'content-length': '256001',
    })));
    await expect(sendSanitizedObservation(
      'https://agent.example/v1/reason', '', cleanObservation, [],
    )).rejects.toThrow('too large');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
      status: 200, headers: { 'content-type': 'text/html' },
    })));
    await expect(sendSanitizedObservation(
      'https://agent.example/v1/reason', '', cleanObservation, [],
    )).rejects.toThrow('content type');
  });

  it('fails closed with an explicit error when reasoning exceeds its total deadline', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = sendSanitizedObservation('https://agent.example/v1/reason', '', cleanObservation, []);
    const rejection = expect(pending).rejects.toThrow('unavailable (timeout)');
    await vi.advanceTimersByTimeAsync(REASONING_TIMEOUT_MS);
    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
