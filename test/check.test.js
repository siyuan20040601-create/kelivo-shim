// node --test 跑;只测 check.js 的纯函数,不碰网络、不碰文件、不起进程。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAppName, pushActivity, summarizeActivity,
  takeCheckMarker, lookupPrompt, isSilentReply,
} from "../check.js";

const T0 = Date.parse("2026-08-28T12:00:00Z");
const min = (n) => n * 60000;

// ---- normalizeAppName --------------------------------------------------------
test("App 名:压空白、去首尾", () => {
  assert.equal(normalizeAppName("  小红书  "), "小红书");
  assert.equal(normalizeAppName("Bili  Bili\n"), "Bili Bili");
});

test("App 名:空/缺失/纯空白都算没有", () => {
  for (const v of ["", "   ", null, undefined]) assert.equal(normalizeAppName(v), null);
});

test("App 名:超长截到 40 字", () => {
  assert.equal(normalizeAppName("啊".repeat(100)).length, 40);
});

// ---- pushActivity ------------------------------------------------------------
test("push:追加在末尾,带时间戳", () => {
  const l = pushActivity([], { app: "小红书" }, { now: T0 });
  assert.deepEqual(l, [{ app: "小红书", at: T0 }]);
});

test("push:超过 TTL 的旧记录被丢掉", () => {
  const old = [{ app: "抖音", at: T0 - min(60 * 49) }, { app: "微博", at: T0 - min(60) }];
  const l = pushActivity(old, { app: "小红书" }, { now: T0 });
  assert.deepEqual(l.map((e) => e.app), ["微博", "小红书"]);
});

test("push:条数上限,留最近的", () => {
  let l = [];
  for (let i = 0; i < 5; i++) l = pushActivity(l, { app: `app${i}` }, { now: T0 + i, cap: 3 });
  assert.deepEqual(l.map((e) => e.app), ["app2", "app3", "app4"]);
});

// ---- summarizeActivity -------------------------------------------------------
test("summary:空列表 = 明确的「没有记录」,不是 undefined", () => {
  assert.deepEqual(summarizeActivity([], { now: T0 }),
    { count: 0, lastApp: null, lastAt: null, minutesAgo: null, recent: [] });
});

test("summary:最后一条 + 相邻重复折叠", () => {
  const l = [
    { app: "微博", at: T0 - min(30) },
    { app: "小红书", at: T0 - min(20) },
    { app: "小红书", at: T0 - min(10) },
    { app: "小红书", at: T0 - min(3) },
  ];
  const s = summarizeActivity(l, { now: T0 });
  assert.equal(s.count, 4);
  assert.equal(s.lastApp, "小红书");
  assert.equal(s.minutesAgo, 3);
  assert.deepEqual(s.recent.map((r) => r.app), ["小红书", "微博"]);   // 三条小红书折成一条
});

test("summary:不相邻的同名不折叠(她来回切)", () => {
  const l = [
    { app: "小红书", at: T0 - min(30) },
    { app: "微信", at: T0 - min(20) },
    { app: "小红书", at: T0 - min(10) },
  ];
  assert.deepEqual(summarizeActivity(l, { now: T0 }).recent.map((r) => r.app),
    ["小红书", "微信", "小红书"]);
});

test("summary:limit 限制回溯条数", () => {
  const l = [];
  for (let i = 0; i < 20; i++) l.push({ app: `app${i}`, at: T0 - min(20 - i) });
  assert.equal(summarizeActivity(l, { now: T0, limit: 3 }).recent.length, 3);
});

test("summary:脏条目(没有 app 的)被忽略,不炸", () => {
  const l = [null, { at: T0 }, { app: "", at: T0 }, { app: "微博", at: T0 - min(5) }];
  const s = summarizeActivity(l, { now: T0 });
  assert.equal(s.count, 1);
  assert.equal(s.lastApp, "微博");
});

// ---- takeCheckMarker ---------------------------------------------------------
test("标记:没有就原样返回,wants=false", () => {
  assert.deepEqual(takeCheckMarker("在忙吗?"), { text: "在忙吗?", wants: false });
});

test("标记:半角/全角/带空格都认", () => {
  for (const m of ["[查岗]", "【查岗】", "[ 查岗 ]", "【 查岗】"])
    assert.equal(takeCheckMarker(`嗯。${m}`).wants, true, m);
});

test("标记:剥掉之后正文还在", () => {
  assert.deepEqual(takeCheckMarker("[查岗]她在干嘛"), { text: "她在干嘛", wants: true });
});

test("标记:独占一行时不留空行", () => {
  assert.deepEqual(takeCheckMarker("先看一眼。\n\n[查岗]\n\n嗯。"),
    { text: "先看一眼。\n\n嗯。", wants: true });
});

test("标记:只写了个标记 = 正文为空(不该往她那儿发空气泡)", () => {
  assert.deepEqual(takeCheckMarker("[查岗]"), { text: "", wants: true });
});

test("标记:多个只算一次查", () => {
  assert.deepEqual(takeCheckMarker("[查岗]中间[查岗]"), { text: "中间", wants: true });
});

test("标记:不吃相邻的别的标记(语音/贴纸照常留着)", () => {
  const r = takeCheckMarker("[查岗][贴纸:心累]");
  assert.deepEqual(r, { text: "[贴纸:心累]", wants: true });
});

test("标记:换行/多次调用不受正则 lastIndex 影响(连测两遍结果一样)", () => {
  const s = "嗯[查岗]";
  assert.deepEqual(takeCheckMarker(s), takeCheckMarker(s));
});

test("标记:空/undefined 不炸", () => {
  assert.deepEqual(takeCheckMarker(""), { text: "", wants: false });
  assert.deepEqual(takeCheckMarker(undefined), { text: "", wants: false });
});

// ---- lookupPrompt ------------------------------------------------------------
test("正文:没有记录时说明白是「没记录」,不含 App 名", () => {
  const p = lookupPrompt(summarizeActivity([], { now: T0 }), { bjNow: "2026-08-28 20:00" });
  assert.match(p, /没有动静/);
  assert.match(p, /2026-08-28 20:00/);
});

test("正文:带上最后一个 App 和多久以前", () => {
  const l = [{ app: "微博", at: T0 - min(40) }, { app: "小红书", at: T0 - min(7) }];
  const p = lookupPrompt(summarizeActivity(l, { now: T0 }), { bjNow: "2026-08-28 20:00" });
  assert.match(p, /7 分钟前打开了小红书/);
  assert.ok(p.includes("再往前:微博(40 分钟前)"), p);
});

test("正文:刚刚(不到一分钟)不说「0 分钟前」", () => {
  const l = [{ app: "抖音", at: T0 - 10000 }];
  assert.match(lookupPrompt(summarizeActivity(l, { now: T0 }), { bjNow: "x" }), /刚刚打开了抖音/);
});

test("正文:只给事实和选择权,不下指令", () => {
  const l = [{ app: "抖音", at: T0 }];
  const p = lookupPrompt(summarizeActivity(l, { now: T0 }), { bjNow: "x" });
  assert.match(p, /都由你/);
  assert.doesNotMatch(p, /立刻|必须|请你/);      // 2026-07-22 伪系统指令事故的教训
});

// ---- isSilentReply -----------------------------------------------------------
test("沉默:空、纯空白、含【沉默】都算他选择不出声", () => {
  for (const s of ["", "   ", "【沉默】", "\n【沉默】\n"]) assert.equal(isSilentReply(s), true, s);
});

test("沉默:说了话就不算", () => {
  assert.equal(isSilentReply("还没睡?"), false);
});

test("裸「沉默」整条消息算沉默;句子里含「沉默」不算", () => {
  assert.ok(isSilentReply("沉默"));
  assert.ok(isSilentReply("沉默。"));
  assert.ok(isSilentReply(" 沉默…… "));
  assert.ok(isSilentReply("【沉默】"));
  assert.ok(!isSilentReply("我不想沉默"));
  assert.ok(!isSilentReply("沉默是今晚的康桥"));
});
