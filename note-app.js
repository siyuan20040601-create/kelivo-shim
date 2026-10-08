// note-app.js — 小纸条的 Telegram Mini App:拆开纸条不再是聊天里原地展开,
// 而是打开一张真正的「信纸」页面(奶油纸、楷体、右下角蜷着一只睡着的小猫)。
//
// 结构(照着又又小程序版的思路,猫是给小汉堡画的原创):
//   GET  /note-app            → 静态信纸页(不含任何纸条内容,公网可见也无所谓)
//   POST /note-app/api/note   → { id, initData } → 验签+验人 → 纸条内容;首次取件记「拆开」安静事件
//   POST /note-app/api/like   → { id, initData } → 爱心开关(与聊天卡片同一份状态)
//
// 安全(邮件 §5/§10 同款口径):
//   · 页面本身零数据;内容只走 API,每次都验 Telegram WebApp initData 的 HMAC 签名
//     (secret = HMAC_SHA256(key:"WebAppData", msg:bot_token);对排序后的 key=value 行计算),
//     并要求 initData 里的 user.id === 她的 chat id —— 别人拿到链接也打不开;
//   · auth_date 只认 24 小时内的(initData 在她点按钮那一刻新签,正常永远新鲜);
//   · 纸条正文不进日志;API 错误用人话,不暴露内部细节。
import { createHmac, timingSafeEqual } from "node:crypto";

export const INIT_DATA_MAX_AGE_MS = 24 * 3600e3;

// 验 Telegram WebApp initData。通过 → { ok:true, userId };失败 → { error: "bad"|"stale" }。
export function validateInitData(initData, botToken, { now = Date.now(), maxAgeMs = INIT_DATA_MAX_AGE_MS } = {}) {
  if (!botToken || typeof initData !== "string" || !initData || initData.length > 8192) return { error: "bad" };
  let params;
  try { params = new URLSearchParams(initData); } catch { return { error: "bad" }; }
  const hash = params.get("hash") || "";
  if (!/^[0-9a-f]{64}$/.test(hash)) return { error: "bad" };
  params.delete("hash");
  const dataCheckString = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expect = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (!timingSafeEqual(Buffer.from(expect), Buffer.from(hash))) return { error: "bad" };
  const authAt = (+params.get("auth_date") || 0) * 1000;
  if (!authAt || now - authAt > maxAgeMs || authAt - now > 300e3) return { error: "stale" };
  let user;
  try { user = JSON.parse(params.get("user") || "null"); } catch { user = null; }
  if (!user || typeof user.id !== "number") return { error: "bad" };
  return { ok: true, userId: user.id };
}

// 挂到 express。store=NoteStore;getChatId 动态取(她可能是启动后才锁定的);
// onLiked(note) 可选:点赞后让 server.js 顺手刷新聊天里卡片的按钮,失败无所谓。
export function mountNoteApp(app, { store, botToken, getChatId, log = () => {}, onLiked = null, now = () => Date.now() }) {
  app.get("/note-app", (_q, res) => {
    res.set("Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline' https://telegram.org; style-src 'unsafe-inline'; connect-src 'self'; img-src data:");
    res.set("Cache-Control", "no-store");
    res.type("html").send(PAGE_HTML);
  });

  // 验签+验人+找纸条。出错直接把响应发掉,返回 null;成功返回纸条。
  const open = (req, res) => {
    const v = validateInitData(String(req.body?.initData || ""), botToken, { now: now() });
    if (!v.ok) {
      res.status(401).json({ ok: false, error: v.error === "stale" ? "这次打开太久了,回聊天里重新点一下纸条按钮。" : "身份没验上 —— 请从 Telegram 里的纸条按钮进来。" });
      return null;
    }
    if (v.userId !== getChatId()) {
      res.status(403).json({ ok: false, error: "这张纸条不是写给这个账号的。" });
      return null;
    }
    const n = store.get(String(req.body?.id || ""));
    if (!n) {
      res.status(404).json({ ok: false, error: "这张纸条不在了(放超过 60 天的纸条会自己飞走)。" });
      return null;
    }
    return n;
  };

  app.post("/note-app/api/note", (req, res) => {
    const n = open(req, res); if (!n) return;
    const o = store.markOpened(n.note_id);           // 幂等:只有第一次记安静事件
    if (o?.first) log("[note-app] 她在信纸页拆开了纸条", n.note_id);
    res.json({ ok: true, title: n.title, content: n.content, created_at: n.created_at,
      liked: !!n.liked_at, replied: !!n.replied_at });
  });

  app.post("/note-app/api/like", (req, res) => {
    const n = open(req, res); if (!n) return;
    const r = store.toggleLike(n.note_id);
    if (onLiked) Promise.resolve(onLiked(store.get(n.note_id))).catch(() => {});
    res.json({ ok: true, liked: r.liked });
  });
}

// ---- 信纸页 --------------------------------------------------------------------
// 设计定案(自检过「生成感」清单):奶油信纸是题面(又又同款形制,她点名要的);
// 楷体系统栈 = 手写信,不加载外部字体;爱心玫红(避开陶土橘);大胆处只有小猫一处;
// 动效仅「开页浮起 + 小猫呼吸」,prefers-reduced-motion 全关。内容全走 textContent,不拼 HTML。
const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>小纸条</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root {
    --paper: #FBF5E9; --ink: #4A3B2E; --ink-soft: #96785A;
    --rule: #E9DCC3; --rose: #D96A80; --cocoa: #5C4733; --page: #EFE8DA;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100%; }
  body {
    background: var(--page);
    font-family: "Kaiti SC", "KaiTi", "STKaiti", "FangSong SC", serif;
    color: var(--ink);
    padding: 18px 14px calc(96px + env(safe-area-inset-bottom));
  }
  @media (prefers-color-scheme: dark) { body { background: #221D15; } }

  .paper {
    position: relative;
    background: var(--paper);
    border-radius: 6px 6px 10px 10px;
    box-shadow: 0 1px 2px rgba(74,59,46,.14), 0 10px 28px rgba(74,59,46,.12);
    padding: 26px 22px 118px;
    max-width: 560px;
    margin: 0 auto;
    min-height: 68vh;
    overflow: hidden;
  }
  @media (prefers-reduced-motion: no-preference) {
    .paper { animation: arrive .5s ease-out both; }
    @keyframes arrive { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
    .kitten { animation: breathe 4.2s ease-in-out infinite alternate; transform-origin: 50% 100%; }
    @keyframes breathe { from { transform: scale(1); } to { transform: scale(1.016); } }
  }

  .heart {
    background: none; border: 0; padding: 6px; margin: -6px 0 10px -6px;
    display: inline-flex; cursor: pointer;
  }
  .heart svg { width: 30px; height: 30px; transition: transform .18s ease; }
  .heart:active svg { transform: scale(1.22); }
  .heart path { fill: none; stroke: var(--rose); stroke-width: 2.2; stroke-linejoin: round; }
  .heart.liked path { fill: var(--rose); }
  .heart:focus-visible { outline: 2px solid var(--rose); outline-offset: 2px; border-radius: 8px; }

  h1 { font-size: 26px; line-height: 1.35; font-weight: 700; overflow-wrap: anywhere; }
  .when { margin-top: 6px; font-size: 13.5px; color: var(--ink-soft); }

  .body {
    margin-top: 14px;
    font-size: 17.5px; line-height: 38px;
    white-space: pre-wrap; overflow-wrap: anywhere;
    background: repeating-linear-gradient(to bottom, transparent 0 37px, var(--rule) 37px 38px);
    min-height: 152px;
    padding-bottom: 4px;
  }
  .replied { margin-top: 16px; font-size: 13.5px; color: var(--ink-soft); font-style: italic; }

  .kitten { position: absolute; right: 8px; bottom: 6px; width: 172px; height: auto; pointer-events: none; }

  .state { padding: 42px 8px; font-size: 16px; color: var(--ink-soft); text-align: center; }
  .hidden { display: none; }

  .keep {
    position: fixed; left: 14px; right: 14px; bottom: calc(14px + env(safe-area-inset-bottom));
    max-width: 560px; margin: 0 auto;
    height: 52px; border: 0; border-radius: 14px;
    background: var(--cocoa); color: var(--paper);
    font-family: inherit; font-size: 18px; letter-spacing: .12em;
    cursor: pointer; box-shadow: 0 6px 18px rgba(74,59,46,.25);
  }
  .keep:active { background: #4C3A29; }
  .keep:focus-visible { outline: 3px solid var(--rose); outline-offset: 2px; }
</style>
</head>
<body>
  <main class="paper">
    <button type="button" class="heart hidden" id="heart" aria-pressed="false" aria-label="喜欢这张纸条">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.4 C8 16.9 3.4 13.6 3.4 9.3 C3.4 6.4 5.6 4.4 8.1 4.4 C9.7 4.4 11.1 5.2 12 6.5 C12.9 5.2 14.3 4.4 15.9 4.4 C18.4 4.4 20.6 6.4 20.6 9.3 C20.6 13.6 16 16.9 12 20.4 Z"/></svg>
    </button>
    <div class="state" id="loading">正在拆信……</div>
    <div class="state hidden" id="error"></div>
    <section class="hidden" id="note">
      <h1 id="title"></h1>
      <p class="when" id="when"></p>
      <div class="body" id="content"></div>
      <p class="replied hidden" id="replied">这张纸条你已经回过信了。</p>
    </section>
    <svg class="kitten" viewBox="0 0 230 150" aria-hidden="true">
      <!-- 蜷成一团睡着的奶白小猫(小汉堡) -->
      <path d="M60 134 Q30 122 31 96 Q32 83 44 76" fill="none" stroke="#E3CBA0" stroke-width="14" stroke-linecap="round"/>
      <ellipse cx="112" cy="100" rx="76" ry="41" fill="#F6EBD4" stroke="#C9A87C" stroke-width="3"/>
      <path d="M58 112 Q96 92 92 70" fill="none" stroke="#E7D5AF" stroke-width="3" stroke-linecap="round"/>
      <path d="M140 52 L148 27 L163 46 Z" fill="#F6EBD4" stroke="#C9A87C" stroke-width="3" stroke-linejoin="round"/>
      <path d="M146 44 L150 33 L157 42 Z" fill="#EFB9AF"/>
      <path d="M177 52 L189 29 L196 52 Z" fill="#F6EBD4" stroke="#C9A87C" stroke-width="3" stroke-linejoin="round"/>
      <path d="M183 47 L188 37 L192 47 Z" fill="#EFB9AF"/>
      <circle cx="166" cy="76" r="33" fill="#F6EBD4" stroke="#C9A87C" stroke-width="3"/>
      <path d="M149 76 q6 6 12 0" fill="none" stroke="#8A6B4F" stroke-width="2.6" stroke-linecap="round"/>
      <path d="M172 76 q6 6 12 0" fill="none" stroke="#8A6B4F" stroke-width="2.6" stroke-linecap="round"/>
      <path d="M163 87 q4 4 8 0" fill="none" stroke="#C98A82" stroke-width="2.2" stroke-linecap="round"/>
      <circle cx="145" cy="88" r="5.5" fill="#F2C4C4" opacity=".55"/>
      <circle cx="189" cy="88" r="5.5" fill="#F2C4C4" opacity=".55"/>
      <path d="M131 82 L116 79 M131 88 L117 89" stroke="#C9A87C" stroke-width="1.6" stroke-linecap="round"/>
      <path d="M200 82 L214 79 M200 88 L213 89" stroke="#C9A87C" stroke-width="1.6" stroke-linecap="round"/>
      <path d="M96 134 q9 -9 18 0 M122 136 q9 -9 18 0" fill="none" stroke="#C9A87C" stroke-width="3" stroke-linecap="round"/>
      <text x="196" y="34" font-size="19" fill="#C9A87C" transform="rotate(-8 196 34)">z</text>
      <text x="210" y="20" font-size="13" fill="#C9A87C" transform="rotate(-8 210 20)">z</text>
    </svg>
  </main>
  <button type="button" class="keep" id="keep">收好纸条</button>
<script>
(function () {
  "use strict";
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { try { tg.ready(); tg.expand(); tg.setHeaderColor("#EFE8DA"); } catch (e) {} }
  var id = new URLSearchParams(location.search).get("id") || "";
  var $ = function (x) { return document.getElementById(x); };
  var liked = false, likeBusy = false;

  function post(path, body) {
    return fetch(path, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.assign({ id: id, initData: tg ? tg.initData : "" }, body || {})),
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); });
  }
  function fail(msg) {
    $("loading").classList.add("hidden");
    $("error").textContent = msg;
    $("error").classList.remove("hidden");
  }
  function two(n) { return (n < 10 ? "0" : "") + n; }
  function paintHeart() {
    var h = $("heart");
    h.classList.toggle("liked", liked);
    h.setAttribute("aria-pressed", liked ? "true" : "false");
  }

  post("/note-app/api/note").then(function (r) {
    if (!r.j || !r.j.ok) return fail((r.j && r.j.error) || "纸条没取出来,回聊天里再点一次试试。");
    $("loading").classList.add("hidden");
    $("title").textContent = r.j.title;
    var d = new Date(r.j.created_at);
    $("when").textContent = d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日 "
      + two(d.getHours()) + ":" + two(d.getMinutes()) + " 他留下的";
    $("content").textContent = r.j.content;
    if (r.j.replied) $("replied").classList.remove("hidden");
    liked = !!r.j.liked; paintHeart();
    $("heart").classList.remove("hidden");
    $("note").classList.remove("hidden");
  }).catch(function () { fail("网络没接上,回聊天里再点一次试试。"); });

  $("heart").addEventListener("click", function () {
    if (likeBusy) return;
    likeBusy = true;
    liked = !liked; paintHeart();            // 先给手感,失败再翻回来
    post("/note-app/api/like").then(function (r) {
      if (r.j && r.j.ok) liked = !!r.j.liked; else liked = !liked;
      paintHeart(); likeBusy = false;
    }).catch(function () { liked = !liked; paintHeart(); likeBusy = false; });
  });
  $("keep").addEventListener("click", function () {
    if (tg) { try { tg.close(); return; } catch (e) {} }
    window.close();
  });
})();
</script>
</body>
</html>
`;
