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
  observe(attempt: number): Promise<void>;
  reason(): Promise<'continue' | 'drift'>;
  verify(): Promise<void>;
  dispatch(): Promise<boolean>;
  settle(): Promise<void>;
};
export type WorkflowOptions = { maxSteps: number; signal: AbortSignal; deadlineMs?: number; maxDrift?: number };

export async function runAgentGraph(hooks: WorkflowHooks, options: WorkflowOptions): Promise<WorkflowState> {
  if (!Number.isInteger(options.maxSteps) || options.maxSteps < 1 || options.maxSteps > 30) throw new Error('Step budget is invalid');
  const deadline = performance.now() + (options.deadlineMs ?? 300_000);
  function guard() {
    options.signal.throwIfAborted();
    if (performance.now() >= deadline) throw new Error('Run deadline exceeded; new capture required');
  }
  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    guard();
    const remaining = Math.max(1, deadline - performance.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Run deadline exceeded; new capture required')), remaining); }),
      ]).then(value => { guard(); return value; });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  const graph = new StateGraph(State)
    .addNode('observe', async (state) => {
      if (state.attempts >= options.maxSteps) throw new Error('Maximum step count reached');
      await guarded(() => hooks.observe(state.attempts + 1));
      return { attempts: state.attempts + 1, route: 'continue' as const };
    })
    .addNode('reason', async (state) => {
      const route = await guarded(hooks.reason);
      const driftCount = route === 'drift' ? state.driftCount + 1 : 0;
      if (driftCount > (options.maxDrift ?? 3)) throw new Error('Page keeps changing; pause the page and retry');
      return { route, driftCount };
    })
    .addNode('verify', async () => { await guarded(hooks.verify); return {}; })
    .addNode('dispatch', async (state) => {
      // Never retry or resume a side effect after an ambiguous failure.
      const done = await guarded(hooks.dispatch);
      return { actions: state.actions + (done ? 0 : 1), route: done ? 'done' as const : 'continue' as const };
    })
    .addNode('settle', async () => { await guarded(hooks.settle); return {}; })
    .addEdge(START, 'observe').addEdge('observe', 'reason')
    .addConditionalEdges('reason', s => s.route === 'drift' ? 'observe' : 'verify', ['observe', 'verify'])
    .addEdge('verify', 'dispatch')
    .addConditionalEdges('dispatch', s => s.route === 'done' ? END : 'settle', [END, 'settle'])
    .addEdge('settle', 'observe').compile(); // No checkpointer or remote store.
  return graph.invoke({}, { signal: options.signal, callbacks: [], recursionLimit: options.maxSteps * 5 + (options.maxDrift ?? 3) * 2 + 4 });
}
