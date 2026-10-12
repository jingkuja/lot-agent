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
    createRoot(document.getElementById('root')).render(<LanguageProvider><main style={{maxWidth:1000,margin:'40px auto'}}><ChatPanel messages={[]} onSend={()=>{}} onStop={()=>{}} isStreaming={false} activeConversationId={null} agent={{id:'general',name:'通用助手',type:'general'}} /></main></LanguageProvider>);`);
  vite = await createServer({ configFile: false, root: temp, esbuild: { jsx: "automatic" }, resolve: { alias: { react: resolve(root, "packages/web/node_modules/react"), "react-dom": resolve(root, "packages/web/node_modules/react-dom"), "react-markdown": resolve(root, "packages/web/node_modules/react-markdown"), "remark-gfm": resolve(root, "packages/web/node_modules/remark-gfm") } }, server: { host: "127.0.0.1", port: 0, fs: { allow: [root, temp] } } });
  await vite.listen();
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  for (const [desktop, locale, theme] of [[true, "zh", "light"], [true, "en", "dark"], [false, "en", "light"]]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(({ desktop, locale, theme }) => {
      localStorage.setItem("lot:language", locale);
      document.addEventListener("DOMContentLoaded", () => document.documentElement.setAttribute("data-theme", theme));
      if (!desktop) return;
      let state = { directory: null, bashAvailable: true, activeRuns: 0 };
      window.lotDesktop = {
        platform: "darwin", appVersion: "fixture", getToken: () => null,
        getLocalWorkspace: async () => state,
        chooseLocalWorkspace: async () => (state = { ...state, directory: "/Users/demo/Projects/local-workspace" }),
        disableLocalWorkspace: async () => (state = { ...state, directory: null }),
      };
    }, { desktop, locale, theme });
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
      await page.getByRole("button", { name: locale === "zh" ? "选择目录" : "Choose folder", exact: true }).click();
      await page.getByText("/Users/demo/Projects/local-workspace", { exact: true }).waitFor();
      const panel = page.locator(".desktop-workspace");
      assert.equal(await panel.count(), 1);
      const box = await panel.boundingBox();
      assert.ok(box.width > 300 && box.width <= 1280);
      const css = await panel.evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
      assert.notEqual(css.color, css.background);
      if (process.env.DESKTOP_SCREENSHOTS_DIR) await page.screenshot({ path: join(process.env.DESKTOP_SCREENSHOTS_DIR, `desktop-${locale}-${theme}.png`) });
      await page.getByRole("button", { name: locale === "zh" ? "停用本地工具" : "Disable local tools", exact: true }).click();
      await page.getByText(locale === "zh" ? "未启用本地工具" : "Local tools disabled", { exact: true }).waitFor();
    } else {
      await page.locator(".input-branding").waitFor();
      assert.equal(await page.locator(".desktop-workspace").count(), 0);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("PASS desktop Chinese/light, English/dark, choose/disable directory, browser tool isolation");
} finally {
  await browser?.close();
  await vite?.close();
  await rm(temp, { recursive: true, force: true });
}
