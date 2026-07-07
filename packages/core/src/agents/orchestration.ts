import type { Tool, ToolContext } from "../types/index.js";
import type { AgentDefinition } from "./types.js";

/**
 * Multi-Agent orchestration primitives (E5).
 *   ① agentAsTool — expose a registered Agent as a tool another Agent can call.
 *   ② Pipeline    — a declarative DAG of steps for a worker to run.
 * Both are pure/plumbing: no execution engine here, only the shapes + validation.
 */

/** Wrap an Agent as a tool other Agents can invoke (agent-as-tool). */
export function agentAsTool(
  def: AgentDefinition,
  runner: (def: AgentDefinition, input: string, ctx: ToolContext) => Promise<string>
): Tool {
  return {
    name: `agent__${def.id}`,
    description: def.description,
    parameters: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: `Task/instruction to delegate to the ${def.name} agent.`,
        },
      },
      required: ["input"],
    },
    // A sub-Agent call returns control to the calling Agent, not the user.
    endsTurn: false,
    async execute(input: unknown, ctx: ToolContext) {
      const text = (input as { input?: unknown })?.input;
      if (typeof text !== "string" || text.trim() === "") {
        return {
          content: 'Invalid input: expected a non-empty string field "input".',
          isError: true,
          errorKind: "validation" as const,
        };
      }
      const result = await runner(def, text, ctx);
      return { content: result };
    },
  };
}

// ── Pipeline (declarative DAG) ──

export type PipelineStepKind = "agent" | "generation" | "review" | "publish";
export type PipelineGate = "review-pass" | "manual-approve";

export interface PipelineStep {
  id: string;
  kind: PipelineStepKind;
  /** Required when kind = "agent". */
  agentId?: string;
  /** Required when kind = "generation" — the jobs task type. */
  taskType?: string;
  /** Upstream dependencies (DAG edges): which steps feed this one. */
  inputFrom: Array<{ step: string; field?: string }>;
  /** Optional gate that halts the pipeline until satisfied. */
  gate?: PipelineGate;
}

export interface PipelineDefinition {
  id: string;
  steps: PipelineStep[];
}

/**
 * Validate a pipeline definition. Returns a list of human-readable errors
 * (empty = valid). Pure — TDD-friendly, no side effects. Checks: duplicate
 * ids, per-kind required fields, dangling/self dependencies, and cycles.
 */
export function validatePipeline(def: PipelineDefinition): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const seen = new Set<string>();

  for (const step of def.steps) {
    if (seen.has(step.id)) errors.push(`duplicate step id: "${step.id}"`);
    seen.add(step.id);
    ids.add(step.id);
  }

  for (const step of def.steps) {
    if (step.kind === "agent" && !step.agentId) {
      errors.push(`step "${step.id}" (agent) is missing agentId`);
    }
    if (step.kind === "generation" && !step.taskType) {
      errors.push(`step "${step.id}" (generation) is missing taskType`);
    }
    for (const dep of step.inputFrom) {
      if (dep.step === step.id) {
        errors.push(`step "${step.id}" depends on itself`);
      } else if (!ids.has(dep.step)) {
        errors.push(`step "${step.id}" has a dangling dependency: "${dep.step}"`);
      }
    }
  }

  const cycle = findCycle(def.steps, ids);
  if (cycle) errors.push(`dependency cycle detected: ${cycle.join(" → ")}`);

  return errors;
}

/** DFS cycle detection; returns the cycle path or null. Ignores dangling edges. */
function findCycle(steps: PipelineStep[], ids: Set<string>): string[] | null {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const st = state.get(id);
    if (st === "done") return null;
    if (st === "visiting") {
      const from = stack.indexOf(id);
      return [...stack.slice(from), id];
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of byId.get(id)?.inputFrom ?? []) {
      if (dep.step === id || !ids.has(dep.step)) continue; // self/dangling handled elsewhere
      const found = visit(dep.step);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const s of steps) {
    const found = visit(s.id);
    if (found) return found;
  }
  return null;
}
