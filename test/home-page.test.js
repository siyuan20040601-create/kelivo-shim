// 家门口 /home 的测试:门锁、问候、真实灯火、只读纪律(零 JS、无正文)。
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mountHomePage, doorWords } from "../home-page.js";

const SNAP = {
  tokens: 50000, limit: 167000, busy: false, queued: 0,
  lastSpokeAt: Date.now() - 42 * 60000, lastTurnAt: Date.now() - 10 * 60000,
  wakeDay: "7–24", wakeIdleMinDay: 90,
  notesCount: 3, notesUnopened: 1,
  statusOn: true, statusWrittenAt: new Date(Date.now() - 30 * 60000).toISOString(), statusBroken: false,
};

async function startHome(snap = SNAP) {
  const app = express();
  mountHomePage(app, { key: "open-sesame", snapshot: () => snap });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, close: () => new Promise((r) => srv.close(r)) };
}

test("门锁:没登录 401 登录页;错暗号 401;对了发 cookie 进门", async () => {
  const s = await startHome();
  try {
    const anon = await fetch(s.base + "/home");
    assert.equal(anon.status, 401);
    assert.match(await anon.text(), /报一下暗号/);

    const bad = await fetch(s.base + "/home", { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: "key=wrong" });
    assert.equal(bad.status, 401);
    assert.match(await bad.text(), /暗号不对/);

    const ok = await fetch(s.base + "/home", { method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: "key=open-sesame" });
    assert.equal(ok.status, 303);
    const cookie = ok.headers.get("set-cookie");
    assert.match(cookie, /home_door=/);
    assert.match(cookie, /HttpOnly/);

    const page = await fetch(s.base + "/home", { headers: { cookie: cookie.split(";")[0] } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /欢迎回家,安安/);
  } finally { await s.close(); }
});

test("灯火是真的:窗口成数、没拆的纸条、便签新鲜度、心跳设置都来自快照", async () => {
  const s = await startHome();
  try {
    const login = await fetch(s.base + "/home", { method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: "key=open-sesame" });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const html = await (await fetch(s.base + "/home", { headers: { cookie } })).text();
    assert.match(html, /写了 30%/, "5万/16.7万 ≈ 30%");
    assert.match(html, /1 张还没拆/);
    assert.match(html, /30 分钟前 贴过一张|你 30 分钟前 贴过一张/);
    assert.match(html, /90 分钟没理他/);
    assert.ok(!html.includes("<script"), "零 JavaScript");
    const res = await fetch(s.base + "/home", { headers: { cookie } });
    assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  } finally { await s.close(); }
});

test("心跳关着/信箱空着/便签板坏了,话都说得明白", async () => {
  const s = await startHome({ ...SNAP, wakeIdleMinDay: 1000000, notesCount: 0, notesUnopened: 0,
    statusBroken: true, statusWrittenAt: null });
  try {
    const login = await fetch(s.base + "/home", { method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: "key=open-sesame" });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const html = await (await fetch(s.base + "/home", { headers: { cookie } })).text();
    assert.match(html, /心跳眼下是关着的/);
    assert.match(html, /信箱空着/);
    assert.match(html, /读不出来/);
  } finally { await s.close(); }
});

test("门口的话跟着钟点换", () => {
  assert.match(doorWords(8), /清晨/);
  assert.match(doorWords(12), /午后/);
  assert.match(doorWords(20), /灯都给你留着/);
  assert.match(doorWords(2), /夜深/);
});
