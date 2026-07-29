/**
 * Inline first-run server-setup page, served by the loopback server whenever
 * no `serverUrl` is configured (and at `/__lot/setup` for later changes).
 * Kept dependency-free: a single self-contained HTML document.
 */
export function renderSetupPage(currentUrl: string | null, error?: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Lot Agent — 服务器设置</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; margin: 0; }
  body {
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f4f5f7; color: #1c1e21;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #16181d; color: #e4e6eb; }
    .card { background: #22252c; border-color: #33373f; }
    input { background: #16181d; color: #e4e6eb; border-color: #3a3e47; }
  }
  .card {
    width: 400px; padding: 32px; border-radius: 12px;
    background: #fff; border: 1px solid #e4e6eb;
    box-shadow: 0 8px 30px rgba(0,0,0,.08);
  }
  h1 { font-size: 20px; margin-bottom: 6px; }
  p.sub { font-size: 13px; opacity: .65; margin-bottom: 20px; }
  label { display: block; font-size: 13px; margin-bottom: 6px; }
  input {
    width: 100%; padding: 10px 12px; font-size: 14px; border-radius: 8px;
    border: 1px solid #d0d3d9; outline: none; margin-bottom: 8px;
  }
  input:focus { border-color: #4f7cff; }
  button {
    width: 100%; padding: 10px; font-size: 14px; border: 0; border-radius: 8px;
    background: #4f7cff; color: #fff; cursor: pointer; margin-top: 8px;
  }
  button:disabled { opacity: .6; cursor: default; }
  .msg { font-size: 13px; min-height: 18px; margin-top: 4px; }
  .msg.err { color: #e5484d; }
  .msg.ok { color: #30a46c; }
</style>
</head>
<body>
  <form class="card" id="f">
    <h1>连接服务器</h1>
    <p class="sub">请输入 Lot Agent 服务端地址，例如 <code>http://192.168.1.10</code> 或 <code>https://agent.example.com</code></p>
    <label for="url">服务器地址</label>
    <input id="url" name="url" placeholder="http://" value="${esc(currentUrl ?? "")}" autocomplete="off" />
    <div class="msg${error ? " err" : ""}" id="msg">${error ? esc(error) : ""}</div>
    <button type="submit" id="btn">保存并连接</button>
  </form>
<script>
  const f = document.getElementById("f");
  const msg = document.getElementById("msg");
  const btn = document.getElementById("btn");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    btn.disabled = true;
    msg.className = "msg";
    msg.textContent = "正在连接…";
    try {
      const res = await fetch("/__lot/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverUrl: document.getElementById("url").value }),
      });
      const data = await res.json();
      if (data.ok) {
        msg.className = "msg ok";
        msg.textContent = "连接成功，正在进入…";
        location.href = "/";
      } else {
        msg.className = "msg err";
        msg.textContent = data.error || "连接失败";
      }
    } catch (err) {
      msg.className = "msg err";
      msg.textContent = String(err);
    } finally {
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`;
}
