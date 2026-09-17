import { describe, expect, it, vi } from 'vitest';
import { runAgentGraph, type WorkflowHooks } from '../src/agent-graph';
const hooks = (): WorkflowHooks => ({ observe: vi.fn(async () => {}), reason: vi.fn(async (): Promise<'continue' | 'drift'> => 'continue'),
  verify: vi.fn(async () => {}), dispatch: vi.fn(async () => true), settle: vi.fn(async () => {}) });
const options = () => ({ maxSteps: 5, signal: new AbortController().signal });
describe('private bounded LangGraph workflow', () => {
  it('runs all stages and stores counters only', async () => {
    const h = hooks(); const result = await runAgentGraph(h, options());
    expect(h.observe).toHaveBeenCalledBefore(h.reason as ReturnType<typeof vi.fn>);
    expect(h.verify).toHaveBeenCalledBefore(h.dispatch as ReturnType<typeof vi.fn>);
    expect(Object.keys(result).sort()).toEqual(['actions', 'attempts', 'driftCount', 'route']);
    expect(result.route).toBe('done');
  });
  it('bounds stale recaptures without dispatch', async () => {
    const h = hooks(); h.reason = vi.fn(async (): Promise<'continue' | 'drift'> => 'drift');
    await expect(runAgentGraph(h, options())).rejects.toThrow('Page keeps changing');
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it('never replays an uncertain side effect', async () => {
    const h = hooks(); h.dispatch = vi.fn(async () => { throw new Error('uncertain action result'); });
    await expect(runAgentGraph(h, options())).rejects.toThrow('uncertain');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });
  it('stops at the step limit', async () => {
    const h = hooks(); h.dispatch = vi.fn(async () => false);
    await expect(runAgentGraph(h, { ...options(), maxSteps: 2 })).rejects.toThrow('Maximum step');
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });
  it('blocks dispatch after cancellation during planning', async () => {
    const h = hooks(); const controller = new AbortController();
    h.reason = async () => { controller.abort(); return 'continue'; };
    await expect(runAgentGraph(h, { ...options(), signal: controller.signal })).rejects.toThrow();
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it('aborts an in-flight planning request at the run deadline', async () => {
    const h = hooks();
    let requestSignal: AbortSignal | undefined;
    h.reason = async signal => {
      requestSignal = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    };
    await expect(runAgentGraph(h, { ...options(), deadlineMs: 40 })).rejects.toThrow();
    expect(requestSignal?.aborted).toBe(true);
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it('returns promptly when stopped while a callback is unresponsive', async () => {
    const h = hooks();
    const controller = new AbortController();
    let started!: () => void;
    const observing = new Promise<void>(resolve => { started = resolve; });
    h.observe = async () => { started(); return new Promise(() => {}); };
    const run = runAgentGraph(h, { ...options(), signal: controller.signal });
    const rejected = expect(run).rejects.toThrow();
    await observing;
    controller.abort();
    await rejected;
    expect(h.reason).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, 0, -1])('rejects invalid deadline %s', async deadlineMs => {
    await expect(runAgentGraph(hooks(), { ...options(), deadlineMs })).rejects.toThrow('deadline is invalid');
  });
});
