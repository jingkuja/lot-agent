/** Browser fixtures only: never authenticates to Feishu or sends a real message. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm, realpath, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { createServer } = createRequire(resolve(root,"packages/web/package.json"))("vite");
const temp = await realpath(await mkdtemp(join(tmpdir(),"lot-feishu-ui-")));
let vite, browser;
try {
  await writeFile(join(temp,"index.html"),'<div id="root"></div><script type="module" src="/main.tsx"></script>');
  await writeFile(join(temp,"main.tsx"),`import React from 'react'; import {createRoot} from 'react-dom/client';
    import {Workspace} from ${JSON.stringify(resolve(root,"packages/web/src/pages/Workspace.tsx"))};
    import {setToken} from ${JSON.stringify(resolve(root,"packages/web/src/api/client.ts"))};
    import {LanguageProvider} from ${JSON.stringify(resolve(root,"packages/web/src/i18n/index.tsx"))};
    import ${JSON.stringify(resolve(root,"packages/web/src/App.css"))};
    setToken('feishu-ui-fixture');
    createRoot(document.getElementById('root')).render(<LanguageProvider><Workspace user={{id:'fixture',name:'Test',username:'test@example.org',phone:null,apiKeys:[],activeKeyIndex:0}} modelCatalog={{llm:[{id:'test',type:'llm',provider:'test'}],image:[],video:[]}} onLogout={()=>{}} /></LanguageProvider>);`);
  vite = await createServer({ configFile:false,root:temp,esbuild:{ jsx:"automatic" },resolve:{ alias:{ react:resolve(root,"packages/web/node_modules/react"),"react-dom":resolve(root,"packages/web/node_modules/react-dom") } },server:{ host:"127.0.0.1",port:0,fs:{ allow:[root,temp] } } });
  await vite.listen();
  browser = await chromium.launch({ headless:true,channel:"chrome" });
  for (const [locale,theme] of [["zh","light"],["en","dark"]]) {
    const context = await browser.newContext({ viewport:{ width:1100,height:1000 } });
    await context.addInitScript(({ locale,theme }) => {
      localStorage.setItem("lot:language",locale);
      document.addEventListener("DOMContentLoaded",() => document.documentElement.setAttribute("data-theme",theme));
    },{ locale,theme });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [], sends = [];
    const conversations=[{id:"pin",title:"飞书",channel:"feishu",agent_id:"general",created_at:"2026-01-01",updated_at:"2026-01-01"},{id:"recent",title:"Recent conversation",agent_id:"general",created_at:"2026-10-13",updated_at:"2026-10-13"}];
    const transcript=[{id:"input",role:"user",content:"飞书任务一"},{id:"result",role:"assistant",content:"完整结果一",metadata:{feishuStatus:"completed"}}];
    let statusResponse = "missing";
    page.on("pageerror",e => errors.push(e.message));
    const state = { configured:true,connected:true,canSendAsUser:true,messageConnection:"connected",account:{ name:"测试账号",openId:"ou_owner" },contacts:[],recent:[] };
    let pauseAuthorization = true;
    await page.route("**/api/**",async route => {
      const req=route.request(), path=new URL(req.url()).pathname;
      if (!path.startsWith("/api/")) return route.continue();
      let value={}; let status=200;
      if (path==="/api/public/product") value={ globle:1 };
      if (path==="/api/agents") value=[{id:"general",name:"通用助手",type:"general",installed:true,toolNames:[],defaultModelId:"test"}];
      if (path==="/api/conversations/projects" || path==="/api/knowledge-bases") value=[];
      if (path==="/api/conversations") value={items:conversations,nextCursor:null};
      if (path==="/api/conversations/pin") value={...conversations[0],messages:transcript};
      if (path==="/api/conversations/recent") value={...conversations[1],messages:[]};
      if (path==="/api/usage/balance") value={balance:100,totalUsed:0,totalRecharged:100,usedRatio:0};
      if (path==="/api/feishu/status") {
        if (statusResponse==="missing") return route.fulfill({ status:404,contentType:"text/plain",body:"404 Not Found" });
        if (statusResponse==="unavailable") return route.fulfill({ status:503,contentType:"text/plain",body:"Service Unavailable" });
        if (statusResponse==="network") return route.abort("failed");
        value=statusResponse==="unconfigured" ? { ...state,configured:false,connected:false } : state;
      }
      if (path==="/api/feishu/connection" && req.method()==="DELETE") { state.connected=false; state.setup=null; }
      if (path==="/api/feishu/authorize") {
        state.setup={id:"setup-fixture",phase:"registration",url:"https://open.feishu.cn/robot?user_code=fixture",expiresAt:Date.now()+600000,pollAfter:Date.now()+1000};
        value=state.setup;
      }
      if (path==="/api/feishu/setup/setup-fixture/poll") {
        state.setup=state.setup.phase==="registration"
          ? {...state.setup,phase:"authorization",url:"https://accounts.feishu.cn/authorize?user_code=fixture",pollAfter:Date.now()+2000}
          : pauseAuthorization ? {...state.setup,pollAfter:Date.now()+1000} : {...state.setup,phase:"verification",url:undefined};
        value=state.setup;
      }
      if (path==="/api/feishu/setup/setup-fixture/confirm") {
        if (req.postDataJSON().code!=="123456") return route.fulfill({status:400,contentType:"application/json",body:JSON.stringify({error:"绑定验证码无效或已过期，请检查飞书私聊后重试"})});
        state.setup={...state.setup,phase:"complete"}; state.connected=true; state.messageConnection="connecting"; value={ok:true};
      }
      if (path==="/api/feishu/contacts" && req.method()==="POST") {
        const data=req.postDataJSON(); state.contacts.push({ alias:data.alias,open_id:data.openId });
      }
      if (path==="/api/feishu/messages") {
        sends.push(req.postDataJSON());
        if (sends.length===1) { status=400; value={ error:"发送结果暂时无法确认，请先在飞书核实，勿重复发送" }; }
        else value={ messageId:"om_fixture" };
      }
      await route.fulfill({ status,contentType:"application/json",body:JSON.stringify(value) });
    });
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
    await page.locator(".account-chip").click();
    await page.getByRole("menuitem",{ name:locale==="zh" ? "飞书接入" : "Feishu connection" }).click();
    const dialog=page.getByRole("dialog");
    const refresh=dialog.getByRole("button",{ name:locale==="zh" ? "刷新连接状态" : "Refresh connection status",exact:true });
    const loading=dialog.getByText(locale==="zh" ? "加载中…" : "Loading…",{ exact:true });
    await dialog.getByRole("alert").filter({ hasText:locale==="zh" ? "当前服务器尚未提供飞书接入" : "This server does not provide Feishu integration yet" }).waitFor();
    assert.equal(await loading.count(),0,"404 must stop loading");
    assert.ok(await refresh.isEnabled(),"404 must provide a retry action");
    if (process.env.FEISHU_SCREENSHOTS_DIR) {
      await mkdir(process.env.FEISHU_SCREENSHOTS_DIR,{ recursive:true });
      await page.screenshot({ path:join(process.env.FEISHU_SCREENSHOTS_DIR,`feishu-unavailable-${locale}-${theme}.png`) });
    }
    for (statusResponse of ["unavailable","network"]) {
      await refresh.click();
      await dialog.getByRole("alert").filter({ hasText:locale==="zh" ? "无法读取飞书连接状态" : "Unable to load the Feishu connection status" }).waitFor();
      assert.equal(await loading.count(),0,"failed request must stop loading");
      assert.ok(await refresh.isEnabled());
    }
    statusResponse="unconfigured";
    await refresh.click();
    await dialog.getByText(locale==="zh" ? "服务端尚未配置飞书接入" : "Feishu is not configured on the server yet.",{ exact:true }).waitFor();
    assert.equal(await dialog.getByRole("alert").count(),0);
    assert.ok(await refresh.isEnabled(),"unconfigured server must allow refresh after configuration");
    statusResponse="connected";
    await refresh.click();
    await dialog.getByText("测试账号",{ exact:false }).waitFor();
    await page.locator("#feishu-alias").fill("张三");
    await page.locator("#feishu-open-id").fill("ou_alice");
    await dialog.getByRole("button",{ name:locale==="zh" ? "保存联系人" : "Save contact",exact:true }).click();
    await page.locator(".feishu-contacts").getByText("张三",{ exact:false }).waitFor();
    await page.locator("#feishu-recipient").fill("张三");
    await page.locator("#feishu-text").fill("Exact text\n消息原文");
    const send=dialog.getByRole("button",{ name:locale==="zh" ? "以本人身份发送" : "Send as myself",exact:true });
    await send.click(); await dialog.getByRole("alert").waitFor();
    assert.equal(sends.length,1); assert.equal(sends[0].text,"Exact text\n消息原文");
    assert.equal(sends[0].recipient,"张三"); assert.equal(sends[0].reply,false);
    await send.click();
    await dialog.getByRole("status").getByText("om_fixture",{ exact:false }).waitFor();
    assert.equal(sends[0].requestId,sends[1].requestId,"retry must retain idempotency key");
    assert.equal(await page.locator("#feishu-text").inputValue(),"");
    assert.ok(await send.isDisabled());
    const css=await dialog.evaluate(el => ({ color:getComputedStyle(el).color,background:getComputedStyle(el).backgroundColor }));
    assert.notEqual(css.color,css.background);
    assert.ok((await dialog.boundingBox()).width<1100);
    await dialog.getByRole("button",{ name:locale==="zh" ? "断开连接" : "Disconnect",exact:true }).click();
    await dialog.getByRole("button",{ name:locale==="zh" ? "连接飞书" : "Connect Feishu",exact:true }).click();
    const authorize=dialog.getByRole("link",{ name:locale==="zh" ? "打开飞书官方页面" : "Open the official Feishu page" });
    await authorize.waitFor(); assert.match(await authorize.getAttribute("href"),/^https:\/\/(open|accounts)\.feishu\.cn/);
    await dialog.locator(".feishu-qr").waitFor();
    assert.match(await dialog.locator(".feishu-qr").getAttribute("src"),/^data:image\/png/);
    if (process.env.FEISHU_SCREENSHOTS_DIR) {
      await mkdir(process.env.FEISHU_SCREENSHOTS_DIR,{ recursive:true });
      await page.screenshot({ path:join(process.env.FEISHU_SCREENSHOTS_DIR,`feishu-${locale}-${theme}.png`) });
    }
    await dialog.getByText(locale==="zh" ? "2. 扫码授权飞书账号" : "2. Scan to authorize your Feishu account",{exact:true}).waitFor();
    assert.equal(await dialog.locator(".feishu-hint").filter({hasText:locale==="zh" ? "飞书消息通道" : "Feishu message connection"}).count(),0,"do not show a disabled message channel before binding");
    await dialog.getByRole("button",{name:locale==="zh" ? "关闭" : "Close",exact:true}).click();
    await page.locator(".account-chip").click();
    await page.getByRole("menuitem",{name:locale==="zh" ? "飞书接入" : "Feishu connection"}).click();
    await dialog.getByText(locale==="zh" ? "2. 扫码授权飞书账号" : "2. Scan to authorize your Feishu account",{exact:true}).waitFor();
    pauseAuthorization=false;
    await page.locator("#feishu-code").waitFor();
    await page.locator("#feishu-code").fill("000000");
    await dialog.getByRole("button",{name:locale==="zh" ? "确认绑定" : "Confirm",exact:true}).click();
    await dialog.getByRole("alert").waitFor();
    assert.equal(state.connected,false,"wrong code must not activate the binding");
    await page.locator("#feishu-code").fill("123456");
    await dialog.getByRole("button",{name:locale==="zh" ? "确认绑定" : "Confirm",exact:true}).click();
    await dialog.getByRole("status").filter({hasText:locale==="zh" ? "飞书已连接" : "Feishu is connected"}).waitFor();
    const channelStatus=dialog.locator(".feishu-hint").filter({hasText:locale==="zh" ? "飞书消息通道" : "Feishu message connection"});
    await channelStatus.filter({hasText:locale==="zh" ? "连接中" : "Connecting"}).waitFor();
    state.messageConnection="connected";
    await channelStatus.filter({hasText:locale==="zh" ? "已连接" : "Connected"}).waitFor();
    await dialog.getByRole("button",{name:locale==="zh" ? "关闭" : "Close",exact:true}).click();
    const pin=page.locator(".sidebar-list section").filter({has:page.locator(".sidebar-channel-pin")});
    assert.equal(await pin.count(),1);
    assert.equal(await pin.locator(".sidebar-project-move,.btn-delete").count(),0);
    assert.equal(await page.locator(".sidebar-list .sidebar-conversation-link").first().textContent(),"飞书");
    await pin.getByRole("button",{name:"飞书",exact:true}).click();
    await page.getByText("完整结果一",{exact:true}).waitFor();
    assert.equal(await page.locator("textarea").count(),0,"channel view must preserve its transcript");
    transcript.push({id:"input2",role:"user",content:"飞书任务二"},{id:"result2",role:"assistant",content:"失败结果二",metadata:{feishuStatus:"failed"}});
    await page.getByText("失败结果二",{exact:true}).waitFor();
    assert.equal(await page.locator(".sidebar-channel-pin").count(),1);
    if (process.env.FEISHU_SCREENSHOTS_DIR) await page.screenshot({path:join(process.env.FEISHU_SCREENSHOTS_DIR,`feishu-transcript-${locale}-${theme}.png`)});
    assert.deepEqual(errors,[]); await context.close();
  }
  console.log("Feishu UI passed: Chinese light / English dark, 404 / 503 / network failure recovery, unconfigured refresh, contacts, exact sends, stable retry ID, official QR creation, automatic authorization polling, private code confirmation, single pinned transcript and live task refresh.");
} finally { await browser?.close(); await vite?.close(); await rm(temp,{ recursive:true,force:true }); }
