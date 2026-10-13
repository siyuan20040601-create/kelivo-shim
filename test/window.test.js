// 窗口用量测试
//
// 这个文件存在的理由是一次真实的线上翻车(2026-07-29):
// 上一版拿 result 事件的**顶层 usage** 估算窗口大小,而顶层是一轮里所有 API 请求的
// **累加值**。一轮调 3 次工具 → 虚报 3 倍:真实窗口 53947 被显示成 161206,
// 32% 显示成 97%,还触发了一条毫无根据的 85% 提醒。
// 下面的数字全部取自那次事故的线上真实数据。

import { test } from "node:test";
import assert from "node:assert";
import {
  prefixFromMessageStart, prefixOf, windowPct,
  DEFAULT_WINDOW_LIMIT, EXTENDED_WINDOW_LIMIT, windowLimitForModel,
} from "../window.js";

const msgStart = (u) => ({ type: "message_start", message: { usage: u } });

test("message_start 给出这一次请求的真实前缀", () => {
  const e = msgStart({ input_tokens: 5, cache_read_input_tokens: 53725, cache_creation_input_tokens: 217 });
  assert.equal(prefixFromMessageStart(e), 53947);
});

test("【回归】一轮 3 次请求:窗口 = 单次前缀,不是三次之和", () => {
  // 线上真实:连续三次请求各约 53.7k,而 result 顶层报 161206
  const calls = [53725, 53725, 53947].map((r) => msgStart({ input_tokens: 0, cache_read_input_tokens: r }));
  const peak = Math.max(...calls.map(prefixFromMessageStart));
  assert.equal(peak, 53947, "应是本轮最大的单次前缀");
  assert.ok(peak < 60000, "绝不能是 161206 那个累加值");
  assert.equal(windowPct(peak, DEFAULT_WINDOW_LIMIT), 32, "真实占用是 32%,不是 97%");
});

test("【回归】那条误报的 85% 提醒不该再出现", () => {
  const real = 53947, bogus = 161206;
  assert.ok(windowPct(real, DEFAULT_WINDOW_LIMIT) < 85, "真实值远不到提醒线");
  assert.ok(windowPct(bogus, DEFAULT_WINDOW_LIMIT) >= 85, "累加值会误触发 —— 正是被修掉的那个 bug");
});

test("不是 message_start 的事件一律返回 0(不参与窗口计算)", () => {
  assert.equal(prefixFromMessageStart({ type: "content_block_delta" }), 0);
  assert.equal(prefixFromMessageStart({ type: "message_delta", usage: { cache_read_input_tokens: 9999 } }), 0);
  assert.equal(prefixFromMessageStart(null), 0);
  assert.equal(prefixFromMessageStart(undefined), 0);
});

test("message_start 缺 usage 不炸、不产生 NaN", () => {
  const v = prefixFromMessageStart({ type: "message_start", message: {} });
  assert.equal(v, 0);
  assert.ok(!Number.isNaN(v));
});

test("prefixOf 缺字段按 0 计", () => {
  assert.equal(prefixOf({ cache_read_input_tokens: 500 }), 500);
  assert.equal(prefixOf({}), 0);
  assert.equal(prefixOf(null), 0);
});

test("百分比:85% 提醒线两侧", () => {
  assert.equal(windowPct(0, 167000), 0);
  assert.ok(windowPct(141000, 167000) < 85, "141k 还不该提醒");
  assert.ok(windowPct(142000, 167000) >= 85, "142k 该提醒了");
  assert.equal(windowPct(167000, 167000), 100);
});

test("limit 为 0 不除零", () => {
  assert.equal(windowPct(1000, 0), 0);
});

test("默认触发线与 Claude Code 的算法对得上(200k 上下文)", () => {
  // effectiveWindow = 200000 - min(maxOutput, 20000);  threshold = effectiveWindow - 13000
  assert.equal(DEFAULT_WINDOW_LIMIT, 200000 - 20000 - 13000);
});

test("claude-opus-5-5 按 1M 上下文计算 967k 压缩线", () => {
  assert.equal(EXTENDED_WINDOW_LIMIT, 1000000 - 20000 - 13000);
  assert.equal(windowLimitForModel("claude-opus-5-5"), 967000);
  assert.equal(windowLimitForModel("claude-opus-5-5-20261001"), 967000);
  assert.equal(windowLimitForModel("claude-opus-4-6"), 167000);
});
