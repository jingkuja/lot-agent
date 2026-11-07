import { describe, expect, it, vi } from "vitest";
import { chatTaskMode, createBackgroundTaskTool } from "./assignment-chat.js";

describe("chatTaskMode", () => {
  it("takes full autonomy only from the owner's own words", () => {
    for (const text of ["放后台做，不用问我", "别问我了，你自己决定", "你自己看着办", "全权交给你", "do this, don't ask me", "Do it without asking"]) {
      expect(chatTaskMode("autonomous", text)).toBe("autonomous");
    }
  });

  it("stays responsive when the owner did not say so, whatever the model asked for", () => {
    for (const text of ["放后台做", "做完告诉我", "不要自己决定，有事问我", "有问题要问我", undefined]) {
      expect(chatTaskMode("autonomous", text)).toBe("responsive");
    }
  });

  it("does not hand out autonomy the model did not ask for", () => {
    expect(chatTaskMode("responsive", "不用问我")).toBe("responsive");
    expect(chatTaskMode(undefined, "不用问我")).toBe("responsive");
  });
});

describe("start_background_task", () => {
  const context = { workingDirectory: "/", userId: "u1", conversationId: "c1", sourceText: "放后台做" };
  const task = { id: "t1", title: "开业方案", mode: "responsive" as const, status: "queued" };

  it("starts the task for the signed-in owner and gives back a link the work log can show", async () => {
    const startFromChat = vi.fn(async () => task);
    const result = await createBackgroundTaskTool({ startFromChat }).execute({ goal: " 写开业方案 ", mode: "autonomous", subtasks: ["甲", " ", 3] }, context);
    expect(startFromChat).toHaveBeenCalledWith("u1", "c1", { goal: "写开业方案", mode: "responsive", subtasks: ["甲"] });
    expect(JSON.parse(result.content)).toMatchObject({ title: "开业方案", managementUrl: "/digital-employee/assignments/t1" });
  });

  it("needs a goal and an owner", async () => {
    const startFromChat = vi.fn(async () => task);
    const tool = createBackgroundTaskTool({ startFromChat });
    expect((await tool.execute({ goal: " " }, context)).isError).toBe(true);
    expect((await tool.execute({ goal: "x" }, { workingDirectory: "/" })).isError).toBe(true);
    expect(startFromChat).not.toHaveBeenCalled();
  });
});
