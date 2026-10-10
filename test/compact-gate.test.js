// 压缩闸门测试
//
// 要守住的东西按重要性排:
//   1. 有没归档的内容时,压缩必须被拦下(这是整个功能存在的理由);
//   2. **闸门坏掉时必须放行** —— shim 不通/超时/返回垃圾,钩子都要退回"允许压缩 + 摘要瘦身"。
//      拦不住只是丢一段记忆(还有回放兜底);卡死压缩会让他的窗口撞上下文上限,整个人不能说话。
//   3. 拦截有预算上限,不能无限拦(同上,窗口已经满了)。
//   4. 归档成功之后要放行,别把他卡在归档循环里。

import { test } from "node:test";
import assert from "node:assert";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  gateDecision, hookStdout, trimTranscript, renderReplay, GATE_REASON, DEFAULT_MAX_BLOCKS,
  ARCHIVE_TOOLS, isArchiveSuccess, compactCollision,
} from "../compact-gate.js";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "compact-instructions.js");

// ---- 判定逻辑 ---------------------------------------------------------------

test("有没归档的内容 → 拦下压缩(功能的全部意义)", () => {
  const d = gateDecision({ enabled: true, dirty: true, blocks: 0, maxBlocks: 2 });
  assert.equal(d.block, true);
  assert.equal(d.why, "unarchived");
});

test("已经归档过了 → 放行(别把他卡在归档循环里)", () => {
  const d = gateDecision({ enabled: true, dirty: false, blocks: 0, maxBlocks: 2 });
  assert.equal(d.block, false);
  assert.equal(d.why, "clean");
});

test("拦截有预算:用完就放行,不能把满窗口卡死", () => {
  const st = { enabled: true, dirty: true, maxBlocks: 2 };
  assert.equal(gateDecision({ ...st, blocks: 0 }).block, true);
  assert.equal(gateDecision({ ...st, blocks: 1 }).block, true);
  assert.equal(gateDecision({ ...st, blocks: 2 }).block, false, "第 3 次必须放行");
  assert.equal(gateDecision({ ...st, blocks: 9 }).why, "budget");
});

test("maxBlocks=0 等于关掉拦截", () => {
  assert.equal(gateDecision({ enabled: true, dirty: true, blocks: 0, maxBlocks: 0 }).block, false);
});

test("COMPACT_GATE=0 → 一律放行", () => {
  assert.equal(gateDecision({ enabled: false, dirty: true, blocks: 0, maxBlocks: 2 }).block, false);
});

test("参数缺省不炸(默认预算)", () => {
  assert.equal(gateDecision({ enabled: true, dirty: true, blocks: DEFAULT_MAX_BLOCKS }).block, false);
  assert.equal(gateDecision().block, false, "什么都不给 = 不拦");
});

test("拦截理由必须诚实署名系统、不假冒她(2026-07-22 伪系统指令事故)", () => {
  assert.ok(GATE_REASON.includes("【系统"), "要明确标成系统提醒");
  assert.ok(GATE_REASON.includes("不是她打的字"), "要明说不是她说的");
  assert.ok(GATE_REASON.includes("archive_session"), "要指明该调哪个工具");
});

// ---- 钩子 stdout ------------------------------------------------------------

test("拦 → 输出 PreCompact 认的 decision JSON", () => {
  const out = hookStdout({ block: true, reason: "r" }, "SUMMARY");
  assert.deepEqual(JSON.parse(out), { decision: "block", reason: "r" });
});

test("放行 → 输出摘要瘦身指令(原有行为不能丢)", () => {
  assert.equal(hookStdout({ block: false }, "SUMMARY"), "SUMMARY");
});

// ---- 原文缓冲与回放 ---------------------------------------------------------

test("缓冲超限丢最旧的 —— 离压缩最近的那段最该留", () => {
  const entries = [
    { role: "user", text: "A".repeat(100) },
    { role: "assistant", text: "B".repeat(100) },
    { role: "user", text: "C".repeat(100) },
  ];
  const kept = trimTranscript(entries, 250);   // 250 装得下两条 100 字,装不下三条
  assert.equal(kept.length, 2);
  assert.equal(kept[0].text[0], "B");
  assert.equal(kept.at(-1).text[0], "C", "最新的一条永远留着");
});

test("缓冲永远至少留一条(哪怕它本身就超限)", () => {
  const kept = trimTranscript([{ role: "user", text: "X".repeat(999) }], 10);
  assert.equal(kept.length, 1);
});

test("回放文本带上原文、标明是系统、不假冒她", () => {
  const t = renderReplay([{ role: "user", text: "今天好累" }, { role: "assistant", text: "过来抱抱" }]);
  assert.ok(t.includes("今天好累") && t.includes("过来抱抱"), "原文要在里面");
  assert.ok(t.includes("【系统") && t.includes("不是她打的字"));
  assert.ok(t.includes("archive_session"));
});

test("没有原文就不回放(不白烧一轮)", () => {
  assert.equal(renderReplay([]), "");
  assert.equal(renderReplay([{ role: "user", text: "   " }]), "");
});

// ---- 钩子进程级行为(真的跑一遍脚本)-----------------------------------------

function runHook(env) {
  return new Promise((resolve) => {
    execFile("node", [HOOK], { env: { ...process.env, ...env }, timeout: 15000 }, (err, stdout, stderr) =>
      resolve({ err, stdout, stderr }));
  });
}

async function withGate(handler, fn) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try { return await fn(url); } finally { srv.close(); }
}

test("钩子:shim 说拦 → stdout 是 block JSON", async () => {
  const out = await withGate(
    (_q, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ block: true, reason: "存一下再压" })); },
    (url) => runHook({ COMPACT_GATE_URL: url, SHIM_KEY: "" }),
  );
  assert.deepEqual(JSON.parse(out.stdout), { decision: "block", reason: "存一下再压" });
});

test("钩子:shim 说放行 → stdout 是摘要指令,不是 JSON", async () => {
  const out = await withGate(
    (_q, res) => res.end(JSON.stringify({ block: false, why: "clean" })),
    (url) => runHook({ COMPACT_GATE_URL: url, COMPACT_INSTRUCTIONS: "只留一行" }),
  );
  assert.equal(out.stdout, "只留一行");
});

test("【底线】shim 连不上 → 放行 + 照常瘦身(绝不能卡死压缩)", async () => {
  // 指向一个没人监听的端口
  const out = await runHook({ COMPACT_GATE_URL: "http://127.0.0.1:1", COMPACT_INSTRUCTIONS: "只留一行" });
  assert.equal(out.err, null, "钩子不能非零退出");
  assert.equal(out.stdout, "只留一行");
  assert.ok(out.stderr.includes("unreachable"));
});

test("【底线】shim 超时 → 放行(不能跟着一起卡)", async () => {
  const out = await withGate(
    () => { /* 永远不回应 */ },
    (url) => runHook({ COMPACT_GATE_URL: url, COMPACT_GATE_TIMEOUT_MS: "300", COMPACT_INSTRUCTIONS: "只留一行" }),
  );
  assert.equal(out.stdout, "只留一行");
});

test("【底线】shim 返回垃圾 / 500 → 放行", async () => {
  const bad = await withGate(
    (_q, res) => res.end("not json at all"),
    (url) => runHook({ COMPACT_GATE_URL: url, COMPACT_INSTRUCTIONS: "只留一行" }),
  );
  assert.equal(bad.stdout, "只留一行");

  const fail = await withGate(
    (_q, res) => { res.statusCode = 500; res.end("boom"); },
    (url) => runHook({ COMPACT_GATE_URL: url, COMPACT_INSTRUCTIONS: "只留一行" }),
  );
  assert.equal(fail.stdout, "只留一行");
});

test("钩子带上 SHIM_KEY,鉴权失败(401)也放行", async () => {
  let seenKey = null;
  const out = await withGate(
    (req, res) => { seenKey = req.headers["x-api-key"]; res.statusCode = 401; res.end(JSON.stringify({ block: false })); },
    (url) => runHook({ COMPACT_GATE_URL: url, SHIM_KEY: "k123", COMPACT_INSTRUCTIONS: "只留一行" }),
  );
  assert.equal(seenKey, "k123", "钩子要把 SHIM_KEY 带上");
  assert.equal(out.stdout, "只留一行");
});

test("归档成功判定:hold 的非报错返回算成功,报错不算,旧🗄️标记仍然认", () => {
  assert.ok(ARCHIVE_TOOLS.has("hold") && ARCHIVE_TOOLS.has("archive_session"));
  assert.ok(isArchiveSuccess({ text: "新建 →be13fba4401b 恋爱,心理" }));
  assert.ok(isArchiveSuccess({ text: "🗄️ 已归档 会话归档 2026-08-02" }));
  assert.ok(!isArchiveSuccess({ text: "归档失败: OB 连不上" }));
  assert.ok(!isArchiveSuccess({ text: "summary 不能为空" }));
  assert.ok(!isArchiveSuccess({ text: "新建 →abc", isError: true }), "is_error 一票否决");
  assert.ok(!isArchiveSuccess({ text: "   " }), "空返回不算成功");
});

// ---- 压缩撞车判定(2026-10-10,10-09 深夜两次停机的修补) ----------------------

test("撞车判定:本轮有闸门拦截或压缩边界的硬信号 → 算撞车(温和复位)", () => {
  assert.equal(compactCollision({ gateBlocked: true }), true);                  // 22:56 现场
  assert.equal(compactCollision({ compacted: true }), true);                    // 00:55 现场
  assert.equal(compactCollision({ gateBlocked: true, compacted: true }), true);
});

test("撞车判定必须保守:没有硬信号的失败不算撞车(照旧停机)", () => {
  assert.equal(compactCollision({}), false);
  assert.equal(compactCollision(), false);
  assert.equal(compactCollision({ gateBlocked: false, compacted: false }), false);
  // 别的字段再多也不算 —— 只认这两个硬信号
  assert.equal(compactCollision({ kind: "user", fullText: "x", archiveOk: false }), false);
});
