// 信纸页(小纸条 Mini App)的测试:验签算法、API 的身份与归属校验、按钮形态切换。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHmac } from "node:crypto";
import express from "express";
import { validateInitData, mountNoteApp } from "../note-app.js";
import { NoteStore, keyboard } from "../notes.js";

const BOT = "12345:TEST_TOKEN_abc";
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "note-app-")), "notes.json");

// 按 Telegram 官方算法签一份 initData(测试这边是"扮演 Telegram")。
function signInitData(fields, token = BOT) {
  const params = new URLSearchParams(fields);
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(dcs).digest("hex"));
  return params.toString();
}
const freshFields = (userId = 777) => ({
  query_id: "AAABBB",
  user: JSON.stringify({ id: userId, first_name: "安" }),
  auth_date: String(Math.floor(Date.now() / 1000)),
});

test("initData 验签:正签通过取出 user.id;篡改/过期/缺 hash/错 token 全拒", () => {
  const good = validateInitData(signInitData(freshFields()), BOT);
  assert.equal(good.ok, true);
  assert.equal(good.userId, 777);

  // 签完再改内容 → 签名对不上
  const tampered = signInitData(freshFields()).replace("777", "888");
  assert.equal(validateInitData(tampered, BOT).error, "bad");
  // auth_date 太老 → stale(卡片可以躺几天,但 initData 是点按钮那刻新签的,旧的不认)
  const old = signInitData({ ...freshFields(), auth_date: String(Math.floor(Date.now() / 1000) - 25 * 3600) });
  assert.equal(validateInitData(old, BOT).error, "stale");
  // 缺 hash / 用别的 bot token 验 → bad
  assert.equal(validateInitData("user=x&auth_date=1", BOT).error, "bad");
  assert.equal(validateInitData(signInitData(freshFields()), "999:OTHER").error, "bad");
  assert.equal(validateInitData("", BOT).error, "bad");
});

async function startApp({ chatId = 777, onLiked = null } = {}) {
  const store = new NoteStore(tempFile());
  const app = express();
  app.use(express.json());
  mountNoteApp(app, { store, botToken: BOT, getChatId: () => chatId, onLiked });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (p, body) => {
    const r = await fetch(base + p, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, j: await r.json() };
  };
  return { store, base, post, close: () => new Promise((r) => srv.close(r)) };
}

test("信纸页外壳:零数据、带 CSP、引用官方 WebApp 脚本", async () => {
  const s = await startApp();
  try {
    const n = s.store.create({ title: "秘密标题XQJ", content: "秘密正文XQJ" });
    const r = await fetch(s.base + "/note-app?id=" + n.note_id);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
    const html = await r.text();
    assert.match(html, /telegram-web-app\.js/);
    assert.ok(!html.includes("XQJ"), "页面本身不含纸条内容,内容只走验签 API");
  } finally { await s.close(); }
});

test("取纸条:验签+验人+存在性;首次取件记「拆开」且只记一次", async () => {
  const s = await startApp();
  try {
    const n = s.store.create({ title: "给你", content: "今晚月亮很好" });
    const body = (extra) => ({ id: n.note_id, initData: signInitData(freshFields()), ...extra });

    const bad = await s.post("/note-app/api/note", { id: n.note_id, initData: "user=x&hash=" + "0".repeat(64) });
    assert.equal(bad.status, 401);
    const notHer = await s.post("/note-app/api/note", { id: n.note_id, initData: signInitData(freshFields(888)) });
    assert.equal(notHer.status, 403, "别人的 Telegram 账号即使拿到链接也打不开");
    const gone = await s.post("/note-app/api/note", body({ id: "deadbeef" }));
    assert.equal(gone.status, 404);

    const ok = await s.post("/note-app/api/note", body());
    assert.equal(ok.status, 200);
    assert.equal(ok.j.title, "给你");
    assert.equal(ok.j.content, "今晚月亮很好");
    assert.equal(ok.j.liked, false);
    await s.post("/note-app/api/note", body());   // 她又点开一次
    assert.equal(s.store.quietLines().filter((l) => l.includes("拆开")).length, 1, "重复拆开只记一次");
  } finally { await s.close(); }
});

test("信纸页点爱心:开关式,并回调刷新聊天卡片按钮", async () => {
  const refreshed = [];
  const s = await startApp({ onLiked: (n) => refreshed.push(n.liked_at ? "on" : "off") });
  try {
    const n = s.store.create({ title: "t", content: "c" });
    const body = { id: n.note_id, initData: signInitData(freshFields()) };
    assert.equal((await s.post("/note-app/api/like", body)).j.liked, true);
    assert.equal((await s.post("/note-app/api/like", body)).j.liked, false);
    assert.deepEqual(refreshed, ["on", "off"], "每次翻转都通知刷新卡片");
  } finally { await s.close(); }
});

test("按钮形态:配了 appUrl →「拆开纸条」变 Mini App 按钮;不配不变;展开态仍是收起", () => {
  const s = new NoteStore(tempFile());
  const n = s.create({ title: "t", content: "c" });
  const appKb = JSON.stringify(keyboard(n, { appUrl: "https://example.zeabur.app" }));
  assert.match(appKb, /"web_app":\{"url":"https:\/\/example\.zeabur\.app\/note-app\?id=[0-9a-f]{8}"\}/);
  assert.ok(!appKb.includes("note:open:"), "有信纸页就不再原地展开");
  assert.match(appKb, /note:like:/, "爱心和回信仍是普通按钮");
  const plainKb = JSON.stringify(keyboard(n));
  assert.match(plainKb, /note:open:/);
  assert.ok(!plainKb.includes("web_app"));
  assert.match(JSON.stringify(keyboard(n, { appUrl: "https://x.app", expanded: true })), /收起/);
});
