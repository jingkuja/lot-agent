import { describe, it, expect } from "vitest";
import { askUserTool, ASK_USER_WAITING, hasAskUserTool } from "./ask-user.js";
import type { ToolContext } from "../types/index.js";

const ctx = { workingDirectory: "/tmp" } as ToolContext;

describe("ask_user tool", () => {
  it("is an endsTurn tool named ask_user", () => {
    expect(askUserTool.name).toBe("ask_user");
    expect(askUserTool.endsTurn).toBe(true);
  });

  it("declares a multiSelect parameter for multi-answer questions", () => {
    const props = askUserTool.parameters.properties as Record<string, unknown>;
    expect(props.multiSelect).toBeDefined();
  });

  it("returns the waiting placeholder on a valid question", async () => {
    const r = await askUserTool.execute(
      { question: "PPT 大约需要几页？", options: ["8 页", "12 页"] },
      ctx
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe(ASK_USER_WAITING);
  });

  it("rejects a missing/blank question as validation error", async () => {
    const r = await askUserTool.execute({ question: "  " }, ctx);
    expect(r.isError).toBe(true);
    expect(r.errorKind).toBe("validation");
  });

  it("hasAskUserTool follows whitelist semantics", () => {
    expect(hasAskUserTool(undefined)).toBe(true); // 未限制 = 全部工具
    expect(hasAskUserTool(["ask_user", "generate_ppt"])).toBe(true);
    expect(hasAskUserTool(["web_search"])).toBe(false);
  });
});
