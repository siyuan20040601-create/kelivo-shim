// Explicit session controls. GET only renders metadata; actions require an
// authenticated cookie, one-use CSRF token, current revision and idle runtime.
import express from "express";
import { randomUUID } from "node:crypto";
import { safeEqual } from "./window-admin.js";
const BASE = "/admin/session", COOKIE = "session_admin", TTL = 30 * 60e3;
const EFFORTS = { low: "轻度 (low)", medium: "中度 (medium)", high: "深度 (high)", max: "最高 (max)" };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const modelName = m => ({ "claude-opus-4-6[1m]": "Claude Opus 4.6 · 1M", "claude-opus-4-6": "Claude Opus 4.6 · 200k", "claude-opus-4-8": "Claude Opus 4.8", "claude-opus-5-5": "Claude Opus 5.5 · 1M", "claude-fable-5": "Claude Fable 5" }[m] || m);
const shell = content => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>会话管理</title><style>
*{box-sizing:border-box}body{margin:0;background:#f7f7f3;color:#272a2e;font:16px/1.65 system-ui,-apple-system,sans-serif}main{max-width:620px;margin:32px auto;padding:0 20px 40px}header{margin:0 4px 24px}h1{font-size:27px;margin:0 0 4px}h2{font-size:21px;line-height:1.4;margin:0 0 14px}p{margin:0 0 16px}.muted,small{color:#66717b;font-size:14px}.card{background:#fff;border:1px solid #e0e4e6;border-radius:16px;padding:24px;margin:18px 0;box-shadow:0 3px 12px #17293805}.status{background:#edf4f8;border-radius:10px;padding:12px 15px;font-size:14px;overflow-wrap:anywhere}.notice{background:#eaf4ee;border:1px solid #b9d6c6;border-radius:10px;padding:14px;margin:18px 0}.error{background:#fff1ef;border-color:#ecc6c0;color:#8a2921}label.field{display:block;font-weight:600;font-size:14px;margin:18px 0 7px}select,input[type=password]{width:100%;font:inherit;background:#fff;border:1px solid #cfd8df;border-radius:10px;padding:12px;color:#202830}button{border:0;border-radius:10px;padding:13px 18px;font:600 16px/1.5 system-ui;background:#1478bc;color:white;cursor:pointer;width:100%;margin-top:14px}button.danger{background:#b9342d}button:disabled{opacity:.45;cursor:not-allowed}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #82b7e1;outline-offset:3px}.confirm{display:flex;align-items:flex-start;gap:10px;margin:20px 0 4px;font-size:15px}.confirm input{width:19px;height:19px;flex-shrink:0;margin-top:3px;accent-color:#b9342d}nav{display:flex;gap:20px;justify-content:center;margin-top:25px;font-size:14px}a{color:#286ca2;text-underline-offset:3px}.foot{margin:16px 0 0;font-size:13px;color:#66717b}@media(max-width:480px){main{margin:24px auto;padding:0 16px 30px}.card{padding:20px}}
</style></head><body><main>${content}</main></body></html>`;
const loginPage = (message = "") => shell(`<header><h1>会话管理</h1><p class="muted">查看状态，或为下一段对话做好准备。</p></header><section class="card"><h2>进入管理页</h2>${message ? `<p class="error notice">${esc(message)}</p>` : ""}<form method="post" action="${BASE}/login"><label class="field" for="key">主密钥</label><input id="key" name="key" type="password" required autocomplete="current-password"><button>进入</button></form><p class="foot">使用 Kelivo 连接这个服务时填写的主密钥。</p></section>`);

export function mountSessionAdmin(app, { key, snapshot, control, log = () => {} }) {
  const logins = new Map();
  let fails = [];
  app.use(BASE, express.urlencoded({ extended: false, limit: "4kb" }), (req, res, next) => {
    // no-referrer makes native form POSTs carry Origin: null, which our
    // same-origin guard correctly rejects. Keep origin on same-site forms;
    // still omit the referrer entirely when navigating to another origin.
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
    if (req.method === "POST" && req.get("sec-fetch-site") === "cross-site") return res.status(403).send(loginPage("请从本页提交操作。"));
    if (req.method === "POST" && req.get("origin")) {
      let origin; try { origin = new URL(req.get("origin")); } catch {}
      if (!origin || origin.host !== req.get("host") || !["http:", "https:"].includes(origin.protocol)) return res.status(403).send(loginPage("请从本页提交操作。"));
    }
    next();
  });
  const auth = req => {
    for (const [t, s] of logins) if (s.expires < Date.now()) logins.delete(t);
    const token = (req.headers.cookie || "").split(";").map(x => x.trim()).find(x => x.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
    const s = token && logins.get(token);
    if (s) s.expires = Date.now() + TTL;
    return s;
  };
  const page = (login, message = "", error = false) => {
    const s = snapshot();
    login.csrf = randomUUID();
    const hidden = `<input type="hidden" name="csrf" value="${login.csrf}"><input type="hidden" name="revision" value="${esc(s.revision)}">`;
    const disabled = !s.enabled || s.busy ? " disabled" : "";
    const state = !s.enabled ? "会话存储不可用" : s.busy ? "后台忙碌，请等这一轮结束" : s.phase === "failed" ? "会话待修复" : s.phase === "ready" ? "空闲 · 可以继续聊天" : "已准备好 · 等待下一条真实消息";
    return shell(`<header><h1>会话管理</h1><p class="muted">下一段怎么开始，由你决定。</p><div class="status">${esc(state)}<br>${esc(modelName(s.model))} · ${esc(EFFORTS[s.effort] || s.effort)}<br>${s.pinned ? "模型与档位使用本页设置" : "模型跟随前端，档位使用服务设置"}</div></header>
${message ? `<p role="status" class="notice${error ? " error" : ""}">${esc(message)}</p>` : ""}
<section class="card"><h2>保留当前会话</h2><p class="muted">重新连接当前会话，保留已确认的对话历史和当前配置。下一条真实消息到来时续接。</p><form method="post" action="${BASE}/action">${hidden}<button name="action" value="restart"${disabled}>保留当前会话并重启连接</button></form><p class="foot">后台正在回复、压缩或调用工具时不会执行；请等这一轮结束后再试。</p></section>
<section class="card"><h2>放下当前会话</h2><p class="muted">选择下一段会话使用的模型和档位，再放下当前原生 session。<strong>不要求先归档。</strong></p>
<form method="post" action="${BASE}/action">${hidden}<label class="field" for="model">下一段模型</label><select id="model" name="model" required>${s.models.map(m => `<option value="${esc(m)}"${m === s.model ? " selected" : ""}>${esc(modelName(m))}</option>`).join("")}</select>
<label class="field" for="effort">下一段思考档位</label><select id="effort" name="effort" required>${Object.entries(EFFORTS).map(([v, label]) => `<option value="${v}"${v === s.effort ? " selected" : ""}>${label}</option>`).join("")}</select>
<label class="confirm"><input type="checkbox" name="confirm" value="yes" required><span>我确认要放下当前会话，并用上面的配置开始下一段。</span></label><button class="danger" name="action" value="fresh"${disabled}>确认放下当前会话</button></form>
<p class="foot">旧会话会先备份，CLAUDE.md、OB、工具和旧聊天均会保留。尚未归档的旧对话不会自动带进新窗口。</p><p class="foot">准备完成后，从已配对的 Telegram 或 Kelivo 发出下一条消息即可。这里选定的模型与档位会持续生效，优先于前端的模型选择。</p></section>
<nav><a href="/admin/window">窗口进度</a><a href="/home">回到家门口</a><a href="${BASE}">刷新状态</a></nav>`);
  };
  app.get(BASE, (req, res) => {
    const s = auth(req);
    if (!s) return res.status(401).send(loginPage());
    const message = s.flash; delete s.flash;
    res.send(page(s, message));
  });
  app.post(BASE + "/login", (req, res) => {
    if (auth(req)) return res.redirect(303, BASE);
    const now = Date.now(); fails = fails.filter(t => now - t < 10 * 60e3);
    if (fails.length >= 5) return res.status(429).send(loginPage("尝试太频繁，请 10 分钟后再试。"));
    if (!key || typeof req.body?.key !== "string" || !safeEqual(req.body.key, key)) { fails.push(now); return res.status(401).send(loginPage("密钥不对。")); }
    if (logins.size >= 100) logins.delete(logins.keys().next().value);
    const token = randomUUID(); logins.set(token, { expires: now + TTL });
    res.set("Set-Cookie", `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=${BASE}; Max-Age=${TTL / 1000}`);
    res.redirect(303, BASE);
  });
  app.post(BASE + "/action", async (req, res) => {
    const s = auth(req);
    if (!s) return res.status(401).send(loginPage());
    const body = req.body || {};
    if (!s.csrf || typeof body.csrf !== "string" || !safeEqual(body.csrf, s.csrf)) return res.status(403).send(page(s, "表单已过期，请重新确认操作。", true));
    s.csrf = null; // Consume before awaiting; double submissions cannot repeat an action.
    if (!["fresh", "restart"].includes(body.action) || (body.action === "fresh" && body.confirm !== "yes")) return res.status(400).send(page(s, "请勾选确认后再提交。", true));
    try {
      const result = await control({ action: body.action, revision: body.revision, model: body.model, effort: body.effort });
      if (!result.ok) return res.status(result.status || 409).send(page(s, result.message, true));
      s.flash = result.message;
      res.redirect(303, BASE);
    } catch {
      log("[session-admin] 操作失败");
      res.status(503).send(page(s, "操作未完成，请检查会话存储与服务状态后再试。", true));
    }
  });
}
