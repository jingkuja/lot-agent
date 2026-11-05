import { describe, expect, it, vi } from "vitest";
import { InputError } from "../errors.js";
import { createMarketingVideoTools } from "./marketing-video-tools.js";

const context = { userId: "u1", conversationId: "c1", sourceMessageId: "m1" } as never;

function setup(guard = vi.fn(async () => {})) {
  const create = vi.fn(async () => ({ projectId: "p1", reused: false }));
  const [tool] = createMarketingVideoTools({ create }, guard);
  return { tool: tool!, create, guard };
}

describe("start_marketing_video", () => {
  it("creates a draft and returns the studio link", async () => {
    const { tool, create } = setup();
    const result = await tool.execute({ topic: "代销方案介绍", durationSec: 30 }, context);
    expect(create).toHaveBeenCalledWith("u1", expect.objectContaining({ topic: "代销方案介绍", durationSec: 30, requestKey: "c1:m1:代销方案介绍" }));
    expect(JSON.parse(result.content)).toMatchObject({ projectId: "p1", managementUrl: "/assistant?agent=marketing_video&project=p1" });
  });

  it("stops a brief that names a customer before anything is written", async () => {
    const guard = vi.fn(async () => { throw new InputError("视频需求包含本账号客户的姓名或别名「李静」"); });
    const { tool, create } = setup(guard);
    const result = await tool.execute({ topic: "用李静的例子做视频" }, context);
    expect(result.isError).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([[{ topic: "" }], [{ topic: "t", durationSec: 5 }], [{ topic: "t", ratio: "4:3" }]])("rejects %j", async (input) => {
    const { tool, create } = setup();
    expect((await tool.execute(input, context)).isError).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });
});
