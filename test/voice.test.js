// node --test 跑;只测纯函数 splitVoiceSegments,不碰网络。
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitVoiceSegments } from "../voice.js";

test("纯文字:整段原样、单段", () => {
  const segs = splitVoiceSegments("今天怎么样?\n早点睡。");
  assert.deepEqual(segs, [{ type: "text", content: "今天怎么样?\n早点睡。" }]);
});

test("单语音段:只出一个 voice 段,内容去掉首尾空白", () => {
  const segs = splitVoiceSegments("[语音] Good night — I'm right here. [/语音]");
  assert.deepEqual(segs, [{ type: "voice", content: "Good night — I'm right here." }]);
});

test("文字+语音混排:按出现顺序", () => {
  const segs = splitVoiceSegments("先睡吧。\n[语音]Go to sleep.[/语音]\n明天见。");
  assert.deepEqual(segs, [
    { type: "text", content: "先睡吧。\n" },
    { type: "voice", content: "Go to sleep." },
    { type: "text", content: "\n明天见。" },
  ]);
});

test("多个语音段:各自独立、顺序保持", () => {
  const segs = splitVoiceSegments("[语音]One.[/语音]中间插一句[语音]Two.[/语音]");
  assert.deepEqual(segs, [
    { type: "voice", content: "One." },
    { type: "text", content: "中间插一句" },
    { type: "voice", content: "Two." },
  ]);
});

test("未闭合标记:视为普通文本,不吞字", () => {
  const raw = "喏[语音]this never closes";
  assert.deepEqual(splitVoiceSegments(raw), [{ type: "text", content: raw }]);
});

test("全角/半角括号与斜杠混用:宽松匹配", () => {
  const segs = splitVoiceSegments("【语音】Hey.[/语音]好了【语音】Bye.【／语音】");
  assert.deepEqual(segs, [
    { type: "voice", content: "Hey." },
    { type: "text", content: "好了" },
    { type: "voice", content: "Bye." },
  ]);
});

test("空语音段:丢弃,不发空语音", () => {
  const segs = splitVoiceSegments("前[语音]  [/语音]后");
  assert.deepEqual(segs, [
    { type: "text", content: "前" },
    { type: "text", content: "后" },
  ]);
});

test("语音内容里的换行保留(交给 TTS 当停顿素材)", () => {
  const segs = splitVoiceSegments("[语音]Line one.\nLine two.[/语音]");
  assert.deepEqual(segs, [{ type: "voice", content: "Line one.\nLine two." }]);
});

test("中文语音段照样出声(2026-10-10 拆闸):不再因 CJK 退回文字", () => {
  const segs = splitVoiceSegments("[语音]安安,我在。坐我旁边。[/语音]");
  assert.deepEqual(segs, [{ type: "voice", content: "安安,我在。坐我旁边。" }]);
  // 中英混写也是一段语音
  const mix = splitVoiceSegments("【语音】安安,come here。【/语音】尾注");
  assert.equal(mix[0].type, "voice");
  assert.equal(mix[1].content, "尾注");
});
