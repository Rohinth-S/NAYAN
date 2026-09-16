import { describe, expect, it } from 'vitest';
import { graphInternals, type AgentGraphState } from '../src/agent-graph';

describe('AgentStateGraph', () => {
  it('builds and executes the agent graph', async () => {
    const nodes = {
      observe_and_redact: async (state: AgentGraphState) => {
        return { phase: 'reasoning' as const };
      },
      vlm_plan: async (state: AgentGraphState) => {
        return { action: { type: 'done' as const, summary: 'done' } };
      },
      hitl_gate: async (state: AgentGraphState) => {
        return { hitlApproved: true };
      },
      dispatch_action: async (state: AgentGraphState) => {
        return { phase: 'executing' as const };
      },
      verify_settlement: async (state: AgentGraphState) => {
        return { phase: 'idle' as const };
      },
    };

    const graph = graphInternals.buildAgentGraph(nodes);
    const initialState = graphInternals.createInitialState({ maxSteps: 5 } as any);
    initialState.scrollDrift = { ...initialState.scrollDrift, drifted: false };

    let finalState: AgentGraphState | undefined;
    for await (const state of graph.stream(initialState)) {
      finalState = state;
    }

    expect(finalState).toBeDefined();
    expect(finalState?.phase).toBe('idle');
    expect(finalState?.action?.type).toBe('done');
  });

  it('handles scroll drift by re-capturing', async () => {
    let observeCalls = 0;
    const nodes = {
      observe_and_redact: async (state: AgentGraphState) => {
        observeCalls++;
        // Reset scroll drift on re-capture
        return { scrollDrift: { ...state.scrollDrift, drifted: false } };
      },
      vlm_plan: async (state: AgentGraphState) => {
        // First time: simulate scroll drift
        if (observeCalls === 1) {
          return { scrollDrift: { ...state.scrollDrift, drifted: true } };
        }
        return { action: { type: 'done' as const, summary: 'done' } };
      },
      hitl_gate: async () => ({}),
      dispatch_action: async () => ({}),
      verify_settlement: async () => ({}),
    };

    const graph = graphInternals.buildAgentGraph(nodes);
    const initialState = graphInternals.createInitialState({ maxSteps: 5 } as any);

    let finalState: AgentGraphState | undefined;
    for await (const state of graph.stream(initialState)) {
      finalState = state;
    }

    expect(observeCalls).toBe(2);
    expect(finalState?.action?.type).toBe('done');
  });
});
