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
});
