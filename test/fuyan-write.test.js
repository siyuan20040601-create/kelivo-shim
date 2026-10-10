// 投递页(/fuyan/write)的测试:门锁、cookie 投递口、与信箱共用一只箱子。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import express from "express";
import { FuyanInbox } from "../fuyan-inbox.js";
import { mountFuyanWrite } from "../fuyan-write.js";

const KEY = "door-key-123";
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "fuyan-write-"));

function serve() {
  const app = express();
  const inbox = new FuyanInbox(tempDir());
  mountFuyanWrite(app, { key: KEY, inbox });
  const srv = app.listen(0);
  return { inbox, srv, base: `http://127.0.0.1:${srv.address().port}` };
}

async function login(base) {
  const r = await fetch(`${base}/fuyan/write`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `key=${encodeURIComponent(KEY)}`,
  });
  assert.equal(r.status, 303);
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^fuyan_door=/);
  return cookie;
}

test("门锁:没登录 401 登录页;暗号对了发 cookie;暗号错了不发", async () => {
  const { srv, base } = serve();
  try {
    const cold = await fetch(`${base}/fuyan/write`);
    assert.equal(cold.status, 401);
    assert.match(await cold.text(), /家门暗号/);

    const bad = await fetch(`${base}/fuyan/write`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "key=wrong",
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get("set-cookie"), null);

    const cookie = await login(base);
    const warm = await fetch(`${base}/fuyan/write`, { headers: { cookie } });
    assert.equal(warm.status, 200);
    assert.match(await warm.text(), /投进信箱/);
  } finally { srv.close(); }
});

test("cookie 投递口:文字和媒体都落进同一只信箱;裸投 401", async () => {
  const { inbox, srv, base } = serve();
  try {
    const cookie = await login(base);

    const naked = await fetch(`${base}/fuyan/write/note`, {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"text":"hi"}',
    });
    assert.equal(naked.status, 401);

    const note = await fetch(`${base}/fuyan/write/note`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "哥哥,今天的云像小汉堡摊开睡觉" }),
    });
    assert.equal(note.status, 200);

    const media = await fetch(`${base}/fuyan/write/media`, {
      method: "POST", headers: { cookie, "content-type": "audio/webm" },
      body: Buffer.from("fake-webm-bytes"),
    });
    assert.equal(media.status, 200);
    assert.equal((await media.json()).type, "voice");

    const all = inbox.list();
    assert.equal(all.length, 2);
    assert.equal(all.filter((n) => !n.read).length, 2);
  } finally { srv.close(); }
});

test("CSP:正文页带 nonce 脚本白名单,登录页不开脚本", async () => {
  const { srv, base } = serve();
  try {
    const cookie = await login(base);
    const warm = await fetch(`${base}/fuyan/write`, { headers: { cookie } });
    assert.match(warm.headers.get("content-security-policy"), /script-src 'nonce-/);
    const cold = await fetch(`${base}/fuyan/write`);
    assert.doesNotMatch(cold.headers.get("content-security-policy") || "", /script-src/);
  } finally { srv.close(); }
});
