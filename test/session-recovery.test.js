import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { HANDOFF_MAX_CHARS, SessionStore, prepareProjects, requestKey, pruneState } from "../session-state.js";
const root = path.resolve(import.meta.dirname, "..");
const pause = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const readLines = (f) => fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const setup = () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shim-session-"));
  return { temp, dir: path.join(temp, "volume"), inputs: path.join(temp, "inputs"), runs: path.join(temp, "runs") };
};
async function start(f, generation = 1, extra = {}) {
  const home = path.join(f.temp, "home-" + generation), cwd = path.join(f.temp, "container-" + generation);
  fs.mkdirSync(cwd, { recursive: true });
  prepareProjects(f.dir, path.join(home, ".claude", "projects"));
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const base = `http://127.0.0.1:${port}`;
  // Web-based GitHub uploads don't preserve executable bits on new files.
  // Make a private executable wrapper so the fixture is portable after upload.
  const binary = path.join(f.temp, "claude-fixture.mjs");
  fs.writeFileSync(binary, "#!/usr/bin/env node\nawait import(" + JSON.stringify(path.join(root, "dev/fake-session-claude.mjs")) + ");\n", { mode: 0o700 });
  const p = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd, env: { ...process.env, HOME: home, SHIM_SESSION_DIR: f.dir, PORT: String(port),
      CLAUDE_BIN: binary, SHIM_KEY: "test", FAKE_INPUTS: f.inputs, FAKE_RUNS: f.runs,
      TG_BOT_TOKEN: "", BARK_KEY: "", TIME_STAMP: "0", COMPACT_HOOK: "0", WINDOW_AUTO_ARCHIVE: "0", ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = ""; p.stdout.on("data", (d) => { logs += d; }); p.stderr.on("data", (d) => { logs += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch {}
    if (p.exitCode !== null) throw new Error(logs);
    await pause();
  }
  return {
    base, p,
    async stop() { if (p.exitCode !== null) return; const closed = new Promise((r) => p.once("exit", r)); p.kill(); await closed; },
    async health() { return (await fetch(base + "/health")).json(); },
    async hb() { return (await fetch(base + "/hb?key=test", { method: "POST" })).json(); },
    async send(text, id = text, stream = false, signal) {
      return fetch(base + "/messages", { method: "POST", signal, headers: { "x-api-key": "test", "content-type": "application/json", "idempotency-key": id },
        body: JSON.stringify({ stream, messages: [{ role: "user", content: text }] }) });
    },
  };
}
async function answer(s, text, id) {
  const res = await s.send(text, id);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.content[0].text;
}

test("idle restart and clean-container rebuild resume native history; heartbeat waits; retry is not sent twice", async () => {
  const f = setup(); let s;
  try {
    s = await start(f);
    assert.equal((await s.hb()).triggered, false);
    assert.equal(readLines(f.runs).length, 0);
    assert.equal(await answer(s, "remember:violet-731"), "ack:remember:violet-731");
    const id = JSON.parse(fs.readFileSync(path.join(f.dir, "state.json"))).sessionId;
    await s.stop();
    s = await start(f); // same runtime paths, no process state
    assert.equal((await s.hb()).triggered, false);
    assert.equal(await answer(s, "recall", "recall-1"), "violet-731");
    assert.equal(readLines(f.runs).at(-1).args.includes("--resume"), true);
    assert.equal(readLines(f.runs).at(-1).id, id);
    const duplicate = await s.send("recall", "recall-1");
    assert.equal(duplicate.status, 409);
    assert.equal(readLines(f.inputs).length, 2);
    await s.stop();
    fs.rmSync(path.join(f.temp, "home-1"), { recursive: true, force: true });
    s = await start(f, 2); // new HOME and cwd, only the volume remains
    assert.equal((await s.hb()).triggered, false);
    assert.equal(await answer(s, "recall", "recall-2"), "violet-731");
    assert.equal((await s.health()).session.phase, "ready");
  } finally { await s?.stop(); fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test("4.6 升到 1M 后保留原生历史，旧 Kelivo 模型名不会降回 200k", async () => {
  const f = setup(); let s;
  try {
    s = await start(f, 1, { BRAIN_MODEL: "claude-opus-4-6" });
    await answer(s, "remember:context-1m");
    const original = JSON.parse(fs.readFileSync(path.join(f.dir, "state.json"))).sessionId;
    await s.stop();
    s = await start(f, 2, { BRAIN_MODEL: "claude-opus-5-5", OPUS_46_CONTEXT: "1m", THINK_EFFORT_OVERRIDES: "claude-opus-4-6=medium" });
    assert.equal((await s.health()).model, "claude-opus-4-6[1m]");
    const response = await fetch(s.base + "/messages", { method: "POST", headers: { "x-api-key": "test", "content-type": "application/json" },
      body: JSON.stringify({ stream: false, model: "claude-opus-4-6", messages: [{ role: "user", content: "recall" }] }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, "context-1m");
    const run = readLines(f.runs).at(-1);
    assert.equal(run.id, original);
    assert.equal(run.args[run.args.indexOf("--model") + 1], "claude-opus-4-6[1m]");
    assert.equal(run.args[run.args.indexOf("--effort") + 1], "medium");
    const debug = await (await fetch(s.base + "/debug")).json();
    assert.equal(debug.window.configuredLimit, 967000);
    const login = await fetch(s.base + "/admin/window", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "key=test" });
    const page = await (await fetch(s.base + "/admin/window", { headers: { cookie: login.headers.get("set-cookie").split(";")[0] } })).text();
    assert.match(page, /一致 ✓/);
    assert.doesNotMatch(page, /不一致!/);
  } finally { await s?.stop(); fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test("interrupted message is uncertain, never replayed; restore discards unfinished native tail", async () => {
  const f = setup(); let s;
  try {
    s = await start(f);
    await answer(s, "remember:copper-412");
    const res = await s.send("CRASH", "crashed-message");
    assert.equal(res.status, 503);
    assert.equal((await s.health()).session.phase, "failed");
    assert.equal((await s.hb()).triggered, false);
    await pause(1700);
    assert.equal(readLines(f.runs).length, 1); // no automatic respawn loop
    await s.stop();
    s = await start(f, 2);
    assert.equal((await s.send("CRASH", "crashed-message")).status, 409);
    assert.equal(await answer(s, "recall", "after-crash"), "copper-412");
    const state = JSON.parse(fs.readFileSync(path.join(f.dir, "state.json")));
    assert.equal(state.requests[requestKey({}, "crashed-message")].status, "uncertain");
    const checkpoint = fs.readFileSync(path.join(f.dir, state.checkpoint), "utf8");
    assert.equal(checkpoint.includes('"CRASH"'), false);
    assert.equal(readLines(f.inputs).filter((s) => s === "CRASH").length, 1);
  } finally { await s?.stop(); fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test("wrong resumed session blocks output, new messages and heartbeat instead of accepting a blank window", async () => {
  const f = setup(); let s;
  try {
    s = await start(f); await answer(s, "remember:amber"); await s.stop();
    s = await start(f, 2, { FAKE_BAD_RESUME: "1" });
    assert.equal((await s.send("recall", "bad-resume")).status, 503);
    assert.equal((await s.send("hello", "blocked")).status, 503);
    assert.equal((await s.hb()).triggered, false);
    assert.equal(readLines(f.inputs).length, 2);
  } finally { await s?.stop(); fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test("SSE disconnect does not replace process; concurrent retry sends just one message", async () => {
  const f = setup(); let s;
  try {
    s = await start(f); await answer(s, "remember:pine-89");
    const cancel = new AbortController();
    const request = s.send("SLOW reply", "slow", true, cancel.signal).catch(() => null);
    for (let i = 0; i < 50 && readLines(f.inputs).length < 2; i++) await pause();
    const duplicate = await s.send("SLOW reply", "slow");
    assert.equal(duplicate.status, 409);
    cancel.abort(); await request;
    for (let i = 0; i < 50 && (await s.health()).busy; i++) await pause();
    assert.equal(await answer(s, "recall", "after-disconnect"), "pine-89");
    assert.equal(readLines(f.runs).length, 1);
    assert.equal(readLines(f.inputs).filter((s) => s === "SLOW reply").length, 1);
  } finally { await s?.stop(); fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test("corrupt checkpoint fails closed; missing checkpoint uses only confirmed history", async () => {
  const f = setup(); let s;
  try {
    s = await start(f); await answer(s, "remember:birch-95"); await s.stop();
    const state = JSON.parse(fs.readFileSync(path.join(f.dir, "state.json")));
    const file = path.join(f.dir, state.checkpoint), good = fs.readFileSync(file);
    fs.appendFileSync(file, "tampered\n");
    s = await start(f, 2);
    assert.equal((await s.send("recall", "corrupt")).status, 503);
    assert.equal((await s.health()).session.error, "checkpoint_checksum_failed");
    assert.equal(readLines(f.runs).length, 1);
    await s.stop(); fs.writeFileSync(file, good); fs.unlinkSync(file);
    s = await start(f, 3);
    await answer(s, "continue", "fallback");
    const run = readLines(f.runs).at(-1);
    assert.equal(run.args.includes("--resume"), false);
    const input = readLines(f.inputs).at(-1);
    assert.match(input, /confirmed previous user\/assistant conversation/);
    assert.match(input, /birch-95/);
    assert.equal(run.args.join("\n").includes("birch-95"), false, "recovery history stays out of argv");
    assert.equal((await s.health()).session.mode, "history");
  } finally { await s?.stop(); fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test("existing transcripts require explicit import; migration preserves source backup and volume files", () => {
  const f = setup();
  try {
    const projects = path.join(f.temp, "home/projects"), volume = path.join(f.dir, "projects/-src");
    fs.mkdirSync(path.join(projects, "-src"), { recursive: true }); fs.mkdirSync(volume, { recursive: true });
    fs.writeFileSync(path.join(projects, "-src/session.jsonl"), "source");
    fs.writeFileSync(path.join(volume, "session.jsonl"), "volume");
    prepareProjects(f.dir, projects);
    assert.equal(fs.readFileSync(path.join(volume, "session.jsonl"), "utf8"), "volume");
    assert.equal(fs.readFileSync(path.join(projects + ".before-session-recovery", "-src/session.jsonl"), "utf8"), "source");
    assert.throws(() => new SessionStore({ dir: f.dir }), /explicit_import/);
    prepareProjects(f.dir, projects); // idempotent
  } finally { fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test("retry key ignores appended partial assistant output and uses a stable supplied ID", () => {
  const original = { messages: [{ role: "user", content: "hello" }] };
  assert.equal(requestKey(original), requestKey({ messages: [...original.messages, { role: "assistant", content: "partial" }] }));
  assert.equal(requestKey(original, "id-1"), requestKey({ messages: [{ role: "user", content: "changed serialization" }] }, "id-1"));
});

test("recovery holds subsequent input and heartbeat until the first result is committed", async () => {
  const f = setup(); let s;
  try {
    s = await start(f);
    const first = s.send("SLOW first", "first");
    for (let i = 0; i < 50 && readLines(f.inputs).length < 1; i++) await pause();
    const second = s.send("second", "second");
    assert.equal((await s.hb()).triggered, false);
    await pause(50);
    assert.deepEqual(readLines(f.inputs), ["SLOW first"]);
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    assert.deepEqual(readLines(f.inputs), ["SLOW first", "second"]);
    assert.equal((await s.health()).session.phase, "ready");
  } finally { await s?.stop(); fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test("an imported native conversation cannot silently fall back to only its later HTTP pairs", () => {
  const f = setup();
  try {
    const id = "a2000000-0000-4000-8000-000000000001";
    const file = path.join(f.dir, "projects/-src", id + ".jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows = [
      { type: "user", sessionId: id, message: { content: "pre-existing history" } },
      { type: "assistant", sessionId: id, message: { content: "confirmed response", stop_reason: "end_turn" } },
    ];
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r) + "\n").join(""));
    const store = new SessionStore({ dir: f.dir, allowImport: true });
    store.importNative(file);
    assert.equal(store.restore().kind, "native");
    assert.throws(() => store.importNative(file), /new_state/);
    fs.unlinkSync(path.join(f.dir, store.state.checkpoint));
    store.state.history.push({ user: "later input", assistant: "later reply" });
    assert.throws(() => store.restore(), /confirmed_history_unavailable/);
  } finally { fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test("corrupt saved JSON produces an explicit code without logging private contents", () => {
  const f = setup();
  try {
    fs.mkdirSync(f.dir, { recursive: true });
    fs.writeFileSync(path.join(f.dir, "state.json"), '{"private":"sensitive-fragment" BROKEN}');
    assert.throws(() => new SessionStore({ dir: f.dir }), { message: "session_state_invalid_json" });
  } finally { fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test("an impersonated empty round resets instead of locking up; its exact resend is admitted and the window survives", async () => {
  const f = setup(); let s;
  try {
    s = await start(f);
    assert.equal(await answer(s, "remember:ember-442"), "ack:remember:ember-442");
    const dead = await s.send("DEAD_NOW", "dead-1");
    assert.equal(dead.status, 503);
    assert.match((await dead.json()).error.message, /\u91cd\u53d1/); // tells her to resend
    assert.equal((await s.health()).session.phase, "pending");    // reset, not failed
    assert.equal((await s.health()).ok, true);                    // not an outage
    assert.equal((await s.hb()).triggered, false);                // internal rounds stay gated
    assert.equal(await answer(s, "recall", "dead-1"), "ember-442"); // same ID admitted; window intact
    assert.equal(readLines(f.runs).at(-1).args.includes("--resume"), true);
  } finally { await s?.stop(); fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test("SDK success+is_error is recoverable, reports the API reason, and preserves the confirmed window", async () => {
  const f = setup(); let s;
  try {
    s = await start(f);
    assert.equal(await answer(s, "remember:cedar-551"), "ack:remember:cedar-551");
    const failed = await s.send("API_ERROR_NOW", "api-error-1");
    assert.equal(failed.status, 503);
    assert.match((await failed.json()).error.message, /mock upstream rate limit/);
    assert.equal((await s.health()).session.phase, "pending");
    assert.equal((await s.health()).ok, true);
    assert.equal(await answer(s, "recall", "api-error-1"), "cedar-551", "同一请求 ID 可重发且旧窗口未丢");
    assert.equal(readLines(f.runs).at(-1).args.includes("--resume"), true);
    const state = JSON.parse(fs.readFileSync(path.join(f.dir, "state.json")));
    const checkpoint = fs.readFileSync(path.join(f.dir, state.checkpoint), "utf8");
    assert.equal(checkpoint.includes("API_ERROR_NOW"), false, "失败轮不得进入确认存档点");
  } finally { await s?.stop(); fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test("prompt-too-long retires the oversized checkpoint and safely hands confirmed history to a fresh native session", async () => {
  const f = setup(); let s;
  try {
    s = await start(f);
    assert.equal(await answer(s, "remember:willow-884"), "ack:remember:willow-884");
    const before = JSON.parse(fs.readFileSync(path.join(f.dir, "state.json")));
    const failed = await s.send("PROMPT_TOO_LONG_NOW", "too-long-1");
    assert.equal(failed.status, 503);
    assert.match((await failed.json()).error.message, /安全续接|已保留备份/);
    assert.equal((await s.health()).session.phase, "pending");

    const rolled = JSON.parse(fs.readFileSync(path.join(f.dir, "state.json")));
    assert.equal(rolled.sessionId, null);
    assert.equal(rolled.checkpoint, null);
    assert.ok(rolled.handoff.entries.length > 0);
    assert.ok(rolled.retiredCheckpoints.includes(before.checkpoint));
    assert.ok(fs.existsSync(path.join(f.dir, before.checkpoint)), "old checkpoint remains recoverable");

    await s.stop();
    // Production had 152 KiB of confirmed tail. That exceeds Linux's ~128 KiB
    // per-argument exec ceiling, so this specifically guards the E2BIG outage.
    const durable = JSON.parse(fs.readFileSync(path.join(f.dir, "state.json")));
    durable.handoff.entries = [
      ...Array.from({ length: 900 }, (_, i) => ({ user: `past-user-${i}-` + "u".repeat(55), assistant: "a".repeat(55) })),
      ...durable.handoff.entries,
    ];
    const handoffSize = JSON.stringify(durable.handoff.entries).length;
    assert.ok(handoffSize > 131072 && handoffSize < 200000, `realistic oversized argv fixture: ${handoffSize}`);
    fs.writeFileSync(path.join(f.dir, "state.json"), JSON.stringify(durable) + "\n");
    s = await start(f, 2); // the handoff itself must survive a container restart
    assert.equal(await answer(s, "continue", "too-long-1"), "ack:continue", "same request ID is admitted");
    const run = readLines(f.runs).at(-1);
    assert.equal(run.args.includes("--resume"), false, "oversized native session is not retried forever");
    assert.ok(Math.max(...run.args.map((s) => s.length)) < 131072, "no CLI argument can trigger E2BIG");
    const input = readLines(f.inputs).at(-1);
    assert.match(input, /previous native session exceeded/);
    assert.match(input, /willow-884/);
    assert.doesNotMatch(input, /PROMPT_TOO_LONG_NOW/, "failed input is not included in the handoff");
    assert.match(input, /\[Current user message\]\ncontinue$/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, "state.json"))).handoff, undefined,
      "successful native checkpoint now owns the handoff, so it is not injected twice");
    assert.equal((await s.health()).session.phase, "ready");
  } finally { await s?.stop(); fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test("legacy handoffs are serialized-size bounded and a still-too-long recovery halves itself without locking", async () => {
  const f = setup(); let s;
  try {
    fs.mkdirSync(f.dir, { recursive: true });
    const entries = Array.from({ length: 900 }, (_, i) => ({
      user: `past-user-${i}-` + "u".repeat(40),
      assistant: "a".repeat(40),
    }));
    assert.ok(JSON.stringify(entries).length > HANDOFF_MAX_CHARS);
    fs.writeFileSync(path.join(f.dir, "state.json"), JSON.stringify({
      version: 1, sessionId: null, checkpoint: null, history: [], historyComplete: true,
      requests: {}, context: {}, handoff: { reason: "legacy_prompt_too_long", at: Date.now(), entries },
    }) + "\n");

    s = await start(f, 1, { FAKE_MAX_INPUT_CHARS: "35000" });
    const migrated = JSON.parse(fs.readFileSync(path.join(f.dir, "state.json")));
    const migratedChars = JSON.stringify(migrated.handoff.entries).length;
    assert.ok(migratedChars <= HANDOFF_MAX_CHARS, `startup bound: ${migratedChars}`);

    const first = await s.send("continue", "adaptive-handoff");
    assert.equal(first.status, 503);
    assert.match((await first.json()).error.message, /自动缩小/);
    assert.equal((await s.health()).session.phase, "pending");
    assert.equal((await s.health()).ok, true);

    const reduced = JSON.parse(fs.readFileSync(path.join(f.dir, "state.json")));
    const reducedChars = JSON.stringify(reduced.handoff.entries).length;
    assert.ok(reducedChars < migratedChars && reducedChars <= Math.floor(migratedChars / 2));
    assert.equal(reduced.requests[requestKey({}, "adaptive-handoff")], undefined,
      "the rejected recovery input can be resent with the exact same ID");

    assert.equal(await answer(s, "continue", "adaptive-handoff"), "ack:continue");
    const inputs = readLines(f.inputs);
    assert.ok(inputs.at(-2).length > 35000);
    assert.ok(inputs.at(-1).length < 35000);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, "state.json"))).handoff, undefined);
    assert.equal((await s.health()).session.phase, "ready");
  } finally { await s?.stop(); fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test("durable state is pruned: oversized fallback history is trimmed and stale request IDs expire", () => {
  const state = { history: [], historyComplete: true, requests: {
    old: { status: "completed", at: 1 },
    fresh: { status: "completed", at: Date.now() },
    stuck: { status: "inflight", at: 1 },
  } };
  for (let i = 0; i < 40; i++) state.history.push({ user: "u".repeat(5000), assistant: "a".repeat(5000) });
  pruneState(state);
  assert.ok(state.history.length > 0 && state.history.length < 40, "keeps only a recent tail");
  assert.ok(JSON.stringify(state.history).length <= 200001, "bounded size");
  assert.equal(state.historyComplete, false, "a trimmed history is no longer complete");
  assert.deepEqual(Object.keys(state.requests).sort(), ["fresh", "stuck"], "expired completed IDs removed; inflight kept");
});

async function sessionAdmin(s) {
  const login = await fetch(s.base + "/admin/session/login", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "key=test" });
  assert.equal(login.status, 303);
  assert.match(login.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Strict/);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  return {
    async form() {
      const res = await fetch(s.base + "/admin/session", { headers: { cookie } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const html = await res.text();
      return { csrf: html.match(/name="csrf" value="([^"]+)"/)[1], revision: html.match(/name="revision" value="([^"]+)"/)[1] };
    },
    post(form, fields = {}, extraHeaders = {}) {
      return fetch(s.base + "/admin/session/action", { method: "POST", redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...extraHeaders },
        body: new URLSearchParams({ ...form, ...fields }) });
    },
  };
}

test("session controls require authentication, CSRF, confirmation, current state and an idle runtime", async () => {
  const f = setup(); let s;
  try {
    s = await start(f);
    assert.equal((await fetch(s.base + "/admin/session?key=test")).status, 401);
    assert.equal((await fetch(s.base + "/admin/session/action", { method: "POST" })).status, 401);
    const admin = await sessionAdmin(s);
    let form = await admin.form();
    assert.equal(readLines(f.runs).length, 0); // Opening the page does not start Claude.
    assert.equal((await admin.post({ ...form, csrf: "forged" }, { action: "restart" })).status, 403);
    form = await admin.form();
    assert.equal((await admin.post(form, { action: "fresh", model: "claude-opus-4-6", effort: "medium" })).status, 400);
    form = await admin.form();
    assert.equal((await admin.post(form, { action: "restart" }, { origin: "https://other.example" })).status, 403);
    assert.equal((await admin.post(form, { action: "fresh", confirm: "yes", model: "--bad-model", effort: "medium" })).status, 400);
    form = await admin.form();
    await answer(s, "remember:guarded");
    assert.equal((await admin.post(form, { action: "restart" })).status, 409); // Old tab cannot act on newer chat.
    form = await admin.form();
    const pending = s.send("SLOW busy");
    for (let i = 0; i < 30 && !(await s.health()).busy; i++) await pause(5);
    assert.equal((await s.health()).busy, true);
    assert.equal((await admin.post(form, { action: "fresh", confirm: "yes", model: "claude-opus-4-6", effort: "medium" })).status, 409);
    assert.equal((await pending).status, 200);
    assert.equal(fs.existsSync(path.join(f.dir, "retired")), false);
    assert.equal(await answer(s, "recall"), "guarded");
  } finally { await s?.stop(); fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test("session restart resumes history; fresh backs it up and persists selected model/effort across container rebuild", async () => {
  const f = setup(); let s;
  const env = { OPUS_46_CONTEXT: "1m", BRAIN_MODELS: "claude-opus-4-6,claude-opus-5-5" };
  try {
    s = await start(f, 1, env);
    await answer(s, "remember:retained", "old-message");
    const readState = () => JSON.parse(fs.readFileSync(path.join(f.dir, "state.json")));
    const id = readState().sessionId;
    let admin = await sessionAdmin(s);
    const restartForm = await admin.form();
    assert.equal((await admin.post(restartForm, { action: "restart" })).status, 303);
    assert.equal((await s.health()).session.phase, "pending");
    assert.equal((await s.hb()).triggered, false);
    assert.equal(readLines(f.inputs).length, 1);
    assert.equal((await admin.post(restartForm, { action: "restart" })).status, 403);
    assert.equal(await answer(s, "recall", "after-ui-restart"), "retained");
    assert.equal(readState().sessionId, id);
    const before = readState();
    const freshForm = await admin.form();
    assert.equal((await admin.post(freshForm, { action: "fresh", confirm: "yes", model: "claude-opus-5-5", effort: "medium" })).status, 303);
    assert.equal(readState().sessionId, null);
    assert.deepEqual(readState().history, []);
    assert.equal(readState().handoff, undefined);
    assert.deepEqual(readState().selection, { model: "claude-opus-5-5", effort: "medium" });
    const backups = fs.readdirSync(path.join(f.dir, "retired"));
    assert.equal(backups.length, 1);
    const backup = path.join(f.dir, "retired", backups[0]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backup, "state.json"))), before);
    assert.equal(fs.readFileSync(path.join(backup, before.checkpoint), "utf8"), fs.readFileSync(path.join(backup, "native.jsonl"), "utf8"));
    assert.equal(fs.statSync(path.join(backup, "state.json")).mode & 0o777, 0o600);
    assert.equal((await s.hb()).triggered, false);
    const inputs = readLines(f.inputs).length;
    await admin.form();
    assert.equal(readLines(f.inputs).length, inputs);
    await s.stop();
    s = await start(f, 2, env);
    assert.equal((await s.health()).model, "claude-opus-5-5");
    const res = await fetch(s.base + "/messages", { method: "POST", headers: { "x-api-key": "test", "content-type": "application/json", "idempotency-key": "fresh-recall" },
      body: JSON.stringify({ stream: false, model: "claude-opus-4-6", messages: [{ role: "user", content: "recall" }] }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.model, "claude-opus-5-5");
    assert.equal(body.content[0].text, "UNKNOWN"); // Old private history was not injected into the fresh session.
    assert.notEqual(readState().sessionId, id);
    const run = readLines(f.runs).at(-1);
    assert.equal(run.args[run.args.indexOf("--model") + 1], "claude-opus-5-5");
    assert.equal(run.args[run.args.indexOf("--effort") + 1], "medium");
    assert.equal(run.args.includes("--resume"), false);
    assert.equal((await s.send("remember:retained", "old-message")).status, 409); // Late retries stay deduplicated.
    await answer(s, "new-turn-1"); await answer(s, "new-turn-2");
    assert.equal(fs.existsSync(path.join(backup, before.checkpoint)), true); // Active checkpoint pruning cannot touch backup.
    assert.deepEqual(readState().selection, { model: "claude-opus-5-5", effort: "medium" });
    admin = await sessionAdmin(s);
    const form = await admin.form();
    assert.equal((await admin.post(form, { action: "fresh", confirm: "yes", model: "claude-opus-4-6", effort: "high" })).status, 303);
    assert.equal((await s.health()).model, "claude-opus-4-6[1m]");
    assert.equal((await (await fetch(s.base + "/debug")).json()).window.limit, 967000);
  } finally { await s?.stop(); fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test("backup failure preserves active session; corrupt saved history is never silently cleared by restart", async () => {
  const f = setup(); let s;
  try {
    s = await start(f);
    await answer(s, "remember:backup-failure");
    const before = fs.readFileSync(path.join(f.dir, "state.json"), "utf8");
    fs.writeFileSync(path.join(f.dir, "retired"), "simulate an unwritable backup path");
    const admin = await sessionAdmin(s);
    assert.equal((await admin.post(await admin.form(), { action: "fresh", confirm: "yes", model: "claude-opus-4-6", effort: "medium" })).status, 503);
    assert.equal(fs.readFileSync(path.join(f.dir, "state.json"), "utf8"), before);
    assert.equal((await s.health()).session.phase, "ready");
    assert.equal(await answer(s, "recall"), "backup-failure");
    const state = JSON.parse(fs.readFileSync(path.join(f.dir, "state.json")));
    fs.writeFileSync(path.join(f.dir, state.checkpoint), "damaged-checkpoint\n");
    assert.equal((await admin.post(await admin.form(), { action: "restart" })).status, 503);
    assert.equal((await s.health()).session.phase, "failed");
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, "state.json"))).sessionId, state.sessionId);
  } finally { await s?.stop(); fs.rmSync(f.temp, { recursive: true, force: true }); }
});
