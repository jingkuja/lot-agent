/** UI fixtures only: no model calls or real local filesystem bridge. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { createServer } = createRequire(resolve(root, "packages/web/package.json"))("vite");
const temp = await realpath(await mkdtemp(join(tmpdir(), "lot-desktop-ui-")));
let vite, browser;
try {
  await writeFile(join(temp, "index.html"), '<div id="root"></div><script type="module" src="/main.tsx"></script>');
  await writeFile(join(temp, "main.tsx"), `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ChatPanel} from ${JSON.stringify(resolve(root, "packages/web/src/components/ChatPanel.tsx"))};
    import {LanguageProvider} from ${JSON.stringify(resolve(root, "packages/web/src/i18n/index.tsx"))};
    import ${JSON.stringify(resolve(root, "packages/web/src/App.css"))};
    function Fixture() { const [empty, setEmpty] = React.useState(false); window.setEmptyChat = setEmpty; return <LanguageProvider><main style={{maxWidth:1000,margin:'40px auto'}}><ChatPanel messages={empty ? [] : [{id:'user-1',role:'user',content:'请帮我整理工作目录。'}]} onSend={()=>{}} onStop={()=>{}} isStreaming={false} activeConversationId={'chat'} agent={{id:'general',name:'通用助手',type:'general'}} /></main></LanguageProvider>; } createRoot(document.getElementById('root')).render(<Fixture />);`);
  vite = await createServer({ configFile: false, root: temp, esbuild: { jsx: "automatic" }, resolve: { alias: { react: resolve(root, "packages/web/node_modules/react"), "react-dom": resolve(root, "packages/web/node_modules/react-dom"), "react-markdown": resolve(root, "packages/web/node_modules/react-markdown"), "remark-gfm": resolve(root, "packages/web/node_modules/remark-gfm") } }, server: { host: "127.0.0.1", port: 0, fs: { allow: [root, temp] } } });
  await vite.listen();
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  for (const [desktop, locale, theme, platform] of [[true, "zh", "light", "darwin"], [true, "en", "dark", "darwin"], [true, "zh", "dark", "win32"], [true, "en", "light", "win32"], [false, "en", "light", null]]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(({ desktop, locale, theme, platform }) => {
      localStorage.setItem("lot:language", locale);
      document.addEventListener("DOMContentLoaded", () => document.documentElement.setAttribute("data-theme", theme));
      if (!desktop) return;
      const shell = platform === "win32" ? "powershell" : "bash";
      let state = { directory: null, shell, activeRuns: 0, permissionMode: "always", approvals: [] };
      window.queueApproval = (kind = "shell") => { state = { ...state, approvals: [{ id: "approval-1", conversationId: "chat", name: kind === "delete" ? "desktop_delete_file" : `desktop_${shell}`, detail: kind === "delete" ? "fixture.txt\nPermanently delete file" : `${shell}\nworkspace\n${shell === "powershell" ? "Get-ChildItem" : "ls -la"}` }] }; };
      window.setShellUnavailable = () => { state = { ...state, shell: null }; };
      window.approvalDecisions = [];
      window.chooseCount = 0;
      window.setLocalRuns = activeRuns => { state = { ...state, activeRuns }; };
      window.lotDesktop = {
        platform, appVersion: "fixture", getToken: () => null,
        getLocalWorkspace: async () => state,
        setLocalPermission: async (_id, permissionMode) => { state = { ...state, permissionMode }; },
        respondLocalApproval: async (id, approvalId, decision) => { window.approvalDecisions.push({ id, approvalId, decision }); state = { ...state, approvals: [] }; },
        chooseLocalWorkspace: async () => { window.chooseCount++; return (state = { ...state, directory: "/Users/demo/Projects/local-workspace" + (window.chooseCount > 1 ? "/new-workspace" : "") }); },
        disableLocalWorkspace: async () => (state = { ...state, directory: null }),
      };
    }, { desktop, locale, theme, platform });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("console", msg => { if (msg.type() === "error") console.error(msg.text()); });
    page.on("requestfailed", req => console.error(req.url(), req.failure()));
    const errors = [];
    page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
    await page.route("**/api/**", route => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith("/api/")) return route.continue();
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(path === "/api/public/product" ? { globle: 1 } : []) });
    });
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
    if (desktop) {
      const trigger = page.getByRole("button", { name: locale === "zh" ? "工具权限" : "Tool permissions", exact: true });
      await trigger.waitFor();
      assert.equal(await page.locator(".input-box .desktop-workspace").count(), 1);
      const bar = page.locator(".desktop-workspace-bar");
      await bar.getByText(locale === "zh" ? "未选择目录" : "No folder selected", { exact: true }).waitFor();
      const barBox = await bar.boundingBox();
      const inputBox = await page.locator(".input-box").boundingBox();
      assert.ok(barBox.y + barBox.height <= inputBox.y);
      if (process.env.DESKTOP_SCREENSHOTS_DIR) await page.screenshot({ path: join(process.env.DESKTOP_SCREENSHOTS_DIR, `workspace-empty-${locale}-${theme}.png`) });
      await bar.getByRole("button", { name: locale === "zh" ? "选择目录" : "Choose folder", exact: true }).click();
      await bar.getByText("/Users/demo/Projects/local-workspace", { exact: true }).waitFor();
      await trigger.click();
      const panel = page.locator(".desktop-permission-menu");
      await panel.getByText("/Users/demo/Projects/local-workspace", { exact: true }).waitFor();
      await panel.getByRole("button", { name: locale === "zh" ? "更换目录" : "Change folder", exact: true }).click();
      await bar.getByText("/Users/demo/Projects/local-workspace/new-workspace", { exact: true }).waitFor();
      await page.evaluate(() => window.setLocalRuns(1));
      await page.waitForFunction(() => document.querySelector(".desktop-workspace-bar button")?.disabled);
      assert.equal(await panel.getByRole("button", { name: locale === "zh" ? "更换目录" : "Change folder", exact: true }).isDisabled(), true);
      await page.evaluate(() => window.setLocalRuns(0));
      await page.waitForFunction(() => !document.querySelector(".desktop-workspace-bar button")?.disabled);
      assert.equal(await panel.count(), 1);
      const box = await panel.boundingBox();
      assert.ok(box.width > 300 && box.width <= 1280);
      const css = await panel.evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
      assert.notEqual(css.color, css.background);
      for (const label of locale === "zh" ? ["本次对话确认", "完全授权", "每次确认"] : ["Ask for this chat", "Full access", "Ask every time"]) {
        const option = page.getByRole("button", { name: new RegExp(label) });
        await option.click();
        await page.waitForFunction(label => document.querySelector(".desktop-permission-trigger")?.textContent?.includes(label), label);
        assert.equal(await option.getAttribute("aria-pressed"), "true");
      }
      await page.keyboard.press("Escape");
      assert.equal(await panel.count(), 0);
      if (process.env.DESKTOP_SCREENSHOTS_DIR) await page.screenshot({ path: join(process.env.DESKTOP_SCREENSHOTS_DIR, `workspace-selected-${locale}-${theme}.png`) });
      await page.evaluate(() => window.queueApproval());
      await page.getByRole("button", { name: locale === "zh" ? "允许一次" : "Allow once", exact: true }).waitFor();
      assert.equal(await page.locator(".chat-messages .desktop-approval").count(), 1);
      if (process.env.DESKTOP_SCREENSHOTS_DIR) await page.screenshot({ path: join(process.env.DESKTOP_SCREENSHOTS_DIR, `approval-${locale}-${theme}.png`) });
      for (const [decision, label] of [["once", locale === "zh" ? "允许一次" : "Allow once"], ["conversation", locale === "zh" ? "本次对话允许" : "Allow for this chat"], ["deny", locale === "zh" ? "拒绝执行" : "Deny"]]) {
        await page.evaluate(() => window.queueApproval());
        await page.getByRole("button", { name: label, exact: true }).click();
        await page.locator(".desktop-approval").waitFor({ state: "detached" });
        assert.deepEqual(await page.evaluate(() => window.approvalDecisions.at(-1)), { id: "chat", approvalId: "approval-1", decision });
      }
      await page.evaluate(() => window.queueApproval("delete"));
      await page.getByText(locale === "zh" ? "允许永久删除此文件？" : "Permanently delete this file?", { exact: true }).waitFor();
      await page.getByRole("button", { name: locale === "zh" ? "拒绝执行" : "Deny", exact: true }).click();
      await page.locator(".desktop-approval").waitFor({ state: "detached" });
      await trigger.click();
      assert.equal(await panel.getByText(/Git Bash/).count(), 0);
      await page.evaluate(() => window.setShellUnavailable());
      await page.getByText(locale === "zh" ? "系统命令环境不可用；本地文件工具仍可使用。" : "The system shell is unavailable. Local file tools are still available.", { exact: true }).waitFor();
      if (process.env.DESKTOP_SCREENSHOTS_DIR) await page.screenshot({ path: join(process.env.DESKTOP_SCREENSHOTS_DIR, `desktop-${locale}-${theme}.png`) });
      await page.getByRole("button", { name: locale === "zh" ? "停用本地工具" : "Disable local tools", exact: true }).click();
      await page.getByText(locale === "zh" ? "未启用本地工具" : "Local tools disabled", { exact: true }).waitFor();
      await bar.getByText(locale === "zh" ? "未选择目录" : "No folder selected", { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await page.evaluate(() => window.setEmptyChat(true));
      await page.locator(".input-area--centered").waitFor();
      assert.equal(await page.locator(".input-area--centered .desktop-workspace-bar").count(), 1);
      await page.setViewportSize({ width: 740, height: 620 });
      await trigger.click();
      const menuBox = await panel.boundingBox();
      assert.ok(menuBox.x >= 0 && menuBox.y >= 0 && menuBox.x + menuBox.width <= 740 && menuBox.y + menuBox.height <= 620);
      await page.mouse.click(10, 10);
      await panel.waitFor({ state: "detached" });
    } else {
      await page.locator(".input-branding").waitFor();
      assert.equal(await page.locator(".desktop-workspace").count(), 0);
      assert.equal(await page.locator(".desktop-workspace-bar").count(), 0);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("PASS desktop macOS/Windows, Chinese/English, light/dark, native shell and deletion approvals, persistent directory bar and menu sync, running-task lock, composer placement, permission modes, inline approval actions, choose/disable directory, browser tool isolation");
} finally {
  await browser?.close();
  await vite?.close();
  await rm(temp, { recursive: true, force: true });
}
