// 压缩闸门 · 接线测试(真的把 server.js 跑起来,用假的 claude 子进程演对话)
//
// 纯逻辑测试证明不了这套东西能用 —— 真正会出事的是接线:
// dirty 有没有被置位、成功归档有没有清账、闸门端点读的是不是同一份状态、
// 拦截预算会不会漏清零。这里一条一条打过去。
//
// 用户要的一句话:「压缩摘要前最后一刻他会强制归档,别丢归档之后到压缩前的记忆」。
// 下面第一个测试就是这句话本身。

import { test, before, after } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(dir, "..", "server.js");
const FAKE = path.join(dir, "..", "dev", "fake-claude.mjs");
const KEY = "test-key";
let proc, base;

const j = async (p, opt = {}) => {
  const r = await fetch(base + p, { headers: { "x-api-key": KEY, "content-type": "application/json" }, ...opt });
  return r.json();
};
const say = (text) => j("/messages", { method: "POST", body: JSON.stringify({ stream: false, messages: [{ role: "user", content: text }] }) });
const gate = () => j("/precompact-gate", { method: "POST", body: "{}" });
const dbg = () => j("/debug");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  const port = 18787 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  proc = spawn("node", [SERVER], {
    env: {
      ...process.env,
      PORT: String(port), SHIM_KEY: KEY,
      CLAUDE_BIN: FAKE,   // 假 claude 自己带 shebang,忽略传进来的那堆参数
      TG_BOT_TOKEN: "", BARK_KEY: "", ELEVENLABS_API_KEY: "", EARS_URL: "",
      TIME_STAMP: "0", WINDOW_LIMIT: "100000", COMPACT_HOOK: "0",
      // 预算是全局的,测试之间会互相消耗 —— 调大,让预算那条测试自己去打上限
      COMPACT_GATE_MAX_BLOCKS: "9",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + "/health"); if (r.ok) return; } catch {}
    await wait(100);
  }
  throw new Error("shim 没起来");
});

after(() => { try { proc.kill(); } catch {} });

test("开机状态:没聊过 = 没有未归档内容 = 压缩放行", async () => {
  const d = await dbg();
  assert.equal(d.gate.dirty, false);
  const g = await gate();
  assert.equal(g.block, false);
  assert.equal(g.why, "clean");
});

test("【核心】聊过之后压缩必须被拦下 —— 这就是「归档之后到压缩前的记忆」那道缺口", async () => {
  await say("今天好累");
  assert.equal((await dbg()).gate.dirty, true, "聊过就该是 dirty");

  const g = await gate();
  assert.equal(g.block, true, "有没归档的内容,压缩必须拦下");
  assert.ok(g.reason.includes("archive_session"), "理由里要请他归档");
  assert.ok(g.reason.includes("不是她打的字"), "诚实署名系统,不假冒她");
});

test("他归档成功之后,压缩放行(不会卡在归档循环里)", async () => {
  await say("请调用 archive_session 存一下");   // 假 claude 会演成功归档(返回带 🗄️)
  const d = await dbg();
  assert.equal(d.gate.dirty, false, "成功归档要清账");
  assert.ok(d.gate.lastArchiveAt, "要记下归档时刻");
  assert.equal(d.gate.bufferedChars, 0, "原文缓冲要清空");
  assert.equal((await gate()).block, false, "干净了就放行");
});

test("归档失败(工具报错)不算数 —— 压缩照拦", async () => {
  await say("ARCHIVE_FAIL 试着存一下");
  const d = await dbg();
  assert.equal(d.gate.dirty, true, "没写进 OB 就不能算归档过");
  assert.equal((await gate()).block, true);
});

test("【后手】闸门拦下之后,shim 自己排的那一轮归档真的把内容写进了 OB", async () => {
  await say("刚刚又聊了几句");                        // 先制造未归档内容
  assert.equal((await dbg()).gate.dirty, true, "聊过就该是 dirty");
  // 拦一次 → shim 会 enqueue 一轮请他归档(假 claude 演成功)
  const g = await gate();
  assert.equal(g.block, true, "有未归档内容就该拦");
  await wait(300);                                  // 等那轮归档跑完
  assert.equal((await dbg()).gate.dirty, false, "后手归档要能真正清账");
  assert.equal((await gate()).block, false, "清账之后就该放行,压缩得以继续");
});

test("【底线】拦截预算用完就放行,绝不把满窗口卡死", async () => {
  await say("又聊了两句");                           // 重新变脏
  const max = (await dbg()).gate.maxBlocks;
  let g = { block: true }, guard = 0;
  // 每次拦下都会顺带排一轮归档,这里用 ARCHIVE_FAIL 之外的普通话题反复变脏,
  // 只关心一件事:拦截次数用完之后必须放行。
  while (g.block && guard++ < max + 5) { g = await gate(); await say("ARCHIVE_FAIL 还在聊"); }
  assert.equal(g.block, false, "拦到上限必须放行");
  assert.equal(g.why, "budget");
  assert.ok((await dbg()).gate.blocks >= max, "拦截次数要如实记账");
});

test("【最后一层】压缩溜过去了 → 原文回放,他照原文补档,记忆仍然没丢", async () => {
  await say("ARCHIVE_FAIL 压缩前最后一句悄悄话");     // 确保此刻仍有未归档内容
  assert.equal((await dbg()).gate.dirty, true, "前提:此刻仍有未归档内容");
  await say("COMPACT_NOW 继续聊");                   // 假 claude 先发 compact_boundary 再回话
  await wait(400);                                   // 回放轮是 enqueue 的,等它跑完
  const d = await dbg();
  assert.equal(d.window.compactions, 1, "压缩要被记到");
  assert.equal(d.gate.blocks, 0, "压缩发生后拦截预算重新开始");
  assert.equal(d.gate.dirty, false, "回放补档要能把那段救回 OB —— 这是最后一层保底");
});

test("鉴权:没有 key 不能问闸门(但回的也是放行,不是报错)", async () => {
  const r = await fetch(base + "/precompact-gate", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).block, false, "鉴权失败也必须是放行,不能卡住压缩");
});

test("OB 新版归档(hold,无🗄️标记)同样清账:dirty 落回 false", async () => {
  await say("随便聊一句弄脏闸门");
  let d = await dbg();
  assert.equal(d.gate.dirty, true);
  await say("请 HOLD_OK 存一下");
  d = await dbg();
  assert.equal(d.gate.dirty, false, "hold 的非报错返回应被认作归档成功");
  assert.ok(d.gate.lastArchiveAt, "lastArchiveAt 已记录");
});
