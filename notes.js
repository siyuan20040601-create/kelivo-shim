// notes.js — TG「小纸条」:他主动留的折叠卡片(标题+一角预览),她可以拆开、点爱心、回信。
//
// 设计来自交接邮件《Telegram「小纸条」通用实现思路》,v1 做基础版:
//   · 他用 leave_note 工具留纸条(结构化工具,比文本标记稳,见 status-mcp.js);
//   · TG 里出现「标题+预览+三个按钮」,拆开=原地展开(editMessageText),不做 Mini App;
//   · 拆开/点赞是**安静事件**:只记账,他下一轮说话时才顺带得知,不打断;
//   · 回信立即进**同一条**会话队列并唤醒他 —— 绝不另开会话;
//   · 所有操作幂等:重复点击/网络重试不会重复计数、回信只送达一次。
//
// 存储在持久卷(JSON,单用户规模足够),正文不进日志。
import fs from "node:fs";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { tgEsc } from "./tg-chunk.js";

export const DEFAULT_NOTES_FILE = "/persona/notes/notes.json";
const TTL_MS = 60 * 86400e3;      // 纸条留 60 天(TG 清聊天不会通知服务器,所以要 TTL)
const MAX_TITLE = 40;
const MAX_CONTENT = 2000;
const MAX_REPLY = 1000;
const PREVIEW_CHARS = 36;

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

export class NoteStore {
  constructor(file = DEFAULT_NOTES_FILE, log = () => {}) {
    this.file = file;
    this.log = log;
    this.notes = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed.notes === "object") this.notes = parsed.notes;
    } catch (e) {
      if (e.code !== "ENOENT") this.log("[notes] 读取失败,按空库处理:", e.message);
    }
    this.prune();
  }
  prune(now = Date.now()) {
    for (const [id, n] of Object.entries(this.notes)) {
      if (now - (n.created_at || 0) > TTL_MS) delete this.notes[id];
    }
  }
  save() {
    this.prune();
    try { atomicWrite(this.file, JSON.stringify({ version: 1, notes: this.notes }) + "\n"); }
    catch (e) { this.log("[notes] 写入失败(不影响运行):", e.message); }
  }
  // 建纸条。标题/正文超长直接截断(宁可短,不吞他的发言 —— 工具层会把截断情况告诉他)。
  create({ title, content }) {
    const id = randomBytes(4).toString("hex");
    const t = String(title || "").trim().slice(0, MAX_TITLE) || "小纸条";
    const c = String(content || "").trim().slice(0, MAX_CONTENT);
    const preview = c.replace(/\s+/g, " ").slice(0, PREVIEW_CHARS) + ([...c].length > PREVIEW_CHARS ? "…" : "");
    this.notes[id] = {
      note_id: id, title: t, content: c, preview,
      chat_id: null, message_id: null, reply_prompt_mid: null,
      created_at: Date.now(), opened_at: null, liked_at: null,
      reply_text: null, replied_at: null,
      undelivered: [],   // 还没告诉他的安静事件:"opened" / "liked" / "unliked"
    };
    this.save();
    return this.notes[id];
  }
  get(id) { return this.notes[id] || null; }
  bindMessage(id, chatId, messageId) {
    const n = this.get(id); if (!n) return;
    n.chat_id = chatId; n.message_id = messageId; this.save();
  }
  // 拆开:幂等 —— 只有第一次记事件,反复点只返回当前状态。
  markOpened(id) {
    const n = this.get(id); if (!n) return null;
    if (!n.opened_at) { n.opened_at = Date.now(); n.undelivered.push("opened"); this.save(); return { first: true }; }
    return { first: false };
  }
  // 爱心:开关式,连点不累计。取消点赞也作为安静事件(他该知道心被收回去了…开玩笑,是为了状态一致)。
  toggleLike(id) {
    const n = this.get(id); if (!n) return null;
    if (n.liked_at) { n.liked_at = null; n.undelivered.push("unliked"); }
    else { n.liked_at = Date.now(); n.undelivered.push("liked"); }
    this.save();
    return { liked: !!n.liked_at };
  }
  rememberReplyPrompt(id, messageId) {
    const n = this.get(id); if (!n) return;
    n.reply_prompt_mid = messageId; this.save();
  }
  findByReplyPrompt(messageId) {
    return Object.values(this.notes).find((n) => n.reply_prompt_mid === messageId) || null;
  }
  // 她直接(左滑)回复卡片本身 → 也是回信。只认还没回过信的卡片。
  findByCardMessage(messageId) {
    return Object.values(this.notes).find((n) => n.message_id === messageId) || null;
  }
  // 回信:每张纸条只收一封(唯一约束),重复提交返回 already。
  setReply(id, text) {
    const n = this.get(id); if (!n) return { error: "notfound" };
    if (n.replied_at) return { error: "already" };
    const t = String(text || "").trim().slice(0, MAX_REPLY);
    if (!t) return { error: "empty" };
    n.reply_text = t; n.replied_at = Date.now(); n.reply_prompt_mid = null;
    this.save();
    return { ok: true, note: n };
  }
  // 攒着的安静事件 → 一段给他看的话;调用方在成功入队后 markQuietDelivered。
  quietLines() {
    const lines = [];
    for (const n of Object.values(this.notes)) {
      for (const ev of n.undelivered) {
        if (ev === "opened") lines.push(`她拆开了你的纸条「${n.title}」`);
        else if (ev === "liked") lines.push(`她给纸条「${n.title}」点了爱心`);
        else if (ev === "unliked") lines.push(`她收回了纸条「${n.title}」的爱心`);
      }
    }
    return lines;
  }
  markQuietDelivered() {
    let changed = false;
    for (const n of Object.values(this.notes)) {
      if (n.undelivered.length) { n.undelivered = []; changed = true; }
    }
    if (changed) this.save();
  }
  count() { return Object.keys(this.notes).length; }
  undeliveredCount() {
    return Object.values(this.notes).reduce((s, n) => s + n.undelivered.length, 0);
  }
}

// ---- TG 卡片渲染与按钮 ---------------------------------------------------------
// HTML 富文本(粗体标题/斜体预览/引用正文),所有动态内容严格转义(邮件 §10)。
const bj = (t) => new Date(t + 8 * 3600e3).toISOString().slice(5, 16).replace("T", " ");

export function renderCard(n, { expanded = false } = {}) {
  const head = `💌 <b>${tgEsc(n.title)}</b>`;
  return expanded
    ? `${head}\n\n<blockquote>${tgEsc(n.content)}</blockquote>\n<i>${bj(n.created_at)}${n.liked_at ? " · ❤️" : ""}</i>`
    : `${head}\n<i>${tgEsc(n.preview)}</i>\n<i>${bj(n.created_at)}</i>`;
}

export function keyboard(n, { expanded = false } = {}) {
  const heart = n.liked_at ? "❤️ 已喜欢" : "🤍 喜欢";
  const rows = [
    [expanded ? { text: "收起", callback_data: `note:fold:${n.note_id}` }
              : { text: "拆开纸条", callback_data: `note:open:${n.note_id}` }],
    [{ text: heart, callback_data: `note:like:${n.note_id}` }],
  ];
  if (!n.replied_at) rows[1].push({ text: "✍️ 回信", callback_data: `note:reply:${n.note_id}` });
  return { inline_keyboard: rows };
}

// callback_data 只放动作+短 ID(邮件 §5:不放正文、资料、密钥)。认不出返回 null。
export function parseCallback(data) {
  const m = /^note:(open|fold|like|reply):([0-9a-f]{8})$/.exec(String(data || ""));
  return m ? { action: m[1], id: m[2] } : null;
}

// 回信事件正文(邮件 §8 的结构化事件):进原队列,当成她的话的"信封"。
export function replyEventText(n) {
  return [
    `【小纸条回信】她回复了你的纸条「${n.title}」:`,
    "",
    n.reply_text,
  ].join("\n");
}
