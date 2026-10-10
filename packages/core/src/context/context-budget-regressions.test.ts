import { expect, it, vi } from "vitest";
import { ContextManager } from "./context-manager.js";
import type { Message } from "../types/index.js";

it("budgets image content independently of base64 transport size", async () => {
  const manager = new ContextManager();
  const message: Message = { role: "user", content: [{ type: "image", image: {
    url: `data:image/png;base64,${"A".repeat(1_398_104)}`, mediaType: "image/png",
  } }] };
  expect(manager.countMessageTokens(message)).toBe(4100);
  expect(await manager.assemble(["Describe the image"], undefined, [message])).toContainEqual(message);
});

it("reserves schema and actual output before deciding whether to compress", async () => {
  const manager = new ContextManager({ budget: { total: 20_000, generation: 4_000 } });
  const history: Message[] = Array.from({ length: 16 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "文".repeat(900) }));
  const chat = vi.fn(async function* () { yield { type: "text" as const, content: "summary" }; yield { type: "done" as const }; });
  const result = await manager.assemble(["sys"], undefined, history, undefined, { chat }, { toolTokens: 2000, generationTokens: 5000 });
  expect(chat).toHaveBeenCalled();
  expect(manager.countTotalTokens(result) + 7000).toBeLessThanOrEqual(20_000);
});

it("invalidates a same-length edited history prefix, but preserves unchanged prefixes", async () => {
  const config = { budget: { total: 20_000, generation: 4000 } };
  const history: Message[] = Array.from({ length: 16 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "旧".repeat(1250) }));
  const chat = vi.fn(async function* () { yield { type: "text" as const, content: "OLD_DELETED_FACT" }; yield { type: "done" as const }; });
  const first = new ContextManager(config);
  await first.assemble([], undefined, history, undefined, { chat });
  const state = first.getSummaryState()!;
  const next = vi.fn(async function* () { yield { type: "text" as const, content: "NEW_FACT" }; yield { type: "done" as const }; });
  const second = new ContextManager({ ...config, initialSummary: state });
  const result = await second.assemble([], undefined, history.map(m => ({ ...m, content: "新".repeat(1250) })), undefined, { chat: next });
  expect(next).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain("OLD_DELETED_FACT");
});
