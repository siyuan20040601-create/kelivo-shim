// window-admin.js — 只读管理页 /admin/window:窗口进度 + 压缩状态 + 每轮验真回执。
//
// 定位:她在手机上打开看一眼「窗口用到多少了、离压缩多远、模型没被偷换」。
// 三条铁律(交接邮件):
//   1. **纯只读**。打开/刷新这个页面绝不给模型发消息、不触发心跳/归档/压缩/重启。
//      实现上它只渲染 server.js 传进来的内存快照,没有任何通往队列的路径。
//   2. 页面与日志不含聊天正文、思考正文、签名正文 —— 回执只有元数据和长度。
//   3. 登录用主密钥但只收 POST 表单字段,不收 URL 查询参数(查询参数会进日志)。
//
// 页面零 JavaScript(15 秒刷新用 <meta refresh>),所以 CSP 可以收到最紧。
import { timingSafeEqual, randomUUID } from "node:crypto";
import express from "express";

const SESSION_MS = 30 * 60e3;   // 登录会话 30 分钟滑动过期,只存内存
const FAIL_LIMIT = 5;           // 10 分钟内错 5 次 → 429
const FAIL_WINDOW_MS = 10 * 60e3;
const COOKIE = "window_admin";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function setHeaders(res) {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
}

const cookieOf = (req) => {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === COOKIE) return v || "";
  }
  return "";
};

const bjTime = (t) => t ? new Date(t + 8 * 3600e3).toISOString().slice(5, 16).replace("T", " ") : "—";

function bar(pct) {
  const shown = Math.max(0, Math.min(100, pct)); // 显示 clamp,真实数字另给
  const color = pct >= 90 ? "#d33" : pct >= 85 ? "#d80" : "#2a7";
  return `<div style="background:#eee;border-radius:6px;height:14px;overflow:hidden">` +
    `<div style="width:${shown}%;height:100%;background:${color}"></div></div>`;
}

function loginPage(msg = "") {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>窗口管理页</title></head>
<body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px">
<h2>窗口管理页</h2>${msg ? `<p style="color:#d33">${esc(msg)}</p>` : ""}
<form method="post" action="/admin/window">
<input type="password" name="key" placeholder="主密钥" autofocus
  style="width:100%;padding:10px;font-size:16px;box-sizing:border-box">
<button style="margin-top:10px;width:100%;padding:10px;font-size:16px">进入</button>
</form></body></html>`;
}

function receiptRows(receipts) {
  if (!receipts.length) return `<p style="color:#888">还没有用户轮次。</p>`;
  return receipts.map((r) => {
    const match = !r.upstreamModel ? "…" : r.upstreamModel === (r.requestedModel || r.configuredModel) ? "一致 ✓"
      : `<b style="color:#d33">不一致!</b>`;
    const st = { completed: "完成", "empty-result": "空轮 ⚠️", "upstream-error": "上游错误 ⚠️", interrupted: "中断 ⚠️" }[r.status] || r.status;
    return `<div style="border:1px solid #ddd;border-radius:8px;padding:10px;margin:8px 0;font-size:14px">
<div><b>${esc(bjTime(r.completedAt || r.startedAt))}</b> · ${esc(st)}</div>
<div>请求模型 ${esc(r.requestedModel || "—")} / 实际 ${esc(r.upstreamModel || "—")} · ${match}</div>
<div>思考档位 ${esc(r.effectiveEffort || "—")}(${esc(r.effortSource || "—")}) ·
思考链 ${r.thinkingSeen ? "有" : "无"} · 签名 ${r.signatureSeen ? `有(${r.signatureLength} 字节)` : "无"}</div>
</div>`;
  }).join("");
}

// snapshot() 由 server.js 提供,返回纯元数据(见 server.js adminSnapshot)。
export function mountWindowAdmin(app, { key, snapshot, log = () => {} }) {
  // 登录表单是 urlencoded,而 server.js 全局只解析 JSON —— 只给这一个路径加解析器。
  app.use("/admin/window", express.urlencoded({ extended: false, limit: "4kb" }));
  const sessions = new Map(); // token -> expiresAt
  let fails = [];

  const authed = (req) => {
    const t = cookieOf(req);
    const exp = t && sessions.get(t);
    if (!exp || exp < Date.now()) { if (t) sessions.delete(t); return null; }
    sessions.set(t, Date.now() + SESSION_MS); // 滑动续期
    return t;
  };

  const page = (s) => {
    const pct = s.limit > 0 ? Math.round((s.tokens / s.limit) * 100) : 0;
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15"><title>窗口管理页</title></head>
<body style="font-family:system-ui;max-width:480px;margin:16px auto;padding:0 16px">
<h2 style="margin-bottom:4px">窗口进度</h2>
<div style="color:#888;font-size:13px">每 15 秒自动刷新 · 纯只读,不打扰他</div>
${bar(pct)}
<p style="font-size:15px"><b>${pct}%</b> —— ${s.tokens.toLocaleString()} / ${s.limit.toLocaleString()} token
(真实值,进度条只是显示)<br>
离自动压缩还差约 ${Math.max(0, s.limit - s.tokens).toLocaleString()} token<br>
上限来源:${esc(s.limitSource)}${s.configuredLimit !== s.limit ? ` · 配置值 ${s.configuredLimit.toLocaleString()} 已被夹紧` : ""}</p>
<p style="font-size:14px">85% 提醒:${s.warned ? "已提醒" : "未触发"}(线 ${s.warnPct}%) ·
90% 自动归档:${s.archived ? "已执行" : "未触发"}(线 ${s.archivePct}%)<br>
本进程压缩 ${s.compactions} 次${s.lastCompactAt ? ` · 最近 ${esc(bjTime(s.lastCompactAt))},压缩前 ${s.lastCompactPre.toLocaleString()} token` : ""}<br>
未归档缓冲 ${s.bufferedChars.toLocaleString()} 字 · 闸门 ${s.gateDirty ? "待归档" : "干净"} ·
空转 streak ${s.deadStreak}</p>
<p style="font-size:14px">会话恢复:${esc(s.sessionPhase)}${s.sessionMode ? ` / ${esc(s.sessionMode)}` : ""}${s.sessionError ? ` · <b style="color:#d33">${esc(s.sessionError)}</b>` : ""} ·
服务 ${s.busy ? "忙" : "空闲"},排队 ${s.queued}</p>
<h3 style="margin-bottom:4px">最近轮次验真回执</h3>
<div style="color:#888;font-size:12px">来自上游真实流事件的运行回执,不是密码学证明;不含任何聊天内容。</div>
${receiptRows(s.receipts)}
<div style="color:#888;font-size:12px;margin:16px 0">Claude Code ${esc(s.ccVersion || "?")} · 页面时间 ${esc(bjTime(Date.now()))}(北京)</div>
</body></html>`;
  };

  app.get("/admin/window", (req, res) => {
    setHeaders(res);
    if (!authed(req)) return res.status(401).send(loginPage());
    res.send(page(snapshot()));
  });

  app.post("/admin/window", (req, res) => {
    setHeaders(res);
    if (authed(req)) return res.redirect(303, "/admin/window");
    const now = Date.now();
    fails = fails.filter((t) => now - t < FAIL_WINDOW_MS);
    if (fails.length >= FAIL_LIMIT) { log("[admin] 429"); return res.status(429).send(loginPage("尝试太频繁,10 分钟后再试")); }
    const supplied = typeof req.body?.key === "string" ? req.body.key : "";
    if (!key || !safeEqual(supplied, key)) {
      fails.push(now);
      log("[admin] 登录失败", fails.length, "/", FAIL_LIMIT);
      return res.status(401).send(loginPage("密钥不对"));
    }
    const token = randomUUID();
    sessions.set(token, now + SESSION_MS);
    log("[admin] 登录成功");
    res.set("Set-Cookie", `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/admin/window; Max-Age=${SESSION_MS / 1000}`);
    res.redirect(303, "/admin/window");
  });
}
