import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { SessionStore, prepareProjects, requestKey, pruneState } from "../session-state.js";
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
    const prompt = run.args[run.args.indexOf("--append-system-prompt") + 1];
    assert.match(prompt, /confirmed previous user\/assistant conversation/);
    assert.match(prompt, /birch-95/);
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
