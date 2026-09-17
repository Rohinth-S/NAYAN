import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

/** Only counters enter graph state. Captures, keys, tasks and actions remain in
 * private callback closures, never in graph checkpoints or tracing. */
const State = Annotation.Root({
  attempts: Annotation<number>({ default: () => 0, reducer: (_, v) => v }),
  actions: Annotation<number>({ default: () => 0, reducer: (_, v) => v }),
  driftCount: Annotation<number>({ default: () => 0, reducer: (_, v) => v }),
  route: Annotation<'continue' | 'drift' | 'done'>({ default: () => 'continue', reducer: (_, v) => v }),
});
export type WorkflowState = typeof State.State;
export type WorkflowHooks = {
  observe(attempt: number, signal: AbortSignal): Promise<void>;
  reason(signal: AbortSignal): Promise<'continue' | 'drift'>;
  verify(signal: AbortSignal): Promise<void>;
  dispatch(signal: AbortSignal): Promise<boolean>;
  settle(signal: AbortSignal): Promise<void>;
};
export type WorkflowOptions = { maxSteps: number; signal: AbortSignal; deadlineMs?: number; maxDrift?: number };

export async function runAgentGraph(hooks: WorkflowHooks, options: WorkflowOptions): Promise<WorkflowState> {
  if (!Number.isInteger(options.maxSteps) || options.maxSteps < 1 || options.maxSteps > 30) throw new Error('Step budget is invalid');
  const duration = options.deadlineMs ?? 300_000;
  const maxDrift = options.maxDrift ?? 3;
  if (!Number.isFinite(duration) || duration < 1 || duration > 3_600_000) throw new Error('Run deadline is invalid');
  if (!Number.isInteger(maxDrift) || maxDrift < 0 || maxDrift > 10) throw new Error('Drift budget is invalid');
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort(new Error('Run cancelled'));
  options.signal.addEventListener('abort', cancel, { once: true });
  if (options.signal.aborted) cancel();
  const deadline = performance.now() + duration;
  const deadlineTimer = setTimeout(() => controller.abort(new Error('Run deadline exceeded; new capture required')), duration);
  function guard() {
    if (performance.now() >= deadline) controller.abort(new Error('Run deadline exceeded; new capture required'));
    signal.throwIfAborted();
  }
  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    guard();
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { guard(); return work(); }),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]).then(value => { guard(); return value; });
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }
  const graph = new StateGraph(State)
    .addNode('observe', async (state) => {
      if (state.attempts >= options.maxSteps) throw new Error('Maximum step count reached');
      await guarded(() => hooks.observe(state.attempts + 1, signal));
      return { attempts: state.attempts + 1, route: 'continue' as const };
    })
    .addNode('reason', async (state) => {
      const route = await guarded(() => hooks.reason(signal));
      const driftCount = route === 'drift' ? state.driftCount + 1 : 0;
      if (driftCount > maxDrift) throw new Error('Page keeps changing; pause the page and retry');
      return { route, driftCount };
    })
    .addNode('verify', async () => { await guarded(() => hooks.verify(signal)); return {}; })
    .addNode('dispatch', async (state) => {
      // Never retry or resume a side effect after an ambiguous failure.
      const done = await guarded(() => hooks.dispatch(signal));
      return { actions: state.actions + (done ? 0 : 1), route: done ? 'done' as const : 'continue' as const };
    })
    .addNode('settle', async () => { await guarded(() => hooks.settle(signal)); return {}; })
    .addEdge(START, 'observe').addEdge('observe', 'reason')
    .addConditionalEdges('reason', s => s.route === 'drift' ? 'observe' : 'verify', ['observe', 'verify'])
    .addEdge('verify', 'dispatch')
    .addConditionalEdges('dispatch', s => s.route === 'done' ? END : 'settle', [END, 'settle'])
    .addEdge('settle', 'observe').compile(); // No checkpointer or remote store.
  try {
    guard();
    return await graph.invoke({}, { signal, callbacks: [], recursionLimit: options.maxSteps * 5 + maxDrift * 2 + 4 });
  } finally {
    clearTimeout(deadlineTimer);
    options.signal.removeEventListener('abort', cancel);
    // Cooperatively stop any remaining work, including requests which lost a
    // deadline race. No stale callback may continue a previous run's actions.
    controller.abort(new Error('Run closed'));
  }
}
