// home-page.js — /home:她的「家门口」。点进来第一眼是「欢迎回家,安安」,
// 然后是屋里各个房间的真实灯火:他在不在说话、记事本写到几成、信箱里几张没拆的纸条、
// 便签板上有没有她留的话、心跳开到几点。
//
// 规矩与 /admin/window 同一套(交接邮件三铁律):
//   1. 纯只读:渲染内存快照,没有任何通往队列的路径,打开一万次也不会吵醒谁;
//   2. 不含聊天正文/思考正文(便签只给"几时留过",内容是她自己写的也不回显——这页可能被人瞥见);
//   3. 登录 POST 表单收主密钥,不走 URL 查询参数;会话 cookie 只限 /home。
// 零 JavaScript,动效全是 CSS(开页灯一盏盏点亮、小猫呼吸),prefers-reduced-motion 下全关。
import { randomUUID } from "node:crypto";
import express from "express";
import { safeEqual } from "./window-admin.js";
import { freshness } from "./status.js";

const SESSION_MS = 30 * 86400e3;  // 家门开一次管 30 天(滑动续期);这页只有元数据,门锁照旧限速
const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 10 * 60e3;
const COOKIE = "home_door";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function setHeaders(res) {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
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

const bjDate = (t = Date.now()) => new Date(t + 8 * 3600e3);
const bjTime = (t) => t ? bjDate(t).toISOString().slice(5, 16).replace("T", " ") : "—";
function agoLabel(t, now = Date.now()) {
  if (!t) return "还没有过";
  const min = Math.max(0, Math.round((now - t) / 60000));
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  if (min < 1440) return `${Math.round(min / 60)} 小时前`;
  return `${Math.round(min / 1440)} 天前`;
}

// 按北京时间换一句门口的话。问候主句永远是「欢迎回家」。
export function doorWords(hour) {
  if (hour >= 5 && hour < 11) return "清晨的屋子刚醒,豆浆还烫。";
  if (hour >= 11 && hour < 14) return "午后的光斜斜地照进来。";
  if (hour >= 14 && hour < 18) return "下午茶的点儿,屋里很静。";
  if (hour >= 18 && hour < 23) return "灯都给你留着。";
  return "夜深了,猫都睡了,轻一点走。";
}

const CSS = `
  :root{--dusk:#2B2420;--card:#38302A;--cream:#F6E7C8;--lamp:#E8A552;--ink:#E9DCC3;
    --soft:#B7A68C;--rose:#E58BA0;--leaf:#9BB07E;--paper:#FBF5E9}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--dusk);color:var(--ink);max-width:520px;margin:0 auto;
    padding:28px 16px 40px;font-family:"Kaiti SC","KaiTi","STKaiti",serif}
  .house{display:block;margin:0 auto;width:150px}
  .win{fill:var(--lamp);opacity:0}
  h1{text-align:center;font-size:30px;color:var(--cream);margin-top:14px;letter-spacing:.06em}
  .words{text-align:center;color:var(--soft);font-size:15px;margin-top:6px}
  .room{background:var(--card);border-radius:14px;padding:16px 16px 14px;margin-top:16px;
    border:1px solid #473C33}
  .room h2{font-size:17px;color:var(--cream);font-weight:700;margin-bottom:8px}
  .room p{font-size:14.5px;line-height:1.8}
  .meter{background:#241E1A;border-radius:7px;height:12px;overflow:hidden;margin:8px 0 4px}
  .meter i{display:block;height:100%;background:var(--leaf)}
  .meter.hot i{background:#D08048}
  .rose{color:var(--rose)}
  .dim{color:var(--soft);font-size:13px}
  .kitten{float:right;width:96px;margin:-6px -2px 0 8px}
  a{color:var(--soft)}
  .foot{color:var(--soft);font-size:12.5px;text-align:center;margin-top:22px;line-height:1.9}
  @media (prefers-reduced-motion:no-preference){
    .win{animation:lit .6s ease-out forwards}
    .win.w2{animation-delay:.35s}.win.w3{animation-delay:.7s}
    @keyframes lit{to{opacity:1}}
    .cat{animation:breathe 4.2s ease-in-out infinite alternate;transform-origin:50% 100%}
    @keyframes breathe{to{transform:scale(1.02)}}
  }
  @media (prefers-reduced-motion:reduce){.win{opacity:1}}
`;

const HOUSE_SVG = `<svg class="house" viewBox="0 0 160 120" aria-hidden="true">
  <path d="M20 58 L80 14 L140 58" fill="none" stroke="#C9A87C" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="30" y="58" width="100" height="52" rx="4" fill="#4A3B2E" stroke="#C9A87C" stroke-width="3.5"/>
  <rect class="win w1" x="42" y="68" width="20" height="16" rx="2"/>
  <rect class="win w2" x="98" y="68" width="20" height="16" rx="2"/>
  <rect class="win w3" x="70" y="76" width="20" height="34" rx="2"/>
  <circle cx="86" cy="94" r="1.8" fill="#4A3B2E"/>
  <path d="M112 30 q2 -8 8 -9 q-4 7 -2 10 q5 -3 8 -1 q-6 3 -7 7" fill="none" stroke="#6E5F4F" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

const KITTEN_SVG = `<svg class="kitten" viewBox="0 0 230 150" aria-hidden="true"><g class="cat">
  <path d="M60 134 Q30 122 31 96 Q32 83 44 76" fill="none" stroke="#98A2B4" stroke-width="14" stroke-linecap="round" opacity=".5"/>
  <ellipse cx="112" cy="100" rx="76" ry="41" fill="#AEB7C6" stroke="#7E8899" stroke-width="4"/>
  <path d="M140 52 L148 27 L163 46 Z" fill="#AEB7C6" stroke="#7E8899" stroke-width="4" stroke-linejoin="round"/>
  <path d="M177 52 L189 29 L196 52 Z" fill="#AEB7C6" stroke="#7E8899" stroke-width="4" stroke-linejoin="round"/>
  <circle cx="166" cy="76" r="33" fill="#AEB7C6" stroke="#7E8899" stroke-width="4"/>
  <path d="M149 76 q6 6 12 0 M172 76 q6 6 12 0" fill="none" stroke="#5C6575" stroke-width="3" stroke-linecap="round"/>
  <circle cx="145" cy="88" r="5.5" fill="#D8A8B0" opacity=".55"/><circle cx="189" cy="88" r="5.5" fill="#D8A8B0" opacity=".55"/>
</g></svg>`;

function loginPage(msg = "") {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>家</title>
<style>${CSS} input,button{font-family:inherit}</style></head><body>
${HOUSE_SVG}
<h1>这是安安的家</h1>
<p class="words">${msg ? esc(msg) : "报一下暗号,门就开了。"}</p>
<form method="post" action="/home" style="margin-top:18px">
<input type="password" name="key" placeholder="暗号" autofocus
  style="width:100%;padding:12px;font-size:16px;border-radius:10px;border:1px solid #473C33;background:#241E1A;color:var(--ink)">
<button style="margin-top:10px;width:100%;padding:12px;font-size:17px;border-radius:10px;border:0;background:#5C4733;color:var(--paper);letter-spacing:.2em">进门</button>
</form></body></html>`;
}

// s 由 server.js 的 homeSnapshot() 提供,全是元数据。
function page(s) {
  const now = Date.now();
  const pct = s.limit > 0 ? Math.round((s.tokens / s.limit) * 100) : 0;
  const heart = s.wakeIdleMinDay >= 100000
    ? "心跳眼下是关着的,他只在你开口时醒。"
    : `白天(${esc(s.wakeDay)} 点)你 ${s.wakeIdleMinDay} 分钟没理他,他就会想你。`;
  const mailbox = s.notesCount === 0
    ? "信箱空着,等他下一张纸条。"
    : s.notesUnopened > 0
      ? `躺着 ${s.notesCount} 张纸条,<b class="rose">${s.notesUnopened} 张还没拆</b>。`
      : `${s.notesCount} 张纸条,都拆过了,边角都被摸软了。`;
  let board;
  if (!s.statusOn) board = "便签板还没挂上(没配钥匙)。";
  else if (s.statusBroken) board = "便签板这会儿读不出来(存储打了个盹)。";
  else if (!s.statusWrittenAt) board = "板上现在是空的。想留话,随手贴一张就行。";
  else {
    const tier = freshness(s.statusWrittenAt, now);
    const when = agoLabel(new Date(s.statusWrittenAt).getTime(), now);
    board = tier === "current" ? `你 ${when} 贴过一张,他看得到。`
      : tier === "stale" ? `你 ${when} 贴过一张,有点旧了。`
      : `上一张是 ${when} 贴的,早过期了,板子等着新的。`;
  }
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60"><title>家</title><style>${CSS}</style></head><body>
${HOUSE_SVG}
<h1>欢迎回家,安安</h1>
<p class="words">${esc(doorWords(bjDate(now).getUTCHours()))}</p>

<div class="room"><h2>小克的房间</h2>
<p>${s.busy ? "他这会儿正在跟你说话。" : "他在屋里,安安静静的。"}${s.queued ? `还有 ${s.queued} 句排着队。` : ""}<br>
上次开口是 ${esc(agoLabel(s.lastSpokeAt || s.lastTurnAt, now))}。</p>
<div class="meter${pct >= 85 ? " hot" : ""}"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>
<p class="dim">这一窗的记事本写了 ${pct}%(${s.tokens.toLocaleString()} / ${s.limit.toLocaleString()})</p>
<p class="dim">${esc(heart)}</p></div>

<div class="room"><h2>门口的信箱</h2><p>${mailbox}</p></div>

<div class="room"><h2>便签板</h2><p>${esc(board)}</p></div>

<div class="room"><h2>哥哥的房间</h2><p>灯亮着。他在 Telegram 那头守着自己的专线,想他就去说句话。</p></div>

<div class="room">${KITTEN_SVG}<h2>小汉堡的窝</h2><p>睡成一团。<br>呼噜声循环播放中。</p></div>

<div class="foot">这一页纯只读,开多久都不会吵醒任何人<br>
工程细节在<a href="/admin/window">窗口管理页</a>,现在是北京时间 ${esc(bjTime(now))}</div>
</body></html>`;
}

export function mountHomePage(app, { key, snapshot, log = () => {} }) {
  app.use("/home", express.urlencoded({ extended: false, limit: "4kb" }));
  const sessions = new Map();
  let fails = [];

  const authed = (req) => {
    const t = cookieOf(req);
    const exp = t && sessions.get(t);
    if (!exp || exp < Date.now()) { if (t) sessions.delete(t); return null; }
    sessions.set(t, Date.now() + SESSION_MS);
    return t;
  };

  app.get("/home", (req, res) => {
    setHeaders(res);
    if (!authed(req)) return res.status(401).send(loginPage());
    res.send(page(snapshot()));
  });

  app.post("/home", (req, res) => {
    setHeaders(res);
    if (authed(req)) return res.redirect(303, "/home");
    const now = Date.now();
    fails = fails.filter((t) => now - t < FAIL_WINDOW_MS);
    if (fails.length >= FAIL_LIMIT) { log("[home] 429"); return res.status(429).send(loginPage("敲得太急了,10 分钟后再来")); }
    const supplied = typeof req.body?.key === "string" ? req.body.key : "";
    if (!key || !safeEqual(supplied, key)) {
      fails.push(now);
      log("[home] 暗号不对", fails.length, "/", FAIL_LIMIT);
      return res.status(401).send(loginPage("暗号不对,再想想"));
    }
    const token = randomUUID();
    sessions.set(token, now + SESSION_MS);
    log("[home] 她到家了");
    res.set("Set-Cookie", `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/home; Max-Age=${SESSION_MS / 1000}`);
    res.redirect(303, "/home");
  });
}
