// 状态便签的接线测试:起真 server.js(假 claude),走真 HTTP。
// 盯三件事:鉴权与状态码、/debug 不泄露内容、look 端点从回环可用。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");
const pause = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function startShim(extra = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shim-status-"));
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const p = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: temp,
    env: { ...process.env, HOME: temp, PORT: String(port), SHIM_KEY: "test",
      CLAUDE_BIN: path.join(root, "dev/fake-session-claude.mjs"),
      STATUS_WRITE_TOKEN: "note-key", STATUS_FILE: path.join(temp, "status/now.json"),
      TG_BOT_TOKEN: "", BARK_KEY: "", TIME_STAMP: "0", COMPACT_HOOK: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = ""; p.stdout.on("data", (d) => { logs += d; }); p.stderr.on("data", (d) => { logs += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch {}
    if (p.exitCode !== null) throw new Error(logs);
    await pause();
  }
  return { base, p, getLogs: () => logs, temp,
    async stop() { if (p.exitCode !== null) return; const c = new Promise((r) => p.once("exit", r)); p.kill(); await c; } };
}

test("POST /status:鉴权、201、覆盖写、错误形状 400、日志不含正文", async () => {
  const s = await startShim();
  try {
    const noAuth = await fetch(s.base + "/status", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
    assert.equal(noAuth.status, 401);

    const ok = await fetch(s.base + "/status", { method: "POST",
      headers: { authorization: "Bearer note-key", "content-type": "application/json" },
      body: JSON.stringify({ text: "今天有点忙,晚些回复" }) });
    assert.equal(ok.status, 201);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.ok(body.writtenAt && body.timeZone);

    // iOS 包裹形状:单元素数组也能写
    const wrapped = await fetch(s.base + "/status", { method: "POST",
      headers: { authorization: "Bearer note-key", "content-type": "application/json" },
      body: JSON.stringify([{ text: "改成第二条了" }]) });
    assert.equal(wrapped.status, 201);
    const rec = JSON.parse(fs.readFileSync(path.join(s.temp, "status/now.json"), "utf8"));
    assert.equal(rec.text, "改成第二条了", "新写入覆盖旧内容");

    const bad = await fetch(s.base + "/status", { method: "POST",
      headers: { authorization: "Bearer note-key", "content-type": "application/json" },
      body: JSON.stringify({ bogus: 1 }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /文字/);

    assert.ok(!s.getLogs().includes("今天有点忙"), "日志不回显正文");
    assert.ok(!s.getLogs().includes("改成第二条"), "日志不回显正文");

    // /debug 只报开关
    const dbg = await (await fetch(s.base + "/debug")).json();
    assert.deepEqual(dbg.status, { on: true });
    assert.ok(!JSON.stringify(dbg).includes("改成第二条"));
  } finally { await s.stop(); fs.rmSync(s.temp, { recursive: true, force: true }); }
});

test("look MCP 端点:回环可调、内容可读、GET 405", async () => {
  const s = await startShim();
  try {
    await fetch(s.base + "/status", { method: "POST",
      headers: { authorization: "Bearer note-key", "content-type": "application/json" },
      body: JSON.stringify({ text: "去遛小汉堡了" }) });
    const rpc = async (msg) => (await fetch(s.base + "/mcp/look", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(msg) })).json();
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    assert.equal(init.result.serverInfo.name, "look");
    const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(list.result.tools[0].name, "look");
    const call = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "look", arguments: {} } });
    assert.match(call.result.content[0].text, /去遛小汉堡了/);
    assert.equal((await fetch(s.base + "/mcp/look")).status, 405);
  } finally { await s.stop(); fs.rmSync(s.temp, { recursive: true, force: true }); }
});

test("不设 STATUS_WRITE_TOKEN:写入口 503,look 端点不存在", async () => {
  const s = await startShim({});
  // startShim 总是带 token;这里单独起一个不带的
  await s.stop(); fs.rmSync(s.temp, { recursive: true, force: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shim-status-off-"));
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const p = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: temp,
    env: { ...process.env, HOME: temp, PORT: String(port), SHIM_KEY: "test",
      CLAUDE_BIN: path.join(root, "dev/fake-session-claude.mjs"), STATUS_WRITE_TOKEN: "",
      TG_BOT_TOKEN: "", BARK_KEY: "", TIME_STAMP: "0", COMPACT_HOOK: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + "/health")).ok) break; } catch {}
      await pause();
    }
    assert.equal((await fetch(base + "/status", { method: "POST",
      headers: { "content-type": "application/json" }, body: "{}" })).status, 503);
    assert.equal((await fetch(base + "/mcp/look", { method: "POST",
      headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
    const dbg = await (await fetch(base + "/debug")).json();
    assert.deepEqual(dbg.status, { on: false });
  } finally {
    if (p.exitCode === null) { const c = new Promise((r) => p.once("exit", r)); p.kill(); await c; }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
