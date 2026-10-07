// window-threshold-state.js — 85%/90% 的「提醒过没有/归档过没有」按会话持久化。
//
// 为什么需要:有了会话恢复(session-state.js)之后,重启回来的是**同一个窗口**,
// 但 windowWarned / windowAutoArchived 原来只活在内存里 —— 一重启就忘,同一窗
// 会被重复提醒、重复归档。所以这两个标记按原生会话 UUID 存进持久卷:
// 恢复同一会话 → 标记还在,不重复动作;收到真实 compact_boundary → 该会话重置。
//
// 文件只存 { "<sessionId>": { warned, archived } },没有任何对话内容。
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_THRESHOLD_FILE = "/persona/kelivo-session/window-thresholds.json";
const MAX_SESSIONS = 20; // 只留最近的几个会话,旧的没意义

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + ".tmp-" + randomUUID();
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* rename 后已不在 */ }
  }
}

export class ThresholdState {
  // file=null(没配持久卷/旧模式)→ 全部内存行为,和改动前一模一样。
  constructor(file = null, log = () => {}) {
    this.file = file;
    this.log = log;
    this.all = {};
    if (!file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") this.all = parsed;
    } catch (e) {
      if (e.code !== "ENOENT") this.log("[threshold] 读取失败,按全新处理:", e.message);
    }
  }
  get(sessionId) {
    const s = sessionId && this.all[sessionId];
    return { warned: !!s?.warned, archived: !!s?.archived };
  }
  set(sessionId, patch) {
    if (!sessionId) return;
    this.all[sessionId] = { ...this.get(sessionId), ...patch, at: Date.now() };
    this.save();
  }
  reset(sessionId) {
    if (!sessionId || !this.all[sessionId]) return;
    delete this.all[sessionId];
    this.save();
  }
  save() {
    if (!this.file) return;
    const ids = Object.keys(this.all);
    if (ids.length > MAX_SESSIONS) {
      ids.sort((a, b) => (this.all[a].at || 0) - (this.all[b].at || 0));
      for (const id of ids.slice(0, ids.length - MAX_SESSIONS)) delete this.all[id];
    }
    try { atomicWrite(this.file, JSON.stringify(this.all) + "\n"); }
    catch (e) { this.log("[threshold] 写入失败(不影响运行):", e.message); }
  }
}
