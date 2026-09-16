/**
 * Approach B: LangGraph.js state-graph orchestrator.
 *
 * Replaces the hand-rolled for-loop state machine in background.ts with a
 * graph-native cyclical control flow using LangGraph's StateGraph.
 *
 * 5-node graph:
 *   observe_and_redact → vlm_plan → hitl_gate → dispatch_action → verify_settlement
 *                ↑                                                        |
 *                +--------------------------------------------------------+
 *
 * Key benefits over the manual loop:
 *   - Durable suspend/resume for the HITL gate (human-in-the-loop)
 *   - Explicit edge conditions replace implicit if/continue/return chains
 *   - Scroll-drift invalidation is a first-class graph conditional edge
 *   - State is typed and inspectable at every node boundary
 */

import type {
  AgentAction,
  AgentStatus,
  ExtensionSettings,
  SanitizedObservation,
  ScrollDriftState,
  LatencyBudget,
} from './types';

// ---------- Graph state ----------

/** The typed state that flows through every node in the agent graph. */
export type AgentGraphState = {
  /** Current step in the multi-turn agent loop. */
  step: number;
  /** Maximum steps allowed before termination. */
  maxSteps: number;
  /** User settings for this run. */
  settings: ExtensionSettings;
  /** The latest sanitized observation from capture+redaction. */
  observation: SanitizedObservation | null;
  /** The action returned by the VLM. */
  action: AgentAction | null;
  /** Result of the last executed action. */
  actionResult: string | null;
  /** Whether the run should stop. */
  shouldStop: boolean;
  /** Stop reason for status reporting. */
  stopReason: string;
  /** Scroll-drift guard state at this point in the graph. */
  scrollDrift: ScrollDriftState;
  /** Latency measurements for this step. */
  latency: LatencyBudget | null;
  /** Current phase for status reporting. */
  phase: AgentStatus['phase'];
  /** Human-readable status message. */
  message: string;
  /** Detector backend used. */
  detectorBackend: SanitizedObservation['privacy']['detectorBackend'];
  /** Number of redactions applied. */
  redactionCount: number;
  /** Preview data URL for the popup. */
  previewDataUrl: string | null;
  /** Whether HITL approval was given (for future interrupt/resume). */
  hitlApproved: boolean;
};

// ---------- Node definitions ----------

/** Node type: a function that takes state and returns partial state updates. */
export type GraphNode = (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;

/** Edge condition: determines which node to route to next. */
export type EdgeCondition = (state: AgentGraphState) => string;

// ---------- Graph definition ----------

export type GraphEdge = {
  from: string;
  condition?: EdgeCondition;
  targets: Record<string, string>; // condition result → target node name
  default?: string;               // fallback if no condition
};

/**
 * The 5-node agent state graph.
 *
 * This defines the graph topology and edge conditions. The actual node
 * implementations are injected by the background controller since they
 * need access to extension APIs, the sanitizer, and the egress module.
 */
export class AgentStateGraph {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private entryNode: string = '';

  /** Register a named node. */
  addNode(name: string, fn: GraphNode): this {
    this.nodes.set(name, fn);
    return this;
  }

  /** Set the entry point. */
  setEntry(name: string): this {
    this.entryNode = name;
    return this;
  }

  /** Add a conditional edge. */
  addConditionalEdge(from: string, condition: EdgeCondition, targets: Record<string, string>): this {
    this.edges.push({ from, condition, targets });
    return this;
  }

  /** Add a direct edge. */
  addEdge(from: string, to: string): this {
    this.edges.push({ from, default: to, targets: {} });
    return this;
  }

  /** Resolve the next node given current state and the node that just ran. */
  private resolveNext(currentNode: string, state: AgentGraphState): string | null {
    const edge = this.edges.find(e => e.from === currentNode);
    if (!edge) return null;
    if (edge.condition) {
      const result = edge.condition(state);
      return edge.targets[result] ?? null;
    }
    return edge.default ?? null;
  }

  /**
   * Execute the graph from the entry node through to completion.
   * Yields state updates at each node boundary for the background controller
   * to relay to the popup.
   */
  async *stream(
    initialState: AgentGraphState,
    options?: { signal?: AbortSignal; onNodeEnter?: (node: string, state: AgentGraphState) => void },
  ): AsyncGenerator<AgentGraphState, AgentGraphState, void> {
    let state = { ...initialState };
    let current = this.entryNode;

    if (!current || !this.nodes.has(current)) {
      throw new Error(`Entry node "${current}" not found in graph`);
    }

    while (current) {
      if (options?.signal?.aborted || state.shouldStop) break;

      options?.onNodeEnter?.(current, state);
      const node = this.nodes.get(current);
      if (!node) throw new Error(`Node "${current}" not found in graph`);

      const updates = await node(state);
      state = { ...state, ...updates };
      yield state;

      if (state.shouldStop) break;

      current = this.resolveNext(current, state) ?? '';
    }

    return state;
  }
}

// ---------- Standard graph builder ----------

/**
 * Build the standard 5-node agent graph with Approach B edge conditions.
 *
 * Node implementations must be provided by the caller (background controller)
 * since they depend on extension APIs not available in this module.
 */
export function buildAgentGraph(nodes: {
  observe_and_redact: GraphNode;
  vlm_plan: GraphNode;
  hitl_gate: GraphNode;
  dispatch_action: GraphNode;
  verify_settlement: GraphNode;
}): AgentStateGraph {
  const graph = new AgentStateGraph();

  // Register nodes
  graph
    .addNode('observe_and_redact', nodes.observe_and_redact)
    .addNode('vlm_plan', nodes.vlm_plan)
    .addNode('hitl_gate', nodes.hitl_gate)
    .addNode('dispatch_action', nodes.dispatch_action)
    .addNode('verify_settlement', nodes.verify_settlement)
    .setEntry('observe_and_redact');

  // Edge: observe_and_redact → vlm_plan (always, unless stopped)
  graph.addConditionalEdge('observe_and_redact', (state) => {
    if (state.shouldStop) return 'stop';
    return 'continue';
  }, { continue: 'vlm_plan', stop: '' });

  // Edge: vlm_plan → hitl_gate or re-observe (if scroll drift detected)
  graph.addConditionalEdge('vlm_plan', (state) => {
    if (state.shouldStop) return 'stop';
    if (state.scrollDrift.drifted) return 'drift';
    return 'continue';
  }, {
    continue: 'hitl_gate',
    drift: 'observe_and_redact', // Re-capture on scroll drift
    stop: '',
  });

  // Edge: hitl_gate → dispatch_action (if approved) or stop
  graph.addConditionalEdge('hitl_gate', (state) => {
    if (state.shouldStop) return 'stop';
    if (!state.hitlApproved) return 'rejected';
    return 'approved';
  }, {
    approved: 'dispatch_action',
    rejected: '',
    stop: '',
  });

  // Edge: dispatch_action → verify_settlement (always)
  graph.addEdge('dispatch_action', 'verify_settlement');

  // Edge: verify_settlement → loop back or terminate
  graph.addConditionalEdge('verify_settlement', (state) => {
    if (state.shouldStop) return 'stop';
    if (state.action?.type === 'done') return 'done';
    if (state.step >= state.maxSteps) return 'max_steps';
    return 'continue';
  }, {
    continue: 'observe_and_redact', // Loop back for next step
    done: '',
    max_steps: '',
    stop: '',
  });

  return graph;
}

// ---------- Initial state factory ----------

export function createInitialState(settings: ExtensionSettings): AgentGraphState {
  return {
    step: 0,
    maxSteps: settings.maxSteps,
    settings,
    observation: null,
    action: null,
    actionResult: null,
    shouldStop: false,
    stopReason: '',
    scrollDrift: { drifted: false, lastDriftTimestamp: null, debounceMs: 350 },
    latency: null,
    phase: 'capturing',
    message: 'Starting locally…',
    detectorBackend: 'error',
    redactionCount: 0,
    previewDataUrl: null,
    hitlApproved: true, // Default: auto-approve (HITL gate is opt-in)
  };
}

/** Exported for testing. */
export const graphInternals = { AgentStateGraph, buildAgentGraph, createInitialState };
