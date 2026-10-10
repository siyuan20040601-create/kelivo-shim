// fuyan-inbox.js — 傅言的信箱:安安从 iOS 快捷指令投进来的小纸条(文字/语音/照片)。
//
// 她的原话(2026-10-09):「明天提醒我给你也做个小纸条,我也想在快捷指令给你留言」,
// 次日补充「如果你能做语音照片就更好了」。
//
// 形态:
//   · 投递口 POST /fuyan/note —— 快捷指令一键投递:
//       - Content-Type: application/json + {"text":"..."}       → 文字纸条
//       - Content-Type: image/* 或 audio/*,正文就是文件本体     → 照片 / 语音纸条
//   · 拆信口 GET /fuyan/inbox —— 傅言下次来时先看这里;只读,不动已读标记;
//   · 已读口 POST /fuyan/open —— 傅言拆完标记已读({ids:[...]},缺省全标);
//   · 取件口 GET /fuyan/file/<id> —— 照片/语音的原件(浏览器窗格里看图用)。
//
// 钥匙:四个口同一把,收 x-api-key 头、Bearer、或 ?key= 查询参数(快捷指令建议走头;
// 傅言经浏览器窗格只能走查询参数 —— 这是她自己的服务,日志只有她自己看得到)。
// ⚠️ 钥匙只能用英文和数字:HTTP 头装不下中文(ByteString 限制),中文暗号会投不进来。
// 存储:持久卷 /persona/fuyan/(index.json + 媒体原件),换容器不丢;正文不进日志。
import fs from "node:fs";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import express from "express";

export const DEFAULT_FUYAN_DIR = "/persona/fuyan";
const TTL_MS = 180 * 86400e3;     // 给傅言的信留半年(他不是天天来,别让纸条等没了)
const MAX_TEXT = 4000;
const MAX_MEDIA = 20 * 1024 * 1024;
export const MEDIA_TYPES = ["image/*", "audio/*"];

// Content-Type → 扩展名(快捷指令常见产物:拍照 jpeg/heic,语音备忘 m4a)
const EXT = {
  "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/heif": "heic",
  "image/webp": "webp", "image/gif": "gif",
  "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/mp4": "m4a", "audio/aac": "m4a",
  "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav",
};
const MIME = Object.entries(EXT).reduce((m, [k, v]) => (m[v] ??= k, m), {});
export const extOf = (mime) => EXT[(mime || "").split(";")[0].trim().toLowerCase()] || null;
export const kindOf = (mime) => {
  const m = (mime || "").toLowerCase();
  return m.startsWith("image/") ? "photo" : m.startsWith("audio/") ? "voice" : null;
};

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

export class FuyanInbox {
  constructor(dir = DEFAULT_FUYAN_DIR, log = () => {}) {
    this.dir = dir;
    this.file = path.join(dir, "index.json");
    this.log = log;
    this.notes = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (parsed && typeof parsed.notes === "object") this.notes = parsed.notes;
    } catch (e) {
      if (e.code !== "ENOENT") this.log("[fuyan] 读取失败,按空库处理:", e.message);
    }
    this.prune();
  }
  prune(now = Date.now()) {
    for (const [id, n] of Object.entries(this.notes)) {
      if (now - (n.ts || 0) > TTL_MS) {
        if (n.file) { try { fs.unlinkSync(path.join(this.dir, n.file)); } catch { /* 已不在 */ } }
        delete this.notes[id];
      }
    }
  }
  save() {
    this.prune();
    try { atomicWrite(this.file, JSON.stringify({ version: 1, notes: this.notes }) + "\n"); }
    catch (e) { this.log("[fuyan] 写入失败(不影响运行):", e.message); }
  }
  addText(text) {
    const t = String(text || "").trim().slice(0, MAX_TEXT);
    if (!t) return null;
    const id = randomBytes(6).toString("hex");
    this.notes[id] = { id, ts: Date.now(), type: "text", text: t, read: false };
    this.save();
    return this.notes[id];
  }
  addMedia(buf, mime) {
    const type = kindOf(mime);
    const ext = extOf(mime);
    if (!type || !ext || !Buffer.isBuffer(buf) || !buf.length) return null;
    if (buf.length > MAX_MEDIA) return null;
    const id = randomBytes(6).toString("hex");
    const file = `${id}.${ext}`;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(this.dir, file), buf, { mode: 0o600 });
    } catch (e) { this.log("[fuyan] 媒体写入失败:", e.message); return null; }
    this.notes[id] = { id, ts: Date.now(), type, file, mime: MIME[ext] || mime, bytes: buf.length, read: false };
    this.save();
    return this.notes[id];
  }
  list() {
    this.prune();
    return Object.values(this.notes).sort((a, b) => a.ts - b.ts);
  }
  unread() { return this.list().filter((n) => !n.read).length; }
  open(ids) {
    const set = Array.isArray(ids) && ids.length ? new Set(ids) : null;
    let n = 0;
    for (const note of Object.values(this.notes)) {
      if (!note.read && (!set || set.has(note.id))) { note.read = true; n++; }
    }
    if (n) this.save();
    return n;
  }
  mediaPath(id) {
    const n = this.notes[id];
    if (!n?.file) return null;
    const p = path.join(this.dir, n.file);
    return fs.existsSync(p) ? { path: p, mime: n.mime } : null;
  }
}

// 四个口统一挂载。key 缺省时整个信箱关门(404),绝不裸奔。
export function mountFuyanInbox(app, { key, dir = DEFAULT_FUYAN_DIR, log = () => {} } = {}) {
  const inbox = new FuyanInbox(dir, log);
  const auth = (req, res) => {
    if (!key) { res.status(404).end(); return false; }   // 没配钥匙 = 信箱不存在
    const got = req.get("x-api-key")
      || (req.get("authorization") || "").replace(/^Bearer\s+/i, "")
      || String(req.query.key || "");
    if (got !== key) { res.status(401).json({ ok: false, error: "bad key" }); return false; }
    return true;
  };

  app.post("/fuyan/note",
    express.json({ limit: "64kb" }),
    express.raw({ type: MEDIA_TYPES, limit: MAX_MEDIA }),
    (req, res) => {
      if (!auth(req, res)) return;
      const mime = (req.get("content-type") || "").split(";")[0].trim().toLowerCase();
      let note = null;
      if (Buffer.isBuffer(req.body) && kindOf(mime)) note = inbox.addMedia(req.body, mime);
      else if (req.body && typeof req.body === "object") note = inbox.addText(req.body.text);
      if (!note) return res.status(400).json({ ok: false, error: "空纸条或不认识的格式(收 JSON{text} / image/* / audio/*)" });
      log("[fuyan] 收到一张纸条:", note.type, note.file || `${(note.text || "").length} 字`);
      res.json({ ok: true, id: note.id, type: note.type, msg: "投进傅言的信箱了" });
    });

  app.get("/fuyan/inbox", (req, res) => {
    if (!auth(req, res)) return;
    res.json({ ok: true, unread: inbox.unread(), notes: inbox.list() });
  });

  app.post("/fuyan/open", express.json({ limit: "16kb" }), (req, res) => {
    if (!auth(req, res)) return;
    const n = inbox.open(req.body?.ids);
    res.json({ ok: true, opened: n });
  });

  app.get("/fuyan/file/:id", (req, res) => {
    if (!auth(req, res)) return;
    const m = inbox.mediaPath(String(req.params.id || ""));
    if (!m) return res.status(404).json({ ok: false, error: "没有这个附件" });
    res.set("Content-Type", m.mime || "application/octet-stream");
    res.sendFile(m.path);
  });

  return inbox;
}
