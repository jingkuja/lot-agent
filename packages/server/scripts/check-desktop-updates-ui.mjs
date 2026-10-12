/** Isolated UI fixtures: no update server, download or installer is invoked. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = createRequire(resolve(root, 'packages/web/package.json'))('vite');
const temp = await realpath(await mkdtemp(join(tmpdir(), 'lot-update-ui-')));
let vite, browser;
try {
  await writeFile(join(temp, 'index.html'), '<div id="root"></div><script type="module" src="/main.tsx"></script>');
  await writeFile(join(temp, 'main.tsx'), `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {DesktopUpdate} from ${JSON.stringify(resolve(root, 'packages/web/src/components/DesktopUpdate.tsx'))};
    import {InputBox} from ${JSON.stringify(resolve(root, 'packages/web/src/components/InputBox.tsx'))};
    import {LanguageProvider} from ${JSON.stringify(resolve(root, 'packages/web/src/i18n/index.tsx'))};
    import ${JSON.stringify(resolve(root, 'packages/web/src/App.css'))};
    createRoot(document.getElementById('root')).render(<LanguageProvider><main style={{margin:100}}><InputBox /><DesktopUpdate /></main></LanguageProvider>);`);
  vite = await createServer({ configFile: false, root: temp, esbuild: { jsx: 'automatic' }, resolve: { alias: { react: resolve(root, 'packages/web/node_modules/react'), 'react-dom': resolve(root, 'packages/web/node_modules/react-dom') } }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, temp] } } });
  await vite.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  for (const [desktop, locale, theme, platform] of [[true,'zh','light','darwin'],[true,'en','dark','win32'],[false,'en','light','darwin']]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(({ desktop, locale, theme, platform }) => {
      localStorage.setItem('lot:language', locale);
      document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-theme', theme));
      if (!desktop) return;
      let subscriber = () => {};
      let state = { status: 'idle', currentVersion: '0.2.0', progress: 0, manualAvailable: false };
      window.pushUpdate = next => { state = { ...state, ...next }; subscriber(state); };
      window.installCount = 0; window.manualCount = 0;
      window.lotDesktop = {
        platform, appVersion: '0.2.0', getToken: () => null,
        getUpdateState: async () => state,
        onUpdateState: cb => { subscriber = cb; return () => {}; },
        checkForUpdates: async () => { window.pushUpdate({ status:'downloading',progress:42, version:'0.2.1',manualAvailable:true }); return state; },
        installUpdate: async () => { window.installCount++; return { ...state, status:'installing' }; },
        openUpdateInstaller: async () => { window.manualCount++; return { ...state, status:'manual' }; },
      };
    }, { desktop, locale, theme, platform });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    await page.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (!pathname.startsWith('/api/')) return route.continue();
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(pathname === '/api/public/product' ? { globle: 1 } : []) });
    });
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
    if (desktop) {
      await page.locator('.desktop-update-trigger').click();
      const dialog = page.locator('.desktop-update-dialog');
      await dialog.getByRole('button', { name: locale === 'zh' ? '检查更新' : 'Check for updates', exact:true }).click();
      await page.waitForFunction(() => document.querySelector('progress')?.value === 42);
      await page.evaluate(() => window.pushUpdate({ status:'ready',progress:100,notes:'<script>alert(1)</script>\n更新说明 / Release notes' }));
      await dialog.getByRole('button', { name: locale === 'zh' ? '稍后' : 'Later', exact:true }).click();
      const textarea = page.locator('textarea').first();
      await textarea.fill('unsent draft');
      await page.locator('.desktop-update-trigger').click();
      await dialog.getByRole('button', { name: locale === 'zh' ? '重启并更新' : 'Restart and update', exact:true }).click();
      assert.equal(await page.evaluate(() => window.installCount), 0);
      await dialog.getByRole('alert').waitFor();
      if (process.env.DESKTOP_SCREENSHOTS_DIR) await page.screenshot({ path: join(process.env.DESKTOP_SCREENSHOTS_DIR, `update-${locale}-${theme}.png`) });
      assert.equal(await dialog.locator('script').count(), 0);
      const box = await dialog.boundingBox(); assert.ok(box.x > 200 && box.y > 50 && box.width <= 1280);
      const colors = await dialog.evaluate(el => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]); assert.notEqual(colors[0], colors[1]);
      await dialog.getByRole('button', { name: locale === 'zh' ? '稍后' : 'Later', exact:true }).click();
      await textarea.fill(''); await page.locator('.desktop-update-trigger').click();
      await page.evaluate(() => window.pushUpdate({ status:'error' }));
      await dialog.getByRole('button', { name: locale === 'zh' ? '下载 DMG 手动安装' : 'Download installer', exact:true }).click();
      assert.equal(await page.evaluate(() => window.manualCount), 1);
      await page.evaluate(() => window.pushUpdate({ status:'ready' }));
      await dialog.getByRole('button', { name: locale === 'zh' ? '重启并更新' : 'Restart and update', exact:true }).click();
      assert.equal(await page.evaluate(() => window.installCount), 1);
    } else {
      await page.locator('textarea').first().waitFor();
      assert.equal(await page.locator('.desktop-update-trigger').count(), 0);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Desktop update UI passed: Chinese/light, English/dark, progress, draft protection, restart, manual fallback, Web isolation.');
} finally { await browser?.close(); await vite?.close(); await rm(temp, { recursive:true, force:true }); }
