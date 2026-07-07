import { describe, it, expect } from "vitest";
import { agentAsTool, validatePipeline } from "./orchestration.js";
import type { AgentDefinition } from "./types.js";
import type { PipelineDefinition } from "./orchestration.js";
import type { ToolContext } from "../types/index.js";

const def: AgentDefinition = {
  id: "copy",
  name: "文案助手",
  type: "copywriting",
  description: "Writes marketing copy",
  systemPrompt: "sys",
  toolNames: [],
  defaultModelId: "m",
};

const ctx = { workingDirectory: "/tmp" } as ToolContext;

describe("agentAsTool", () => {
  it("wraps an AgentDefinition into a namespaced, non-turn-ending tool", () => {
    const tool = agentAsTool(def, async () => "result");
    expect(tool.name).toBe("agent__copy");
    expect(tool.description).toBe("Writes marketing copy");
    expect(tool.endsTurn).toBe(false);
  });

  it("passes the input through to the runner and returns its text", async () => {
    let seen: { id: string; input: string } | undefined;
    const tool = agentAsTool(def, async (d, input) => {
      seen = { id: d.id, input };
      return "final copy";
    });

    const result = await tool.execute({ input: "write a slogan" }, ctx);

    expect(seen).toEqual({ id: "copy", input: "write a slogan" });
    expect(result.content).toBe("final copy");
    expect(result.isError).toBeFalsy();
  });

  it("returns a validation error when input is missing", async () => {
    const tool = agentAsTool(def, async () => "x");
    const result = await tool.execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.errorKind).toBe("validation");
  });
});

describe("validatePipeline", () => {
  const linear: PipelineDefinition = {
    id: "p",
    steps: [
      { id: "write", kind: "agent", agentId: "copy", inputFrom: [] },
      { id: "image", kind: "generation", taskType: "image.generate", inputFrom: [{ step: "write" }] },
      { id: "review", kind: "review", inputFrom: [{ step: "image" }], gate: "review-pass" },
    ],
  };

  it("accepts a valid linear DAG", () => {
    expect(validatePipeline(linear)).toEqual([]);
  });

  it("flags duplicate step ids", () => {
    const errors = validatePipeline({
      id: "p",
      steps: [
        { id: "a", kind: "agent", agentId: "x", inputFrom: [] },
        { id: "a", kind: "agent", agentId: "y", inputFrom: [] },
      ],
    });
    expect(errors.some((e) => e.includes("duplicate"))).toBe(true);
  });

  it("flags a dangling dependency", () => {
    const errors = validatePipeline({
      id: "p",
      steps: [{ id: "a", kind: "agent", agentId: "x", inputFrom: [{ step: "ghost" }] }],
    });
    expect(errors.some((e) => e.includes("ghost"))).toBe(true);
  });

  it("flags a cycle", () => {
    const errors = validatePipeline({
      id: "p",
      steps: [
        { id: "a", kind: "agent", agentId: "x", inputFrom: [{ step: "b" }] },
        { id: "b", kind: "agent", agentId: "y", inputFrom: [{ step: "a" }] },
      ],
    });
    expect(errors.some((e) => e.toLowerCase().includes("cycle"))).toBe(true);
  });

  it("flags an agent step missing agentId and a generation step missing taskType", () => {
    const errors = validatePipeline({
      id: "p",
      steps: [
        { id: "a", kind: "agent", inputFrom: [] },
        { id: "b", kind: "generation", inputFrom: [] },
      ],
    });
    expect(errors.some((e) => e.includes("agentId"))).toBe(true);
    expect(errors.some((e) => e.includes("taskType"))).toBe(true);
  });
});
