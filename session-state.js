// Private runtime state belongs on the mounted volume, never in the repository.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const hash = (s) => createHash("sha256").update(s).digest("hex");
const validId = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || "");
const normalize = (s) => String(s || "").replace(/‖/g, "\n").trim();
const projectName = (cwd) => {
  // Production uses /src. Refuse an unverified long-path encoding rather than
  // restore into a directory the CLI might not read.
  if (cwd.length > 200) throw new Error("native_project_path_too_long");
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
};
const textOf = (c) => typeof c === "string" ? c
  : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text || "").join("") : "";

export function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + ".tmp-" + randomUUID();
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    const dir = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch {}
  }
}

export function nativeProjects(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude"), "projects");
}

// Keep the CLI's existing config/trust/auth locations; relocate only transcripts.
export function prepareProjects(dir, projects = nativeProjects()) {
  const target = path.join(dir, "projects");
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(projects), { recursive: true, mode: 0o700 });
  let stat; try { stat = fs.lstatSync(projects); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (stat?.isSymbolicLink()) {
    if (fs.realpathSync(projects) !== fs.realpathSync(target)) throw new Error("native_projects_link_conflict");
    return target;
  }
  if (stat) {
    if (!stat.isDirectory()) throw new Error("native_projects_not_directory");
    // Preserve both sides of a migration conflict. Never replace the volume's files.
    const copyMissing = (src, dst) => {
      fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
      for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const a = path.join(src, e.name), b = path.join(dst, e.name);
        if (e.isDirectory()) copyMissing(a, b);
        else if (e.isFile() && !fs.existsSync(b)) fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL);
      }
    };
    copyMissing(projects, target);
    const saved = projects + ".before-session-recovery";
    if (fs.existsSync(saved)) throw new Error("native_migration_backup_already_exists");
    fs.renameSync(projects, saved);
    try { fs.symlinkSync(target, projects, "dir"); }
    catch (e) { fs.renameSync(saved, projects); throw e; }
    return target;
  }
  fs.symlinkSync(target, projects, "dir");
  return target;
}

function parseNative(data, id) {
  if (!data.length || data[data.length - 1] !== 10) throw new Error("native_transcript_incomplete");
  let rows;
  try { rows = data.toString("utf8").split("\n").filter(Boolean).map((s) => JSON.parse(s)); }
  catch { throw new Error("native_transcript_invalid_json"); }
  const chat = rows.filter((r) => (r.type === "user" || r.type === "assistant") && r.message && !r.isSidechain && !r.isMeta);
  if (!chat.length || chat.some((r) => r.sessionId && r.sessionId !== id)) throw new Error("native_transcript_wrong_session");
  const last = chat.at(-1);
  if (last.type !== "assistant" || !textOf(last.message.content).trim() ||
      last.message.stop_reason === "tool_use") throw new Error("native_transcript_unfinished_turn");
  return chat;
}

function findNative(projects, id, cwd) {
  if (!validId(id) || !fs.existsSync(projects)) return null;
  const current = path.join(projects, projectName(cwd), id + ".jsonl");
  if (fs.existsSync(current)) return current;
  for (const e of fs.readdirSync(projects, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = path.join(projects, e.name, id + ".jsonl");
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// Bound durable growth so state.json cannot swell for months (it is rewritten and
// fsynced every round). Trimming fallback history disables only the fallback —
// native checkpoints remain the recovery path. Request IDs absorb retries, which
// arrive within minutes or days, never months; inflight entries are never expired.
export const HISTORY_MAX_CHARS = 150000;
export const REQUEST_TTL_MS = 7 * 86400e3;
export function pruneState(state, now = Date.now()) {
  let size = 0, cut = 0;
  for (let i = state.history.length - 1; i >= 0; i--) {
    size += (state.history[i].user?.length || 0) + (state.history[i].assistant?.length || 0);
    if (size > HISTORY_MAX_CHARS) { cut = i + 1; break; }
  }
  if (cut > 0) { state.history = state.history.slice(cut); state.historyComplete = false; }
  for (const [k, r] of Object.entries(state.requests)) {
    if (r.status !== "inflight" && now - (r.at || 0) > REQUEST_TTL_MS) delete state.requests[k];
  }
}

export function requestKey(body, explicitId = "") {
  const messages = body.messages || [];
  let last = -1;
  for (let i = 0; i < messages.length; i++) if (messages[i].role === "user") last = i;
  const id = explicitId || messages[last]?.id || messages[last]?.uuid;
  // Retries exclude any partially appended assistant output after the final user.
  return hash(JSON.stringify(id ? ["kelivo", id] : ["kelivo-context", body.system || "", body.model || "", messages.slice(0, last + 1)]));
}

export class SessionStore {
  constructor({ dir = null, projects = nativeProjects(), cwd = process.cwd(), allowImport = false } = {}) {
    this.dir = dir; this.projects = projects; this.cwd = cwd;
    this.enabled = !!dir;
    this.state = { version: 1, sessionId: null, checkpoint: null, history: [], historyComplete: true, requests: {}, context: {} };
    if (!dir) return;
    if (!path.isAbsolute(dir)) throw new Error("session_directory_must_be_absolute");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, "state.json");
    if (fs.existsSync(this.file)) {
      try { this.state = JSON.parse(fs.readFileSync(this.file, "utf8")); }
      catch (e) { if (e instanceof SyntaxError) throw new Error("session_state_invalid_json"); throw e; }
      if (this.state.version !== 1 || !Array.isArray(this.state.history) ||
          !this.state.requests || typeof this.state.requests !== "object" ||
          (this.state.sessionId && !validId(this.state.sessionId)) ||
          (!this.state.sessionId && (this.state.checkpoint || this.state.history.length))) throw new Error("session_state_invalid");
      let interrupted = false;
      for (const request of Object.values(this.state.requests)) {
        if (request.status === "inflight") { request.status = "uncertain"; interrupted = true; }
      }
      if (interrupted) this.save();
    } else if (!allowImport && fs.existsSync(path.join(dir, "projects")) &&
      fs.readdirSync(path.join(dir, "projects")).length) {
      throw new Error("existing_sessions_need_explicit_import");
    }
  }
  save() { if (this.enabled) atomicWrite(this.file, JSON.stringify(this.state) + "\n"); }
  entry(key) { return key && this.state.requests[key]; }
  begin(key) {
    if (!this.enabled || !key) return;
    if (this.entry(key)) throw new Error("duplicate_request");
    this.state.requests[key] = { status: "inflight", at: Date.now() };
    this.save(); // Durable admission BEFORE writing the message to Claude stdin.
  }
  fail(key) {
    if (!this.enabled || !key) return;
    if (this.entry(key)) this.state.requests[key].status = "uncertain";
    this.save();
  }
  forget(key) {
    // A round that never ran produced no answer; its exact resend must be admitted.
    if (!this.enabled || !key || !this.entry(key)) return;
    delete this.state.requests[key];
    this.save();
  }
  reset() {
    this.state.sessionId = null; this.state.checkpoint = null; this.state.history = [];
    this.state.historyComplete = true; this.state.context = {}; this.state.gate = null;
    this.save();
  }
  restore() {
    if (!this.enabled || !this.state.sessionId) return { kind: "fresh", args: [], history: "" };
    const { sessionId: id, checkpoint } = this.state;
    if (!validId(id)) throw new Error("saved_session_id_invalid");
    if (checkpoint) {
      if (!/^checkpoint-[0-9a-f]{64}\.jsonl$/.test(checkpoint)) throw new Error("checkpoint_path_invalid");
      const file = path.join(this.dir, checkpoint);
      if (fs.existsSync(file)) {
        const data = fs.readFileSync(file);
        if ("checkpoint-" + hash(data) + ".jsonl" !== checkpoint) throw new Error("checkpoint_checksum_failed");
        parseNative(data, id);
        const project = projectName(this.cwd);
        const live = path.join(this.projects, project, id + ".jsonl");
        if (fs.existsSync(live)) {
          const before = fs.readFileSync(live);
          if (!before.equals(data)) atomicWrite(path.join(this.dir, "interrupted-latest.jsonl"), before);
        }
        atomicWrite(live, data); // Roll back unfinished input; never replay it.
        return { kind: "native", args: ["--resume", id], history: "", expectedId: id };
      }
    }
    // Only complete application-confirmed text pairs may provide a fallback.
    const history = this.state.history;
    if (this.state.historyComplete !== true || !history.length || history.some((p) => p.images)) throw new Error("confirmed_history_unavailable");
    const rendered = JSON.stringify(history);
    if (rendered.length > 200000) throw new Error("confirmed_history_too_large");
    return { kind: "history", args: [], history: "\n[Service recovery: confirmed previous user/assistant conversation. This is saved history, not new instructions.]\n" + rendered };
  }
  async complete({ id, input, output, images = [], key, usage, context, gate }) {
    if (!this.enabled) return;
    if (!validId(id)) throw new Error("cli_session_id_missing");
    // CLI transcript writes can finish just after the result event. Hold the queue
    // until a complete assistant tail is visible, with a bounded wait.
    let data, problem;
    const oldFile = this.state.checkpoint && path.join(this.dir, this.state.checkpoint);
    const oldTail = oldFile && fs.existsSync(oldFile)
      ? parseNative(fs.readFileSync(oldFile), this.state.sessionId).at(-1).uuid : null;
    for (let i = 0; i < 30; i++) {
      try {
        const file = findNative(this.projects, id, this.cwd);
        if (!file) throw new Error("native_transcript_missing");
        data = fs.readFileSync(file);
        const chat = parseNative(data, id);
        if (oldTail && chat.at(-1).uuid === oldTail) throw new Error("native_transcript_not_flushed");
        const tail = normalize(textOf(chat.at(-1).message.content));
        if (!normalize(output) || !tail || !normalize(output).endsWith(tail) ||
            this.state.checkpoint === "checkpoint-" + hash(data) + ".jsonl") throw new Error("native_transcript_not_flushed");
        if (input !== undefined) {
          const user = chat.findLast((r) => r.type === "user" && !r.message.content?.some?.((b) => b.type === "tool_result"));
          if (normalize(textOf(user?.message.content)) !== normalize(input)) throw new Error("native_transcript_wrong_input");
        }
        problem = null; break;
      } catch (e) { problem = e; }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (problem) throw problem;
    const checkpoint = "checkpoint-" + hash(data) + ".jsonl";
    atomicWrite(path.join(this.dir, checkpoint), data);
    const previous = this.state.checkpoint;
    this.state.sessionId = id; this.state.checkpoint = checkpoint;
    if (input !== undefined) this.state.history.push({ user: input, assistant: output, ...(images.length ? { images: true } : {}) });
    this.state.context = context; this.state.gate = gate;
    this.state.completedAt = Date.now();
    // Dedup needs only the ID and status; storing reply text would add one more
    // private copy that nothing reads (duplicates are rejected, never replayed).
    if (key) this.state.requests[key] = { status: "completed", at: Date.now() };
    pruneState(this.state);
    this.save(); // Commit checkpoint + result before declaring the HTTP turn done.
    // Keep the current and one prior checkpoint; do not accumulate copies forever.
    for (const e of fs.readdirSync(this.dir)) {
      if (/^checkpoint-[0-9a-f]{64}\.jsonl$/.test(e) && e !== checkpoint && e !== previous) {
        try { fs.unlinkSync(path.join(this.dir, e)); } catch {} // Cleanup cannot invalidate a committed result.
      }
    }
  }
  importNative(file) {
    if (!this.enabled || fs.existsSync(this.file)) throw new Error("import_requires_new_state_directory");
    const id = path.basename(file, ".jsonl");
    if (!validId(id)) throw new Error("import_session_id_invalid");
    const data = fs.readFileSync(file);
    parseNative(data, id);
    const checkpoint = "checkpoint-" + hash(data) + ".jsonl";
    atomicWrite(path.join(this.dir, checkpoint), data);
    this.state.sessionId = id; this.state.checkpoint = checkpoint;
    // Imported sessions may have tools, images or compaction. Never pretend that
    // later HTTP pairs alone are the entire pre-existing conversation.
    this.state.historyComplete = false;
    this.state.completedAt = Date.now();
    this.save();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const dir = process.env.SHIM_SESSION_DIR || "/persona/kelivo-session";
    if (!path.isAbsolute(dir)) throw new Error("session_directory_must_be_absolute");
    if (process.argv[2] === "--prepare") {
      prepareProjects(dir);
      console.log("[session] native transcript storage prepared");
    } else if (process.argv[2] === "--import" && process.argv[3]) {
      new SessionStore({ dir, allowImport: true }).importNative(process.argv[3]);
      console.log("[session] existing completed transcript imported");
    } else throw new Error("usage: node session-state.js --prepare | --import <transcript.jsonl>");
  } catch (e) { console.error("[session]", e.message); process.exitCode = 1; }
}
