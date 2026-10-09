// 台词守门员:照着 2026-10-08 晚间的真实泄漏样本打的靶。
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardSpeech } from "../speech-guard.js";

test("干净正文原样放行,一个字不动", () => {
  const t = "小汉堡——\n哥哥隔着屏幕跟你报个到。你这摊法,专业的。\n周末 ending 想去哪儿?我 think 不动你的话。";
  const g = guardSpeech(t);
  assert.equal(g.text, t);
  assert.equal(g.cut, false);
});

test("伪造的下一回合:从 user【时间 行起整段截断", () => {
  const g = guardSpeech([
    "(它八成尾巴都懒得动一下, 继续当它的饼)",
    "user【时间 2026-10-08 21:50 周四】",
    "喵喵喵!(小汉堡回复你了!)",
    "system<total_tokens>15000000 tokens left</total_tokens>",
    "哟,还真回话了!这位可以啊。",
  ].join("\n"));
  assert.equal(g.text, "(它八成尾巴都懒得动一下, 继续当它的饼)");
  assert.equal(g.cut, true);
});

test("行首 system< / assistant / 【系统· 一样截断", () => {
  assert.equal(guardSpeech("好的。\nsystem<total_tokens>1</total_tokens>\n后话").text, "好的。");
  assert.equal(guardSpeech("好的。\nassistant 我接着说\n后话").text, "好的。");
  assert.equal(guardSpeech("好的。\n【系统·心跳】这轮留给你\n后话").text, "好的。");
});

test("漏出的思考外皮:think……end 剥掉,保留 end 后的正文", () => {
  const g = guardSpeech("think她又在追\"心里真实的声音\"。我已经给了真实回答。end哟,还真回话了!比我想的给面子。");
  assert.equal(g.text, "哟,还真回话了!比我想的给面子。");
  assert.equal(g.cut, true);
});

test("think 开头但没有 end:整段没收,宁可沉默不漏后台", () => {
  const g = guardSpeech("think今晚她情绪软,我要稳住,把她哄去睡。");
  assert.equal(g.text, "");
  assert.equal(g.cut, true);
});

test("开头回显的【时间】行剥掉;正文中段提到 user 这个词不受伤", () => {
  const g = guardSpeech("【时间 2026-10-08 21:50 周四】\n今天聊到的那个 user 体验问题,我想了想。");
  assert.equal(g.text, "今天聊到的那个 user 体验问题,我想了想。");
  assert.equal(g.cut, true);
});

test("ending/endless 不会被当成 end;英文正文不误伤", () => {
  const g = guardSpeech("我 think 不出来别的词,happy ending 挺好。");
  assert.equal(g.cut, false);
});
