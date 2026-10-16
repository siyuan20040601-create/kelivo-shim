import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mountSessionAdmin } from "../session-admin.js";

test("native admin forms preserve their origin and reject untrusted origins", async () => {
  const app = express();
  let actions = 0;
  mountSessionAdmin(app, {
    key: "local-test-key",
    snapshot: () => ({ enabled: true, busy: false, phase: "ready", revision: "test-revision", model: "claude-opus-4-6", models: ["claude-opus-4-6"], effort: "high" }),
    control: async () => { actions++; return { ok: true, message: "done" }; },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const base = origin + "/admin/session";
  const post = (route, fields, headers = {}) => fetch(base + route, {
    method: "POST", redirect: "manual",
    headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", ...headers },
    body: new URLSearchParams(fields),
  });
  try {
    const loginPage = await fetch(base);
    // A native HTML POST under no-referrer would send Origin: null.
    assert.equal(loginPage.headers.get("referrer-policy"), "same-origin");
    assert.match(await loginPage.text(), /method="post"/);
    for (const headers of [{ Origin: "null" }, { Origin: "https://foreign.example" }, { "Sec-Fetch-Site": "cross-site" }]) {
      assert.equal((await post("/login", { key: "local-test-key" }, headers)).status, 403);
    }
    const login = await post("/login", { key: "local-test-key" });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const page = await fetch(base, { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("referrer-policy"), "same-origin");
    const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)[1];
    assert.equal((await post("/action", { action: "restart", revision: "test-revision", csrf }, { Cookie: cookie })).status, 303);
    assert.equal(actions, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
