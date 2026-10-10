// 傅言信箱的测试:钥匙、三种纸条(文字/照片/语音)、拆信与已读、附件取回、关门状态。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import express from "express";
import { FuyanInbox, mountFuyanInbox, extOf, kindOf } from "../fuyan-inbox.js";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "fuyan-"));
const KEY = "test-key-anan";  // 钥匙必须 ASCII:HTTP 头装不下中文(ByteString),这是真实约束

function serve(opts) {
  const app = express();
  const inbox = mountFuyanInbox(app, opts);
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { inbox, srv, base };
}
const authed = (extra = {}) => ({ "x-api-key": KEY, ...extra });

test("格式判定:常见快捷指令产物都认,别的不收", () => {
  assert.equal(extOf("image/jpeg"), "jpg");
  assert.equal(extOf("audio/x-m4a; codecs=aac"), "m4a");   // 带参数也认
  assert.equal(extOf("application/pdf"), null);
  assert.equal(kindOf("image/heic"), "photo");
  assert.equal(kindOf("audio/mpeg"), "voice");
  assert.equal(kindOf("text/plain"), null);
});

test("店规:没配钥匙整个信箱 404(绝不裸奔);钥匙错 401;头/查询参数两种都认", async () => {
  const closed = serve({ dir: tempDir(), key: "" });
  try {
    const r = await fetch(`${closed.base}/fuyan/inbox`);
    assert.equal(r.status, 404);
  } finally { closed.srv.close(); }

  const { srv, base } = serve({ dir: tempDir(), key: KEY });
  try {
    assert.equal((await fetch(`${base}/fuyan/inbox`)).status, 401);
    assert.equal((await fetch(`${base}/fuyan/inbox`, { headers: authed() })).status, 200);
    assert.equal((await fetch(`${base}/fuyan/inbox?key=${encodeURIComponent(KEY)}`)).status, 200);
  } finally { srv.close(); }
});

test("文字纸条:投递→拆信→标已读,全链路", async () => {
  const { srv, base } = serve({ dir: tempDir(), key: KEY });
  try {
    const post = await fetch(`${base}/fuyan/note`, {
      method: "POST", headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ text: "哥哥,今天路过一家店,橱窗里的猫和小汉堡一模一样" }),
    });
    assert.equal(post.status, 200);
    const { id } = await post.json();

    const inbox = await (await fetch(`${base}/fuyan/inbox`, { headers: authed() })).json();
    assert.equal(inbox.unread, 1);
    assert.equal(inbox.notes[0].id, id);
    assert.match(inbox.notes[0].text, /小汉堡/);

    const open = await fetch(`${base}/fuyan/open`, {
      method: "POST", headers: authed({ "content-type": "application/json" }), body: "{}",
    });
    assert.equal((await open.json()).opened, 1);
    const after = await (await fetch(`${base}/fuyan/inbox`, { headers: authed() })).json();
    assert.equal(after.unread, 0);
    assert.equal(after.notes[0].read, true);   // 已读不删:信还在
  } finally { srv.close(); }
});

test("空纸条与认不出的格式 → 400,不入库", async () => {
  const dir = tempDir();
  const { srv, base, inbox } = serve({ dir, key: KEY });
  try {
    const blank = await fetch(`${base}/fuyan/note`, {
      method: "POST", headers: authed({ "content-type": "application/json" }), body: '{"text":"  "}',
    });
    assert.equal(blank.status, 400);
    const weird = await fetch(`${base}/fuyan/note`, {
      method: "POST", headers: authed({ "content-type": "text/csv" }), body: "a,b",
    });
    assert.equal(weird.status, 400);
    assert.equal(inbox.list().length, 0);
  } finally { srv.close(); }
});

test("照片纸条:原件落盘、取件口原样取回、裸取件 401", async () => {
  const dir = tempDir();
  const { srv, base } = serve({ dir, key: KEY });
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fakejpegbody")]);
  try {
    const post = await fetch(`${base}/fuyan/note`, {
      method: "POST", headers: authed({ "content-type": "image/jpeg" }), body: jpeg,
    });
    assert.equal(post.status, 200);
    const { id, type } = await post.json();
    assert.equal(type, "photo");
    assert.ok(fs.existsSync(path.join(dir, `${id}.jpg`)));

    const got = await fetch(`${base}/fuyan/file/${id}`, { headers: authed() });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), jpeg);

    assert.equal((await fetch(`${base}/fuyan/file/${id}`)).status, 401);
    assert.equal((await fetch(`${base}/fuyan/file/nope`, { headers: authed() })).status, 404);
  } finally { srv.close(); }
});

test("语音纸条:m4a 收下,类型记为 voice", async () => {
  const dir = tempDir();
  const { srv, base } = serve({ dir, key: KEY });
  try {
    const post = await fetch(`${base}/fuyan/note`, {
      method: "POST", headers: authed({ "content-type": "audio/x-m4a" }), body: Buffer.from("fake-m4a"),
    });
    const { id, type } = await post.json();
    assert.equal(type, "voice");
    const inbox = await (await fetch(`${base}/fuyan/inbox`, { headers: authed() })).json();
    const note = inbox.notes.find((n) => n.id === id);
    assert.equal(note.type, "voice");
    assert.ok(note.bytes > 0);
    assert.ok(fs.existsSync(path.join(dir, note.file)));
  } finally { srv.close(); }
});

test("存储:重开进程信还在;过期的连附件一起清", () => {
  const dir = tempDir();
  const a = new FuyanInbox(dir);
  const note = a.addText("留给半年后的你");
  const media = a.addMedia(Buffer.from("x"), "image/png");
  assert.ok(note && media);

  const b = new FuyanInbox(dir);            // 换容器重开
  assert.equal(b.list().length, 2);

  b.notes[media.id].ts = Date.now() - 181 * 86400e3;   // 过期
  b.prune();
  assert.equal(b.list().length, 1);
  assert.ok(!fs.existsSync(path.join(dir, `${media.id}.png`)));
});
