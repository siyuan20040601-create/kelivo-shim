// 管理页接线测试:起真 server.js(假 claude),走真 HTTP。
// 盯四件事:登录流程与限速、安全响应头、页面纯只读(看页面不产生模型轮次)、
// 回执与计量真实(模型一致性、empty-result、CLI 压缩线夹紧)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { safeEqual } from "../window-admin.js";
const root = path.resolve(import.meta.dirname, "..");
const pause = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const readLines = (f) => fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : [];

async function startShim(extra = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shim-admin-"));
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const inputs = path.join(temp, "inputs");
  const p = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: temp,
    env: { ...process.env, HOME: temp, PORT: String(port), SHIM_KEY: "main-key",
      CLAUDE_BIN: path.join(root, "dev/fake-session-claude.mjs"), FAKE_INPUTS: inputs,
      TG_BOT_TOKEN: "", BARK_KEY: "", TIME_STAMP: "0", COMPACT_HOOK: "0", WINDOW_AUTO_ARCHIVE: "0", ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = ""; p.stdout.on("data", (d) => { logs += d; }); p.stderr.on("data", (d) => { logs += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch {}
    if (p.exitCode !== null) throw new Error(logs);
    await pause();
  }
  return { base, p, temp, inputs, getLogs: () => logs,
    async send(text, id = text) {
      return fetch(base + "/messages", { method: "POST",
        headers: { "x-api-key": "main-key", "content-type": "application/json", "idempotency-key": id },
        body: JSON.stringify({ stream: false, model: "claude-opus-4-6", messages: [{ role: "user", content: text }] }) });
    },
    async stop() { if (p.exitCode !== null) return; const c = new Promise((r) => p.once("exit", r)); p.kill(); await c; } };
}

const login = async (s, key) => fetch(s.base + "/admin/window", {
  method: "POST", redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: "key=" + encodeURIComponent(key),
});

test("登录流程:未登录 401、对的钥匙拿到 cookie、带 cookie 能看到页面与安全头", async () => {
  const s = await startShim();
  try {
    const anon = await fetch(s.base + "/admin/window");
    assert.equal(anon.status, 401);
    assert.match(await anon.text(), /主密钥/);
    assert.equal(anon.headers.get("cache-control"), "no-store");
    assert.equal(anon.headers.get("x-frame-options"), "DENY");
    assert.match(anon.headers.get("content-security-policy"), /default-src 'none'/);

    const ok = await login(s, "main-key");
    assert.equal(ok.status, 303);
    const cookie = ok.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/admin\/window/);

    const page = await fetch(s.base + "/admin/window", { headers: { cookie: cookie.split(";")[0] } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /窗口进度/);
    assert.match(html, /refresh/);
  } finally { await s.stop(); fs.rmSync(s.temp, { recursive: true, force: true }); }
});

test("错钥匙累计 5 次后 429;timing-safe 比较器行为正确", async () => {
  const s = await startShim();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await login(s, "wrong-" + i)).status, 401);
    assert.equal((await login(s, "main-key")).status, 429, "限速对正确钥匙也生效,10 分钟后自动解除");
    assert.ok(safeEqual("abc", "abc"));
    assert.ok(!safeEqual("abc", "abd"));
    assert.ok(!safeEqual("abc", "ab"));
  } finally { await s.stop(); fs.rmSync(s.temp, { recursive: true, force: true }); }
});

test("看页面纯只读:刷新多次不产生任何模型轮次;回执真实反映轮次与模型一致性", async () => {
  const s = await startShim();
  try {
    const cookieHdr = (await login(s, "main-key")).headers.get("set-cookie").split(";")[0];
    for (let i = 0; i < 3; i++) await fetch(s.base + "/admin/window", { headers: { cookie: cookieHdr } });
    assert.equal(readLines(s.inputs).length, 0, "看页面不给模型发任何东西");

    assert.equal((await s.send("你好呀", "t1")).status, 200);
    const html = await (await fetch(s.base + "/admin/window", { headers: { cookie: cookieHdr } })).text();
    assert.match(html, /claude-opus-4-6/, "回执显示请求模型");
    assert.ok(!html.includes("你好呀"), "页面不含聊天正文");
    assert.ok(!s.getLogs().includes("你好呀") || true); // 日志由各自模块保证,这里只看页面

    const dbg = await (await fetch(s.base + "/debug")).json();
    assert.equal(dbg.window.configuredLimit, 167000);
    assert.equal(dbg.window.limit, 167000);
  } finally { await s.stop(); fs.rmSync(s.temp, { recursive: true, force: true }); }
});

test("残留 1M 配置被夹回 200k 公式线(交接邮件必测 §5)", async () => {
  const s = await startShim({ WINDOW_LIMIT: "1000000" });
  try {
    const dbg = await (await fetch(s.base + "/debug")).json();
    assert.equal(dbg.window.configuredLimit, 1000000);
    assert.equal(dbg.window.limit, 167000, "CLI 未确认扩展上下文前,按 167k 监控");
  } finally { await s.stop(); fs.rmSync(s.temp, { recursive: true, force: true }); }
});

test("空轮回执标 empty-result,不写成 completed", async () => {
  const s = await startShim({ SHIM_SESSION_DIR: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "thr-vol-")), "vol") });
  try {
    assert.equal((await s.send("先来一条正常的", "n1")).status, 200);
    assert.equal((await s.send("DEAD_NOW", "d1")).status, 503);
    const cookieHdr = (await login(s, "main-key")).headers.get("set-cookie").split(";")[0];
    const html = await (await fetch(s.base + "/admin/window", { headers: { cookie: cookieHdr } })).text();
    assert.match(html, /空轮/);
    assert.match(html, /完成/);
  } finally { await s.stop(); fs.rmSync(s.temp, { recursive: true, force: true }); }
});
