import { assertNoCanaries, assertNoUnsafeKeys } from './privacy';
import { assertFinalDlpClear } from './dlp';
import type { ReasonResponse, SanitizedObservation } from './types';
import { parseReasonResponse, validateObservation } from './validation';

const MAX_RESPONSE_BYTES = 256_000;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const REASONING_TIMEOUT_MS = 100_000;
export const REASONING_POLL_MS = 1_000;

function rejection(status: number): Error {
  // Fixed messages only: never surface an untrusted server body or a key.
  if (status === 403) return new Error('Server rejected the extension origin (403). Start the local server with Start-Prototype.ps1 and enter the key from .runtime/api-key.txt; remote servers need an allowed extension origin.');
  if (status === 401) return new Error('Server authentication failed (401). Enter the matching key from .runtime/api-key.txt in the API key field.');
  return new Error(`Reasoning server rejected the request (${status})`);
}

export type ReasoningRequestOptions = Readonly<{
  /** Cancel a user-stopped run without waiting for the reasoning deadline. */
  signal?: AbortSignal;
  /** Content-free lifecycle state for the local popup. */
  onProgress?: (stage: 'sending' | 'accepted') => void;
}>;

type PendingJob = Readonly<{
  schemaVersion: '1.0';
  snapshotId: string;
  jobId: string;
  status: 'pending';
}>;

export function validateReasoningEndpoint(raw: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error('Reasoning endpoint is invalid');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Endpoint credentials, query, and fragments are forbidden');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
    throw new Error('Use HTTPS, or HTTP only for a loopback server');
  }
  if (!endpoint.pathname.endsWith('/v1/reason')) throw new Error('Endpoint path must end in /v1/reason');
  return endpoint;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function parsePendingJob(value: unknown, snapshotId: string, expectedJobId?: string): PendingJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Reasoning job response is invalid');
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, ['jobId', 'schemaVersion', 'snapshotId', 'status']) ||
    record.schemaVersion !== '1.0' || record.snapshotId !== snapshotId || record.status !== 'pending' ||
    typeof record.jobId !== 'string' || !JOB_ID_PATTERN.test(record.jobId) ||
    (expectedJobId !== undefined && record.jobId !== expectedJobId)
  ) throw new Error('Reasoning job response is invalid');
  return record as PendingJob;
}

async function readBoundedJson(response: Response, canaries: readonly string[]): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new Error('Reasoning server returned an invalid content type');
  const length = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('Reasoning response is too large');
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error('Reasoning response is too large');
  // A compromised or misconfigured server must not reintroduce an operator canary into the live page.
  assertNoCanaries(text, canaries);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Reasoning server returned invalid JSON');
  }
}

function pollUrl(endpoint: URL, jobId: string): string {
  const result = new URL(endpoint.href);
  result.pathname = `${endpoint.pathname}/${jobId}`;
  return result.href;
}

function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, REASONING_POLL_MS);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * The only source-level fetch to the reasoning server. The first request owns
 * the validated sanitized body. Later requests carry only an opaque job ID.
 */
async function request(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    // The caller distinguishes its own cancellation from the total deadline.
    if (signal.aborted) throw error;
    throw new Error('Reasoning server unavailable', { cause: error });
  }
}

export async function sendSanitizedObservation(
  endpointRaw: string,
  apiKey: string,
  observation: SanitizedObservation,
  canaries: readonly string[],
  options: ReasoningRequestOptions = {},
): Promise<ReasonResponse> {
  if (options.signal?.aborted) throw new Error('Reasoning request cancelled');
  const endpoint = validateReasoningEndpoint(endpointRaw);
  validateObservation(observation);
  assertNoUnsafeKeys(observation);
  assertFinalDlpClear(observation, canaries);
  const body = JSON.stringify(observation);
  assertNoCanaries(body, canaries);

  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(), REASONING_TIMEOUT_MS);
  const commonHeaders = {
    accept: 'application/json',
    ...(apiKey ? { 'x-privacy-agent-key': apiKey } : {}),
  };
  const commonInit = {
    cache: 'no-store' as const,
    credentials: 'omit' as const,
    redirect: 'error' as const,
    referrerPolicy: 'no-referrer' as const,
  };
  try {
    options.onProgress?.('sending');
    const submitted = await request(endpoint.href, {
      ...commonInit,
      method: 'POST',
      headers: {
        ...commonHeaders,
        'content-type': 'application/json',
        prefer: 'respond-async',
      },
      body,
    }, controller.signal);

    if (submitted.status === 200) {
      options.onProgress?.('accepted');
      return parseReasonResponse(await readBoundedJson(submitted, canaries), observation.snapshotId);
    }
    if (submitted.status !== 202) throw rejection(submitted.status);
    options.onProgress?.('accepted');
    const job = parsePendingJob(await readBoundedJson(submitted, canaries), observation.snapshotId);
    const statusUrl = pollUrl(endpoint, job.jobId);

    while (true) {
      await pollDelay(controller.signal);
      const polled = await request(statusUrl, {
        ...commonInit,
        method: 'GET',
        headers: { ...commonHeaders, prefer: 'wait=10' },
      }, controller.signal);
      if (polled.status === 200) {
        return parseReasonResponse(await readBoundedJson(polled, canaries), observation.snapshotId);
      }
      if (polled.status !== 202) throw rejection(polled.status);
      parsePendingJob(await readBoundedJson(polled, canaries), observation.snapshotId, job.jobId);
    }
  } catch (error) {
    if (options.signal?.aborted) throw new Error('Reasoning request cancelled', { cause: error });
    if (controller.signal.aborted) {
      throw new Error('Reasoning server unavailable (timeout)', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
  }
}
