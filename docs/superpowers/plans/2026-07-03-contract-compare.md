# 合同对比 Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把占位的「合同审核」子 Agent 重做为「合同对比」：双合同 slot 上传入口 → LLM 语义比对（主体变更/新增/删除/内容变化）→ 过程疑问用 ask_user 卡片 → 结果后询问并生成对比报告（generate_document）。

**Architecture:** 零新增算法/渲染代码。复用三套既有基础设施：`AttachmentRef.slot` 附件角色机制（新增 `contract_old`/`contract_new` 两个角色，正文用角色化标记包裹进上下文）、`ask_user` endsTurn 工具 + AskUserCard 前端卡片、`generate_document` 工具（docx/pdf/md/html）。比对本身由 systemPrompt 驱动 LLM 完成。

**Tech Stack:** TypeScript monorepo（npm workspaces, ESM, `.js` 后缀导入），Vitest（测试与源码同目录），React 19 + Vite（web 无测试基建）。

**Spec:** `docs/superpowers/specs/2026-07-03-contract-compare-design.md`

## Global Constraints

- ESM 导入必须带显式 `.js` 后缀；2 空格缩进。
- web 样式只用现有 `var(--*)` token，禁止新增硬编码 hex/rgba。
- `contract` 的 `id`/`type` 保持 `"contract"` 不变（web 图标按 type 匹配）。
- 上传白名单、`MAX_DOC_CHARS` 截断、解析失败降级文案均不改动。
- 无新依赖。

---

### Task 1: core — contract AgentDefinition 重写

**Files:**
- Modify: `packages/core/src/agents/definitions/contract.ts`（整文件替换）
- Test: `packages/core/src/agents/definitions/definitions.test.ts:14-18`

**Interfaces:**
- Consumes: `AgentDefinition` 类型（`../types.js`，已有）；工具名 `"ask_user"`（core 内置）与 `"generate_document"`（server 启动时注册进 toolRegistry，按 `toolNames` 白名单对 Agent 可见——与 ppt 的 `generate_ppt` 同机制，无需注册改动）。
- Produces: `contractDefinition`（name「合同对比」、`toolNames: ["ask_user", "generate_document"]`）。Task 2 的角色标记文案 `[旧版合同: …]` / `[新版合同: …]` 必须与本 systemPrompt 中的描述逐字一致。

- [ ] **Step 1: 改写失败测试**

替换 `definitions.test.ts` 中现有的 `it("contract is a review stub agent", …)`（第 14–18 行）为：

```ts
  it("contract is a real comparison agent with ask_user + generate_document", () => {
    expect(contractDefinition.id).toBe("contract");
    expect(contractDefinition.type).toBe("contract");
    expect(contractDefinition.category).toBe("审核");
    expect(contractDefinition.name).toBe("合同对比");
    expect(contractDefinition.toolNames).toEqual(["ask_user", "generate_document"]);
    expect(contractDefinition.systemPrompt).toContain("[旧版合同:");
    expect(contractDefinition.systemPrompt).toContain("[新版合同:");
    expect(contractDefinition.systemPrompt).toContain("generate_document");
    expect(contractDefinition.systemPrompt).not.toContain("占位");
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @lot-agent/core -- definitions`
Expected: FAIL —— `name` 断言（"合同审核" ≠ "合同对比"）或 `toolNames` 断言（`[]` ≠ 两工具）。

- [ ] **Step 3: 重写 contract.ts**

整文件替换 `packages/core/src/agents/definitions/contract.ts`：

```ts
import type { AgentDefinition } from "../types.js";

export const contractDefinition: AgentDefinition = {
  id: "contract",
  name: "合同对比",
  type: "contract",
  description: "上传新旧两版合同，找出条款增删、内容变化与主体变更",
  category: "审核",
  systemPrompt: `你是合同对比助手，负责比对同一份合同的新旧两个版本，找出所有实质性差异。

工作流程：
1. 盘点输入。用户消息里可能包含：
   - [旧版合同: 文件名]…[/旧版合同: 文件名] 包裹的旧版正文；
   - [新版合同: 文件名]…[/新版合同: 文件名] 包裹的新版正文；
   - 用户的文字说明（例如只关注某类条款）。
   缺少哪一份合同，就用 ask_user 提醒用户通过输入框上传那一份（一次只问一个问题）；两份都缺时先了解用户需求再逐份催传。
2. 主体核对。先比对合同双方主体：甲方/乙方名称、统一社会信用代码、住所地址、法定代表人等；任何主体信息变更单独列出并提示核实。
3. 条款比对。对两版合同做语义对齐（不要假设条款编号一致，编号错位时按内容配对），输出三类差异：
   - 新增条款：新版有、旧版无；
   - 删除条款：旧版有、新版无；
   - 内容变化：同一条款两版文本不同——逐条给出旧文摘录、新文摘录、变化影响说明。
4. 有疑问就问。比对中遇到歧义（条款对应关系无法确认、正文疑似解析不全、是否只需关注某类条款等），用 ask_user 向用户确认，不要自行猜测。
5. 输出结果。用结构化 markdown 呈现，依次四节：主体变更 / 新增条款 / 删除条款 / 内容变化；每条差异附一句风险提示。若正文含 [内容过长已截断] 标记，必须注明仅比对了截断前内容。
6. 询问报告。结果给出后，用 ask_user 询问「是否生成对比报告」，options 固定为：["生成 Word 报告 (docx)", "生成 PDF 报告", "生成 Markdown 报告", "不需要"]。用户选择格式后调用 generate_document（format 对应 docx/pdf/md），content 为完整对比结果的 markdown，把返回的下载链接交给用户。

规则：不向用户展示 assetId 等内部细节；某份合同解析失败或正文为空时如实转告并请求重新上传；不要在没有拿到两份正文前给出比对结论。`,
  toolNames: ["ask_user", "generate_document"],
  defaultModelId: "deepseek-v4-flash",
  inputSchema: {
    type: "object",
    properties: {
      oldContract: { type: "string" },
      newContract: { type: "string" },
    },
    required: [],
  },
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @lot-agent/core -- definitions`
Expected: PASS（3 个用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agents/definitions/contract.ts packages/core/src/agents/definitions/definitions.test.ts
git commit -m "feat(core): 合同审核 Agent 重做为合同对比（ask_user + generate_document）"
```

---

### Task 2: server — attachment-extractor 合同 slot

**Files:**
- Modify: `packages/server/src/services/attachment-extractor.ts:46-55`（slot 类型）与 `:139-144`（包裹标记）
- Test: `packages/server/src/services/attachment-extractor.test.ts`（文件末尾新增 describe）

**Interfaces:**
- Consumes: `AttachmentRef`、`extractAttachment(att, storage)`（本文件已有）。
- Produces: `AttachmentRef.slot` 联合类型扩为 `"ppt_template" | "content" | "contract_old" | "contract_new"`；`contract_old` 正文包裹为 `[旧版合同: 文件名]\n正文\n[/旧版合同: 文件名]`，`contract_new` 同理用 `新版合同`。前端（Task 3）发送的 slot 字符串必须与这两个值逐字一致。

- [ ] **Step 1: 写失败测试**

在 `attachment-extractor.test.ts` 末尾（`isSafeUploadKey` describe 之前或之后均可）追加：

```ts
describe("extractAttachment: contract slots", () => {
  const contractBase = {
    assetId: "c-old", size: 10, kind: "doc" as const,
  };

  it("wraps contract_old text with 旧版合同 markers", async () => {
    const storage = { get: vi.fn(async () => Buffer.from("第一条 甲方为A公司")) } as any;
    const part = await extractAttachment(
      {
        ...contractBase, filename: "old.txt", mime: "text/plain",
        url: "/static/uploads/c-old.txt", slot: "contract_old",
      },
      storage
    );
    expect(part).toEqual({
      type: "text",
      text: "[旧版合同: old.txt]\n第一条 甲方为A公司\n[/旧版合同: old.txt]",
    });
  });

  it("wraps contract_new text with 新版合同 markers", async () => {
    const storage = { get: vi.fn(async () => Buffer.from("第一条 甲方为B公司")) } as any;
    const part = await extractAttachment(
      {
        ...contractBase, assetId: "c-new", filename: "new.txt", mime: "text/plain",
        url: "/static/uploads/c-new.txt", slot: "contract_new",
      },
      storage
    );
    expect(part).toEqual({
      type: "text",
      text: "[新版合同: new.txt]\n第一条 甲方为B公司\n[/新版合同: new.txt]",
    });
  });

  it("keeps the generic degradation copy when a contract file is unreadable", async () => {
    const storage = {
      get: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
    } as any;
    const part = await extractAttachment(
      {
        ...contractBase, filename: "gone.pdf", mime: "application/pdf",
        url: "/static/uploads/c-old.pdf", slot: "contract_old",
      },
      storage
    );
    expect(part).toEqual({ type: "text", text: "[附件 gone.pdf 无法读取，已忽略内容]" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @lot-agent/server -- attachment-extractor`
Expected: FAIL —— 前两个新用例收到 `[附件: old.txt]…` 包裹（旧标记），第三个用例应已通过（降级路径在 slot 判断之前，不变）。同时 TypeScript 可能对 `slot: "contract_old"` 报类型错——这正是要改的类型。

- [ ] **Step 3: 扩展 slot 类型与包裹标记**

`attachment-extractor.ts` 第 53–54 行，slot 字段改为：

```ts
  /** 附件角色：PPT 模版 / 撰写素材 / 合同对比的旧版与新版正文。 */
  slot?: "ppt_template" | "content" | "contract_old" | "contract_new";
```

第 139–144 行（`let body = text;` 起的收尾段）改为：

```ts
  let body = text;
  if (body.length > MAX_DOC_CHARS) {
    body = body.slice(0, MAX_DOC_CHARS) + "\n…[内容过长已截断]";
  }
  // 合同对比 slot：用角色化标记包裹正文，让 LLM 分清哪份是旧版/新版。
  const label =
    att.slot === "contract_old" ? "旧版合同" : att.slot === "contract_new" ? "新版合同" : "附件";
  return { type: "text", text: `[${label}: ${att.filename}]\n${body}\n[/${label}: ${att.filename}]` };
```

注意：现有通用附件的 `[附件: …]` 包裹行为不变（label 默认「附件」）；解析失败/不可读/不可访问的降级返回都发生在这段之前，文案保持原样。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @lot-agent/server -- attachment-extractor`
Expected: PASS（原有用例 + 3 个新用例全绿；`[附件: …]` 相关旧用例不受影响）。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/attachment-extractor.ts packages/server/src/services/attachment-extractor.test.ts
git commit -m "feat(server): 附件提取支持 contract_old/contract_new 角色化标记"
```

---

### Task 3: web — contract 输入模式（双合同上传入口）

**Files:**
- Modify: `packages/web/src/api/client.ts:93`（AttachmentSlot）
- Modify: `packages/web/src/components/InputBox.tsx`（InputMode、双入口、chips、handleSend）
- Modify: `packages/web/src/components/ChatPanel.tsx`（mode 映射 + placeholder）
- Modify: `packages/web/src/App.css:1061-1068` 附近（新增 badge-old / badge-new）

web 无测试基建（与 PPT 期一致），本任务以 `npm run build -w @lot-agent/web`（tsc + vite）做验证。

**Interfaces:**
- Consumes: Task 2 的 slot 字面量 `"contract_old"` / `"contract_new"`（必须逐字一致）；`useChat` 已透传 `PickedFile.slot`（`useChat.ts:211`），无需改动。
- Produces: `InputMode` 增加 `"contract"`；`ChatPanel` 在 `agentKind === "contract"` 时启用。

- [ ] **Step 1: client.ts 扩展 AttachmentSlot**

`packages/web/src/api/client.ts` 第 93 行改为：

```ts
export type AttachmentSlot = "ppt_template" | "content" | "contract_old" | "contract_new";
```

- [ ] **Step 2: InputBox 增加 contract 模式**

`packages/web/src/components/InputBox.tsx` 按以下点位修改：

(a) 第 7–8 行，InputMode 注释与类型：

```ts
/** 输入框形态：普通对话 / 图像生成 / 视频生成 / PPT 制作 / 合同对比。 */
export type InputMode = "default" | "image" | "video" | "ppt" | "contract";
```

(b) 第 30 行 `ACCEPT_CONTENT` 之后新增合同文档类型常量：

```ts
/** contract 模式合同文件的可选类型（纯文档，不含图片/表格）。 */
const ACCEPT_CONTRACT = ".txt,.md,application/pdf,.docx";
```

(c) 第 55 行 `pptMode` 之后新增模式判定与状态（`templateFile` state 同区域）：

```ts
  const contractMode = mode === "contract";
  const [oldContractFile, setOldContractFile] = useState<File | null>(null);
  const [newContractFile, setNewContractFile] = useState<File | null>(null);
  const oldContractInputRef = useRef<HTMLInputElement>(null);
  const newContractInputRef = useRef<HTMLInputElement>(null);
```

(d) `handleSend`（第 107–123 行）改为（`hasFiles`、picked 分支、清理、依赖数组四处）：

```ts
  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    const hasFiles =
      files.length > 0 || !!templateFile || !!oldContractFile || !!newContractFile;
    if ((!trimmed && !hasFiles) || disabled) return;
    const picked: PickedFile[] = pptMode
      ? [
          ...(templateFile ? [{ file: templateFile, slot: "ppt_template" as const }] : []),
          ...files.map((f) => ({ file: f, slot: "content" as const })),
        ]
      : contractMode
        ? [
            ...(oldContractFile ? [{ file: oldContractFile, slot: "contract_old" as const }] : []),
            ...(newContractFile ? [{ file: newContractFile, slot: "contract_new" as const }] : []),
          ]
        : files.map((f) => ({ file: f }));
    onSend(trimmed, picked, mediaMode ? settingsRef.current : undefined);
    setValue("");
    setFiles([]);
    setTemplateFile(null);
    setOldContractFile(null);
    setNewContractFile(null);
    revokeAll();
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [value, files, templateFile, oldContractFile, newContractFile, disabled, onSend, revokeAll, mediaMode, pptMode, contractMode]);
```

(e) 附件 chips 区（第 151 行起）：外层条件与合同 chips。外层 `{(files.length > 0 || templateFile) && (` 改为：

```tsx
      {(files.length > 0 || templateFile || oldContractFile || newContractFile) && (
```

`templateFile` chip 之后、`files.map` 之前插入两个合同 chip：

```tsx
          {oldContractFile && (
            <div className="attachment-chip" key="__contract_old">
              <span className="attachment-slot-badge badge-old">旧版</span>
              <span className="attachment-name" title={oldContractFile.name}>{oldContractFile.name}</span>
              <button className="attachment-remove" onClick={() => setOldContractFile(null)} title="移除" type="button">✕</button>
            </div>
          )}
          {newContractFile && (
            <div className="attachment-chip" key="__contract_new">
              <span className="attachment-slot-badge badge-new">新版</span>
              <span className="attachment-name" title={newContractFile.name}>{newContractFile.name}</span>
              <button className="attachment-remove" onClick={() => setNewContractFile(null)} title="移除" type="button">✕</button>
            </div>
          )}
```

(f) 隐藏 file input 区（第 208–218 行 `templateInputRef` 之后）新增两个：

```tsx
        <input
          ref={oldContractInputRef}
          type="file"
          accept={ACCEPT_CONTRACT}
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setOldContractFile(f); // 重复选择 = 替换
            e.target.value = "";
          }}
        />
        <input
          ref={newContractInputRef}
          type="file"
          accept={ACCEPT_CONTRACT}
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setNewContractFile(f); // 重复选择 = 替换
            e.target.value = "";
          }}
        />
```

(g) `input-toolbar-left`（第 219–264 行）pptMode 块之后新增 contractMode 双按钮（图标沿用文档轮廓 SVG，样式类同 `btn-reference`）：

```tsx
          {contractMode && (
            <>
              <button
                type="button"
                className="btn-reference"
                onClick={() => oldContractInputRef.current?.click()}
                disabled={disabled}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                  <path d="M9 15h6M9 11h6" />
                </svg>
                旧版合同
              </button>
              <button
                type="button"
                className="btn-reference"
                onClick={() => newContractInputRef.current?.click()}
                disabled={disabled}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                  <path d="M12 11v6M9 14h6" />
                </svg>
                新版合同
              </button>
            </>
          )}
```

(h) 右下角通用上传按钮条件（第 266 行）排除 contract 模式：

```tsx
          {!mediaMode && !pptMode && !contractMode && (
```

(i) 发送按钮 disabled 条件（第 318 行）改为：

```tsx
              disabled={!value.trim() && files.length === 0 && !templateFile && !oldContractFile && !newContractFile}
```

- [ ] **Step 3: ChatPanel 映射 contract 模式**

`packages/web/src/components/ChatPanel.tsx` 第 77–84 行 mode 三元链加一层：

```ts
  const mode: InputMode =
    agentKind === "image"
      ? "image"
      : agentKind === "video"
        ? "video"
        : agentKind === "ppt"
          ? "ppt"
          : agentKind === "contract"
            ? "contract"
            : "default";
```

第 102–108 行 placeholder 加 contract 分支：

```tsx
        placeholder={
          mode === "ppt"
            ? "描述要制作的 PPT，可上传模版与内容文件"
            : mode === "contract"
              ? "上传旧版与新版合同，我来找出条款与主体差异"
              : mode !== "default"
                ? "请输入内容"
                : undefined
        }
```

（`modelList` 逻辑不动——contract 非 image/video，自然落入 llm 组。）

- [ ] **Step 4: App.css 新增角标样式**

`packages/web/src/App.css` 第 1068 行 `.badge-content` 规则之后追加（只用现有 token）：

```css
.badge-old {
  color: var(--tag-general-fg);
  background: var(--tag-general-bg);
}
.badge-new {
  color: var(--tag-copy-fg);
  background: var(--tag-copy-bg);
}
```

- [ ] **Step 5: 构建验证**

Run: `npm run build -w @lot-agent/web`
Expected: tsc 无类型错误，vite build 成功。

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/api/client.ts packages/web/src/components/InputBox.tsx packages/web/src/components/ChatPanel.tsx packages/web/src/App.css
git commit -m "feat(web): 合同对比输入模式——旧版/新版双合同上传入口"
```

---

### Task 4: 全量验证

**Files:** 无新改动；全仓验证。

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全部 PASS（core、server 既有 + 新增用例）。

- [ ] **Step 2: 全量构建**

Run: `npm run build`
Expected: core（tsup）、server（tsup）、web（vite）全部成功。

- [ ] **Step 3: 如有失败**

修复后重跑；全绿即完成（本任务无 commit，除非有修复）。
