# Model Selection Defaults + Title Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Title summarization runs on the same model as the chat turn, and the model picker actually selects (and sends) the first model of each catalog group as the default — with a proper「默认」empty state when the catalog is empty.

**Architecture:** Server: `generateTitle` gains `opts { userId, modelId }` and resolves its LLM with the exact chain the chat path uses (`resolveConversationModel` + apiKey→`providerFactory.llm`, else env `getLLMProvider()`). Web: `Workspace`'s single `selectedModel` becomes a per-group record (`llm`/`image`/`video`), each slot pre-filled with that group's first catalog model by a pure, tested helper; `ModelPicker` grows an empty state.

**Tech Stack:** TypeScript ESM monorepo, Hono server, React 19 + Vite web, Vitest.

Spec: `docs/superpowers/specs/2026-07-02-model-selection-title-design.md`

## Global Constraints

- ESM imports use explicit `.js` suffixes; 2-space indent.
- No new CSS colors — the empty-state hint row reuses the existing `.model-empty` class (already styled with `var(--*)` tokens).
- Exact copy strings: trigger label **「默认」**, hint row **「无更多模型，请联系管理员」**.
- No changes to `GET /api/models`, its Redis caching, or catalog grouping.
- Title generation stays best-effort — both call sites keep their existing try/catch.
- All commands run from the repo root `/Users/nikin/project/practice/lot-agent`.

---

### Task 1: `generateTitle` uses the turn's model (server)

**Files:**
- Modify: `packages/server/src/services/agent-service.ts` (the `generateTitle` method, ~lines 318–368)
- Modify: `packages/server/src/routes/conversations.ts` (two `generateTitle` call sites, ~lines 199 and 309)
- Test: `packages/server/src/services/agent-service.title.test.ts` (new)

**Interfaces:**
- Consumes: existing `resolveConversationModel(explicit, conversationModelId, agentDefault)` (exported from `agent-service.ts`), `this.providerFactory.llm(modelId, apiKey)`, `this.db.getUserApiKey(userId)`, `this.llmConfig.default`, private `this.getLLMProvider()`.
- Produces: `generateTitle(conversationId: string, userMessage: string, attachments?: AttachmentRef[], opts?: { userId?: string; modelId?: string }): Promise<string | null>` — signature later tasks do NOT depend on; web is unaffected.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/services/agent-service.title.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { AgentService } from "./agent-service.js";

/** generateTitle 的最小假 this:只带该方法用到的依赖。 */
function fakeService(overrides: { conversationModel?: string | null; apiKey?: string | null } = {}) {
  const chat = async function* () {
    yield { type: "text", content: "测试标题" };
  };
  const fake = {
    db: {
      getConversation: vi.fn(async () => ({
        id: "c1",
        title: "新对话",
        model: overrides.conversationModel ?? null,
      })),
      getMessages: vi.fn(async () => [{ role: "user" }]),
      getUserApiKey: vi.fn(async () => overrides.apiKey ?? null),
      updateConversationTitle: vi.fn(async () => {}),
    },
    llmConfig: { default: "m-env" },
    providerFactory: { llm: vi.fn(() => ({ chat })) },
    getLLMProvider: vi.fn(() => ({ chat })),
    generateTitle: AgentService.prototype.generateTitle,
  };
  return fake as unknown as AgentService & typeof fake;
}

describe("generateTitle model resolution", () => {
  it("explicit modelId wins over the conversation's stored model", async () => {
    const svc = fakeService({ conversationModel: "m-conv", apiKey: "key-1" });
    const title = await svc.generateTitle("c1", "你好", [], { userId: "u1", modelId: "m-explicit" });
    expect(title).toBe("测试标题");
    expect(svc.providerFactory.llm).toHaveBeenCalledWith("m-explicit", "key-1");
    expect(svc.getLLMProvider).not.toHaveBeenCalled();
  });

  it("falls back to the conversation's stored model", async () => {
    const svc = fakeService({ conversationModel: "m-conv", apiKey: "key-1" });
    await svc.generateTitle("c1", "你好", [], { userId: "u1" });
    expect(svc.providerFactory.llm).toHaveBeenCalledWith("m-conv", "key-1");
  });

  it("falls back to the env default model when nothing is stored", async () => {
    const svc = fakeService({ conversationModel: null, apiKey: "key-1" });
    await svc.generateTitle("c1", "你好", [], { userId: "u1" });
    expect(svc.providerFactory.llm).toHaveBeenCalledWith("m-env", "key-1");
  });

  it("uses the env provider when the user has no apiKey", async () => {
    const svc = fakeService({ conversationModel: "m-conv", apiKey: null });
    const title = await svc.generateTitle("c1", "你好", [], { userId: "u1" });
    expect(title).toBe("测试标题");
    expect(svc.providerFactory.llm).not.toHaveBeenCalled();
    expect(svc.getLLMProvider).toHaveBeenCalled();
  });

  it("uses the env provider when no opts are passed (legacy call)", async () => {
    const svc = fakeService({ conversationModel: "m-conv" });
    const title = await svc.generateTitle("c1", "你好");
    expect(title).toBe("测试标题");
    expect(svc.db.getUserApiKey).not.toHaveBeenCalled();
    expect(svc.providerFactory.llm).not.toHaveBeenCalled();
    expect(svc.getLLMProvider).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/server/src/services/agent-service.title.test.ts`
Expected: FAIL — the first four tests fail on `providerFactory.llm` / `getLLMProvider` call assertions (current implementation always uses `getLLMProvider()` and never reads `opts`). The legacy-call test may already pass.

- [ ] **Step 3: Implement the resolution in `generateTitle`**

In `packages/server/src/services/agent-service.ts`:

(a) Change the method signature (currently `async generateTitle(conversationId: string, userMessage: string, attachments?: AttachmentRef[])`) to:

```ts
  async generateTitle(
    conversationId: string,
    userMessage: string,
    attachments?: AttachmentRef[],
    opts?: { userId?: string; modelId?: string }
  ): Promise<string | null> {
```

(b) Replace the single line `const llm = this.getLLMProvider();` (inside the method, right after the `titleInput` const) with:

```ts
      // Title runs on the same model as the chat turn: explicit pick > the
      // conversation's stored model > env default — with the same apiKey /
      // provider fallback chain as streamAgentResponse.
      const modelId = resolveConversationModel(
        opts?.modelId,
        conversation.model,
        this.llmConfig.default
      );
      const apiKey = opts?.userId ? await this.db.getUserApiKey(opts.userId) : null;
      const llm = apiKey
        ? this.providerFactory.llm(modelId, apiKey)
        : this.getLLMProvider();
```

Nothing else in the method changes (the doc comment above it may gain one line noting the model choice).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/server/src/services/agent-service.title.test.ts`
Expected: PASS — all 5 tests.

- [ ] **Step 5: Pass the turn's context at both call sites**

In `packages/server/src/routes/conversations.ts`:

(a) Chat SSE route (~line 199) — `userId` and `body` are in scope:

```ts
            const title = await service.generateTitle(
              id,
              body.content ?? "",
              attachments,
              { userId, modelId: body.modelId }
            );
```

(b) Media-generation route (~line 309) — pass `userId` only (the turn's model there is an image/video model and cannot summarize text; `conversation.model` only ever holds LLM ids):

```ts
      title = await service.generateTitle(conversationId, prompt, [], { userId });
```

- [ ] **Step 6: Run the server suite and build**

Run: `npm test -w @lot-agent/server && npm run build -w @lot-agent/server`
Expected: all tests PASS (including `routes/generations.test.ts`, whose `generateTitle` mock tolerates the extra argument) and tsup build succeeds.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/services/agent-service.ts packages/server/src/services/agent-service.title.test.ts packages/server/src/routes/conversations.ts
git commit -m "feat(server): conversation title summarizes with the turn's model"
```

---

### Task 2: `model-defaults` pure helper (web)

**Files:**
- Create: `packages/web/src/lib/model-defaults.ts`
- Test: `packages/web/src/lib/model-defaults.test.ts` (new)

**Interfaces:**
- Consumes: `CatalogModel` type from `packages/web/src/lib/model-filter.ts`.
- Produces (Task 3 imports all of these from `../lib/model-defaults.js`):
  - `type ModelGroup = "llm" | "image" | "video"`
  - `type SelectedModels = Record<ModelGroup, string | null>`
  - `const EMPTY_SELECTED: SelectedModels`
  - `groupForKind(kind: string | undefined): ModelGroup`
  - `fillModelDefaults(prev: SelectedModels, catalog: { llm: CatalogModel[]; image: CatalogModel[]; video: CatalogModel[] }): SelectedModels`

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/lib/model-defaults.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { EMPTY_SELECTED, fillModelDefaults, groupForKind } from "./model-defaults.js";
import type { CatalogModel } from "./model-filter.js";

const m = (id: string, type: CatalogModel["type"]): CatalogModel => ({ id, type, provider: "p" });

const catalog = {
  llm: [m("gpt-a", "llm"), m("gpt-b", "llm")],
  image: [m("img-a", "image")],
  video: [] as CatalogModel[],
};

describe("fillModelDefaults", () => {
  it("fills null slots with each group's first model id", () => {
    expect(fillModelDefaults(EMPTY_SELECTED, catalog)).toEqual({
      llm: "gpt-a",
      image: "img-a",
      video: null,
    });
  });

  it("preserves existing picks", () => {
    const prev = { llm: "gpt-b", image: null, video: null };
    expect(fillModelDefaults(prev, catalog)).toEqual({
      llm: "gpt-b",
      image: "img-a",
      video: null,
    });
  });

  it("is a no-op on an empty catalog", () => {
    const empty = { llm: [], image: [], video: [] };
    expect(fillModelDefaults(EMPTY_SELECTED, empty)).toEqual(EMPTY_SELECTED);
  });
});

describe("groupForKind", () => {
  it("maps image/video kinds to their group and everything else to llm", () => {
    expect(groupForKind("image")).toBe("image");
    expect(groupForKind("video")).toBe("video");
    expect(groupForKind("general")).toBe("llm");
    expect(groupForKind("copywriting")).toBe("llm");
    expect(groupForKind(undefined)).toBe("llm");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/web/src/lib/model-defaults.test.ts`
Expected: FAIL — cannot resolve `./model-defaults.js` (module does not exist).

- [ ] **Step 3: Implement the helper**

Create `packages/web/src/lib/model-defaults.ts`:

```ts
import type { CatalogModel } from "./model-filter.js";

export type ModelGroup = "llm" | "image" | "video";

/** 每组各自记住的选中模型;null = 尚未选择(目录为空时保持 null,由服务端默认兜底)。 */
export type SelectedModels = Record<ModelGroup, string | null>;

export const EMPTY_SELECTED: SelectedModels = { llm: null, image: null, video: null };

/** Agent kind → 模型目录分组(文字类 Agent 都用 llm 组)。 */
export function groupForKind(kind: string | undefined): ModelGroup {
  return kind === "image" || kind === "video" ? kind : "llm";
}

/** 只填补还未选择(null)的槽位:取各组接口返回的第一个模型;已有选择保持不变。 */
export function fillModelDefaults(
  prev: SelectedModels,
  catalog: { llm: CatalogModel[]; image: CatalogModel[]; video: CatalogModel[] }
): SelectedModels {
  return {
    llm: prev.llm ?? catalog.llm[0]?.id ?? null,
    image: prev.image ?? catalog.image[0]?.id ?? null,
    video: prev.video ?? catalog.video[0]?.id ?? null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/src/lib/model-defaults.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/model-defaults.ts packages/web/src/lib/model-defaults.test.ts
git commit -m "feat(web): model-defaults helper (per-group first-model defaults)"
```

---

### Task 3: Wire per-group selection + picker empty state (web)

**Files:**
- Modify: `packages/web/src/pages/Workspace.tsx` (selectedModel state → per-group record; ~lines 77–79, 146–171, 289–291)
- Modify: `packages/web/src/components/ModelPicker.tsx` (empty state)
- Modify: `packages/web/src/components/InputBox.tsx` (~line 232, drop the `models.length > 0` guard)

**Interfaces:**
- Consumes: `EMPTY_SELECTED`, `fillModelDefaults`, `groupForKind`, `SelectedModels` from Task 2 (`../lib/model-defaults.js`).
- Produces: no new exports — `ChatPanel` props (`selectedModel: string | null`, `onModelChange: (id: string) => void`) are unchanged; `ChatPanel.tsx` is NOT modified.

- [ ] **Step 1: Rework `Workspace` model-selection state**

In `packages/web/src/pages/Workspace.tsx`:

(a) Add to the imports from `../lib/`:

```ts
import { EMPTY_SELECTED, fillModelDefaults, groupForKind } from "../lib/model-defaults.js";
```

(b) Replace the current state + seeding block (~lines 76–79):

```ts
  // Per-user model catalog + the model selected for the current conversation.
  const { models: modelCatalog } = useModels();
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  // Seed the picker from the loaded conversation's stored model.
  useEffect(() => { setSelectedModel(conversationModel); }, [conversationModel]);
```

with:

```ts
  // Per-user model catalog + per-group (llm/image/video) selected models.
  const { models: modelCatalog } = useModels();
  const [selectedModels, setSelectedModels] = useState(EMPTY_SELECTED);
  // Catalog loaded → 各组默认选中接口返回的第一个模型(已选过的槽位不动)。
  useEffect(() => {
    setSelectedModels((prev) => fillModelDefaults(prev, modelCatalog));
  }, [modelCatalog]);
  // 进入会话:已存模型优先;无存储(新会话)回落到 llm 组第一个。
  useEffect(() => {
    setSelectedModels((prev) => ({
      ...prev,
      llm: conversationModel ?? modelCatalog.llm[0]?.id ?? null,
    }));
  }, [conversationModel, modelCatalog]);
```

(c) In `doSend` (~lines 146–171), replace the `dispatch` body and dep array — media sends its own group's pick, chat sends the llm pick:

```ts
      const dispatch = () => {
        if (kind === "image" || kind === "video") {
          generateMedia(content, kind as "image" | "video", settings, files, selectedModels[kind as "image" | "video"] ?? undefined);
        } else {
          send(content, files, undefined, selectedModels.llm ?? undefined);
        }
      };
```

and change `selectedModel` to `selectedModels` in the `useCallback` dependency array.

(d) Above the `return`, derive the open agent's group and a group-scoped change handler:

```ts
  // 当前 hero Agent 对应的模型分组;切组时各组各自记住上次的选择。
  const modelGroup = groupForKind(openAgent?.type || openAgent?.id);
  const handleModelChange = useCallback(
    (id: string) => setSelectedModels((prev) => ({ ...prev, [modelGroup]: id })),
    [modelGroup]
  );
```

(e) Update the `ChatPanel` props (~lines 289–291):

```tsx
            modelCatalog={modelCatalog}
            selectedModel={selectedModels[modelGroup]}
            onModelChange={handleModelChange}
```

- [ ] **Step 2: Add the `ModelPicker` empty state**

In `packages/web/src/components/ModelPicker.tsx`, replace the `current` const and the popup block:

```tsx
  const isEmpty = models.length === 0;
  const current = isEmpty ? "默认" : value ?? models[0]?.id ?? "选择模型";
  const filtered = filterModels(models, query);
```

and the popup (`{open && (...)}`):

```tsx
      {open && (
        <div className="media-popup model-popup">
          {isEmpty ? (
            /* 目录为空:仅一行灰色提示,不可选;沿用 model-empty 样式 */
            <div className="model-empty">无更多模型，请联系管理员</div>
          ) : (
            <>
              <input
                className="model-search"
                autoFocus
                placeholder="输入字母快速筛选…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="model-list">
                {filtered.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`model-row ${m.id === value ? "active" : ""}`}
                    onClick={() => {
                      onChange(m.id);
                      setOpen(false);
                    }}
                  >
                    <span className="model-row-name">{m.label ?? m.id}</span>
                    {m.description && <span className="model-row-desc">{m.description}</span>}
                  </button>
                ))}
                {filtered.length === 0 && <div className="model-empty">无匹配模型</div>}
              </div>
            </>
          )}
        </div>
      )}
```

(No CSS changes — `.model-empty` already exists and uses theme tokens.)

- [ ] **Step 3: Always render the picker in `InputBox`**

In `packages/web/src/components/InputBox.tsx` (~line 232), change:

```tsx
          {models.length > 0 && onModelChange && (
```

to:

```tsx
          {onModelChange && (
```

- [ ] **Step 4: Run web tests and build**

Run: `npx vitest run packages/web && npm run build -w @lot-agent/web`
Expected: all web tests PASS (model-defaults, model-filter, agent-order, auto-page, rsa, theme); `tsc -b && vite build` succeeds.

- [ ] **Step 5: Manual verification**

Run `npm run dev` (needs server + Redis + PG) and check in the browser:
- New chat: picker shows the llm group's first model (not a bare display fallback) and that id is sent with the first message (Network tab: `modelId` in the POST body).
- Switch hero to 图片 then back to 通用: image group shows its own first model; picking a different llm model, switching to 图片 and back, restores the llm pick (per-group memory).
- Open an old conversation with a stored model: picker shows the stored model, not the group default.
- Empty catalog (log in as a user with no apiKey, or stop the upstream): trigger shows「默认」; clicking opens the popup with only the grey row「无更多模型，请联系管理员」; nothing selectable; sending still works (server default).
- Send a first message and confirm the sidebar title appears (title path unbroken end-to-end).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/pages/Workspace.tsx packages/web/src/components/ModelPicker.tsx packages/web/src/components/InputBox.tsx
git commit -m "feat(web): per-group model defaults + picker empty state (默认/联系管理员)"
```
