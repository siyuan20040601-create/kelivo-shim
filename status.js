// status.js — iPhone 临时状态便签(look)的存取、新鲜度与渲染。
//
// 她在手机快捷指令里随手写一句近况 → POST /status 存进持久卷(只留最新一条);
// 他想了解她此刻的情况时,调一次无参数的 look 工具读出来。
// 设计约束(交接邮件原文,别偷偷放宽):
//   · 只保存最新一条,不留历史;不主动唤醒、不轮询。
//   · 返回内容是临时信息,不进长期记忆/续接信/压缩摘要(工具说明里写死)。
//   · 接口响应和日志不回显正文,日志最多记字符数 —— 这是她的私话。
//   · 新鲜度由服务器算,不让模型自己换算时区。
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_STATUS_FILE = "/persona/status/now.json";
export const STATUS_MAX_CHARS = 500; // Unicode 字符数(用 code point 数,不是 UTF-16 单元)

// 原子写入:临时文件 + rename,权限 0600/0700。崩在半路也不会留下半截 JSON。
export function writeStatus(file, text, now = Date.now()) {
  const record = { version: 1, text, writtenAt: new Date(now).toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + ".tmp-" + randomUUID();
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(record) + "\n");
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* rename 成功后 temp 已不在,属正常 */ }
  }
  return record;
}

// iOS 快捷指令会把文字包成单元素数组或一层对象。只解明确的窄形状,
// 绝不把任意对象硬转字符串 —— 解不出来就让快捷指令侧看到明确报错。
const UNWRAP_KEYS = ["text", "value", "string", "content", "data", "input", "answer"];
export function unwrapText(body, depth = 0) {
  if (typeof body === "string") return body;
  if (depth >= 4 || body == null) return null;
  if (Array.isArray(body)) return body.length === 1 ? unwrapText(body[0], depth + 1) : null;
  if (typeof body === "object") {
    for (const k of UNWRAP_KEYS) {
      if (k in body) return unwrapText(body[k], depth + 1);
    }
  }
  return null;
}

// 写入前的校验:非文字 / 空白 / 超长各自给出可定位的错误码(不回显正文)。
export function validateText(raw) {
  const text = unwrapText(raw);
  if (typeof text !== "string") {
    return { error: "状态内容必须是文字", receivedShape: raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw };
  }
  const trimmed = text.trim();
  if (!trimmed) return { error: "状态内容是空的" };
  if ([...trimmed].length > STATUS_MAX_CHARS) return { error: `状态太长(上限 ${STATUS_MAX_CHARS} 字)` };
  return { text: trimmed };
}

// 新鲜度档位(小时):交接邮件的推荐规则,时间一律服务器算。
export function freshness(writtenAt, now = Date.now()) {
  const ageMs = now - new Date(writtenAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return "invalid";
  const h = ageMs / 3600e3;
  if (h < 2) return "current";
  if (h < 8) return "stale";
  if (h < 24) return "expired";
  return "gone";
}

function ageLabel(writtenAt, now) {
  const min = Math.max(0, Math.round((now - new Date(writtenAt).getTime()) / 60000));
  if (min < 60) return `${min} 分钟前`;
  if (min < 1440) return `${Math.round(min / 60)} 小时前`;
  return `${Math.round(min / 1440)} 天前`;
}

// 读 + 渲染成给模型看的一段话。三种情况必须分清(邮件原话):
//   无文件 = 她现在没留便签,不代表任何情绪或意图;
//   读取故障 = 工具暂时坏了,不等于「没有状态」,也不要自动重试;
//   过期分档 = 旧信息不许当成此刻。
export function renderStatus(file, now = Date.now()) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return "她现在没有留下状态便签。这不代表任何情绪或意图,只是没写而已。";
    return "便签工具这次没能读取(存储故障)。这不等于她没留便签;不要重试,也不要据此猜测。";
  }
  let rec;
  try { rec = JSON.parse(raw); } catch { rec = null; }
  if (!rec || typeof rec.text !== "string" || !rec.writtenAt || freshness(rec.writtenAt, now) === "invalid") {
    return "便签工具这次没能读取(内容损坏)。这不等于她没留便签;不要重试,也不要据此猜测。";
  }
  const when = ageLabel(rec.writtenAt, now);
  switch (freshness(rec.writtenAt, now)) {
    case "current":
      return `她${when}留的便签:「${rec.text}」`;
    case "stale":
      return `她${when}留过一条便签(有点旧了,情况可能已变化,别当成此刻):「${rec.text}」`;
    case "expired":
      return `她${when}留过一条便签 —— 已过期,大概率不再反映现状,只供参考:「${rec.text}」`;
    default: // gone:超过 24 小时,正文不再给出
      return `她最后一次留便签是${when},内容已过期不再显示。想知道近况就直接问她。`;
  }
}
