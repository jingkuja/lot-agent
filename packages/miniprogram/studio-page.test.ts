import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POSTER_TEMPLATES } from "./miniprogram/services/templates";

vi.mock("./miniprogram/services/generate", () => ({ runImageGeneration: vi.fn(), toastError: vi.fn() }));
vi.mock("./miniprogram/services/session", () => ({ clearStudioConversationId: vi.fn() }));

let page: any;
let app: any;

beforeEach(async () => {
  vi.resetModules();
  app = { globalData: {}, ensureSession: vi.fn() };
  vi.stubGlobal("getApp", () => app);
  vi.stubGlobal("wx", { showToast: vi.fn() });
  vi.stubGlobal("Page", (definition: any) => {
    page = {
      ...definition,
      data: structuredClone(definition.data),
      setData(update: any) { Object.assign(this.data, update); },
    };
  });
  await import("./miniprogram/pages/studio/index");
});

afterEach(() => vi.unstubAllGlobals());

describe("studio prompt availability", () => {
  it("keeps empty and whitespace-only drafts unavailable, even with a reference image", async () => {
    expect(page.data.hasPrompt).toBe(false);
    page.data.refs = ["reference.png"];
    page.onPrompt({ detail: { value: " \n　" } });
    expect(page.data.hasPrompt).toBe(false);
    await page.print();
    expect(app.ensureSession).not.toHaveBeenCalled();
  });

  it("enables a typed prompt and resets availability when cleared", () => {
    page.onPrompt({ detail: { value: "清晨的森林" } });
    expect(page.data.hasPrompt).toBe(true);
    page.newSheet();
    expect(page.data).toMatchObject({ prompt: "", hasPrompt: false });
  });

  it("enables an idea and disables it when the text is erased", () => {
    page.pickIdea({ currentTarget: { dataset: { text: "山间小屋" } } });
    expect(page.data.hasPrompt).toBe(true);
    page.onPrompt({ detail: { value: "" } });
    expect(page.data.hasPrompt).toBe(false);
  });

  it.each(["森林", " \n"])("checks decoded query prompts: %j", (prompt) => {
    page.onLoad({ prompt: encodeURIComponent(prompt) });
    expect(page.data.prompt).toBe(prompt);
    expect(page.data.hasPrompt).toBe(Boolean(prompt.trim()));
  });

  it("enables prompts from both poster template entry points", () => {
    const template = POSTER_TEMPLATES[0];
    page.onLoad({ template: template.id, topic: "咖啡" });
    expect(page.data.hasPrompt).toBe(true);
    page.newSheet();
    app.globalData.posterJob = { id: template.id, topic: "咖啡" };
    page.onShow();
    expect(page.data.hasPrompt).toBe(true);
  });

  it("does not clear a draft while generation is running", () => {
    page.onPrompt({ detail: { value: "清晨的森林" } });
    page.data.busy = true;
    page.newSheet();
    expect(page.data.prompt).toBe("清晨的森林");
  });
});
