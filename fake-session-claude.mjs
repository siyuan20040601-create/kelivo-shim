#!/usr/bin/env node
// Deterministic native-session fixture. No API calls or real conversation data.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
const args = process.argv.slice(2);
if (args.includes("--help")) { console.log("--resume <session-id> --session-id <uuid> --system-prompt <text>"); process.exit(0); }
const projects = path.join(process.env.HOME, ".claude", "projects");
const dir = path.join(projects, process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;
const id = process.env.FAKE_BAD_RESUME ? randomUUID() : (resume || randomUUID());
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, id + ".jsonl");
let history = [];
if (resume && !process.env.FAKE_BAD_RESUME) {
  if (!fs.existsSync(file)) { console.log(JSON.stringify({ type: "result", subtype: "error_resume", is_error: true, session_id: id })); process.exit(1); }
  history = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
}
if (process.env.FAKE_RUNS) fs.appendFileSync(process.env.FAKE_RUNS, JSON.stringify({ args, id }) + "\n");
const emit = (e) => console.log(JSON.stringify(e));
const row = (type, content) => ({ type, uuid: randomUUID(), sessionId: id, message: { role: type, content, stop_reason: type === "assistant" ? "end_turn" : null } });
const append = (r) => { history.push(r); fs.appendFileSync(file, JSON.stringify(r) + "\n"); };
const rl = readline.createInterface({ input: process.stdin });
let init = false;
rl.on("line", (line) => {
  const input = JSON.parse(line).message.content;
  const text = typeof input === "string" ? input : input.find((b) => b.type === "text")?.text || "";
  if (process.env.FAKE_INPUTS) fs.appendFileSync(process.env.FAKE_INPUTS, JSON.stringify(text) + "\n");
  if (!init) { init = true; emit({ type: "system", subtype: "init", session_id: id }); }
  append(row("user", input));
  if (text === "CRASH") { setTimeout(() => process.exit(2), 15); return; }
  const known = history.filter((r) => r.type === "user").map((r) => r.message.content).find((s) => typeof s === "string" && s.startsWith("remember:"));
  const output = text === "recall" ? (known?.slice(9) || "UNKNOWN") : "ack:" + text;
  setTimeout(() => {
    append(row("assistant", [{ type: "text", text: output }]));
    emit({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 30 } } } });
    emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: output } } });
    emit({ type: "result", subtype: "success", session_id: id, usage: { output_tokens: 4 } });
  }, text.startsWith("SLOW") ? 250 : 10);
});
