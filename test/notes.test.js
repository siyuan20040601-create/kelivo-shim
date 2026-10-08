import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { NoteStore, renderCard, keyboard, parseCallback, replyEventText } from "../notes.js";
import { handleRpc } from "../status-mcp.js";

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "notes-")), "notes.json");

test("建纸条:标题正文截断、预览生成、跨重启还在", () => {
  const file = tempFile();
  const s = new NoteStore(file);
  const n = s.create({ title: "今晚的月亮", content: "想你了。".repeat(300) });
  assert.equal(n.title, "今晚的月亮");
  assert.ok([...n.content].length <= 2000, "正文截断到上限");
  assert.ok(n.preview.endsWith("…"));
  const s2 = new NoteStore(file); // 重启
  assert.equal(s2.get(n.note_id).title, "今晚的月亮");
});

test("拆开幂等:只记第一次;点赞开关式不累计;取消也是事件", () => {
  const s = new NoteStore(tempFile());
  const n = s.create({ title: "t", content: "c" });
  assert.deepEqual(s.markOpened(n.note_id), { first: true });
  assert.deepEqual(s.markOpened(n.note_id), { first: false });
  assert.deepEqual(s.markOpened(n.note_id), { first: false });
  assert.equal(s.toggleLike(n.note_id).liked, true);
  assert.equal(s.toggleLike(n.note_id).liked, false);
  assert.equal(s.toggleLike(n.note_id).liked, true);
  const lines = s.quietLines();
  assert.equal(lines.filter((l) => l.includes("拆开")).length, 1, "重复拆开只算一次");
  s.markQuietDelivered();
  assert.equal(s.quietLines().length, 0);
  assert.equal(s.undeliveredCount(), 0);
});

test("回信唯一:只收一封,空回信拒收,成功后关闭入口", () => {
  const s = new NoteStore(tempFile());
  const n = s.create({ title: "t", content: "c" });
  assert.equal(s.setReply(n.note_id, "   ").error, "empty");
  assert.equal(s.setReply(n.note_id, "收到啦").ok, true);
  assert.equal(s.setReply(n.note_id, "再来一封").error, "already", "每张纸条只收一封");
  assert.equal(s.setReply("deadbeef", "x").error, "notfound");
  assert.ok(!JSON.stringify(keyboard(s.get(n.note_id))).includes("回信"), "回过信就不再显示回信按钮");
  assert.match(replyEventText(s.get(n.note_id)), /收到啦/);
});

test("ForceReply 配对:按提示消息 id 找回纸条,回信后解除绑定", () => {
  const s = new NoteStore(tempFile());
  const n = s.create({ title: "t", content: "c" });
  s.rememberReplyPrompt(n.note_id, 4567);
  assert.equal(s.findByReplyPrompt(4567).note_id, n.note_id);
  assert.equal(s.findByReplyPrompt(9999), null);
  s.setReply(n.note_id, "ok");
  assert.equal(s.findByReplyPrompt(4567), null, "回信后提示失效,不会二次配对");
});

test("callback_data 解析:只认约定形状,其余返回 null", () => {
  assert.deepEqual(parseCallback("note:open:0a1b2c3d"), { action: "open", id: "0a1b2c3d" });
  assert.deepEqual(parseCallback("note:like:ffffffff"), { action: "like", id: "ffffffff" });
  assert.equal(parseCallback("note:open:短"), null);
  assert.equal(parseCallback("evil:open:0a1b2c3d"), null);
  assert.equal(parseCallback(""), null);
});

test("卡片渲染:折叠只露预览,展开含全文;按钮随状态变化", () => {
  const s = new NoteStore(tempFile());
  const body = "这是一段足够长的正文,长到折叠预览绝对装不下它的结尾部分——所以收起时看不到这句话的末尾标记XYZ";
  const n = s.create({ title: "标题", content: body });
  assert.ok(!renderCard(n).includes("XYZ"), "折叠态看不到正文结尾");
  assert.ok(renderCard(n, { expanded: true }).includes("XYZ"), "展开含全文");
  assert.match(JSON.stringify(keyboard(n)), /拆开纸条/);
  assert.match(JSON.stringify(keyboard(n, { expanded: true })), /收起/);
  s.toggleLike(n.note_id);
  assert.match(JSON.stringify(keyboard(n)), /已喜欢/);
});

test("MCP 工具表:注入 onNote 后多出 leave_note;调用走注入的发送器", async () => {
  const sent = [];
  const onNote = async (title, content) => { sent.push({ title, content }); return "已送出"; };
  const list = handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { onNote });
  assert.deepEqual(list.result.tools.map((t) => t.name), ["look", "leave_note"]);
  const listNo = handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, {});
  assert.deepEqual(listNo.result.tools.map((t) => t.name), ["look"], "没有发送器就不暴露工具");
  const call = await handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "leave_note", arguments: { title: "嗨", content: "想你" } } }, { onNote });
  assert.match(call.result.content[0].text, /已送出/);
  assert.deepEqual(sent, [{ title: "嗨", content: "想你" }]);
  const fail = await handleRpc({ jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "leave_note", arguments: { title: "x", content: "y" } } },
    { onNote: async () => { throw new Error("TG 挂了"); } });
  assert.equal(fail.result.isError, false, "失败也走文字告知,不抛协议错误");
  assert.match(fail.result.content[0].text, /没送出去/);
});
