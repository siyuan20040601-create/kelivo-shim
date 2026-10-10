// fuyan-write.js — /fuyan/write:安安给傅言投纸条的手机小页面。
//
// 来历:原计划走 iOS 快捷指令,但「快捷指令」App 对自动化操作锁在只点不打的档位,
// 装不进去(2026-10-10 晚实测)。改成这页:iPhone 主屏幕放个图标,点开就是
// 输入框——打字、拍照、按住说话,投出去都进傅言的信箱(fuyan-inbox.js)。
//
// 规矩沿用 /home 那套门锁:登录 POST 表单收暗号(不走 URL 参数),cookie 只限
// /fuyan,30 天滑动续期,10 分钟内错 5 次锁门。页面需要一点 JS(录音与投递),
// CSP 用每次响应现造的 nonce 收紧;投递走本模块自己的 cookie 口,不碰钥匙口。
import { randomUUID, randomBytes } from "node:crypto";
import express from "express";
import { safeEqual } from "./window-admin.js";

const SESSION_MS = 30 * 86400e3;
const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 10 * 60e3;
const COOKIE = "fuyan_door";
const MAX_MEDIA = 20 * 1024 * 1024;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const cookieOf = (req) => {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === COOKIE) return v || "";
  }
  return "";
};

function setHeaders(res, nonce) {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      `default-src 'none'; style-src 'unsafe-inline'; ${nonce ? `script-src 'nonce-${nonce}'; ` : ""}` +
      `connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  });
}

const SHELL_META = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>给傅言留言</title>`;

const CSS = `
  :root{--night:#20242B;--card:#2B303A;--line:#3A414E;--ink:#E8E4DA;--soft:#9AA3B2;
    --seal:#C8793F;--ok:#9BB07E;--paper:#F4EFE4}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--night);color:var(--ink);max-width:480px;margin:0 auto;
    padding:max(24px,env(safe-area-inset-top)) 18px 40px;
    font-family:"Kaiti SC","KaiTi","STKaiti",serif}
  h1{font-size:24px;color:var(--paper);letter-spacing:.08em;text-align:center;margin-top:8px}
  .sub{text-align:center;color:var(--soft);font-size:13.5px;margin-top:6px;line-height:1.7}
  .pad{background:var(--card);border:1px solid var(--line);border-radius:16px;
    padding:14px;margin-top:22px}
  textarea{width:100%;min-height:128px;background:transparent;border:0;outline:0;resize:vertical;
    color:var(--ink);font:inherit;font-size:17px;line-height:1.9}
  textarea::placeholder{color:#6B7483}
  .row{display:flex;gap:10px;margin-top:14px}
  button,.filebtn{flex:1;border:1px solid var(--line);background:#333A46;color:var(--ink);
    font:inherit;font-size:15.5px;border-radius:12px;padding:12px 0;text-align:center;cursor:pointer}
  button.send{background:var(--seal);border-color:var(--seal);color:#1E1710;font-weight:700}
  button:disabled{opacity:.45}
  button.rec-on{background:#7A3A3A;border-color:#8A4444;color:#F3DADA}
  input[type=file]{display:none}
  .toast{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);background:var(--paper);
    color:#4A3B28;font-size:15px;border-radius:12px;padding:10px 20px;opacity:0;
    transition:opacity .3s;pointer-events:none;max-width:86vw;text-align:center}
  .toast.on{opacity:1}
  .hint{color:var(--soft);font-size:12.5px;margin-top:14px;text-align:center;line-height:1.8}
  form.door{margin-top:34vh;text-align:center}
  form.door input{width:100%;background:var(--card);border:1px solid var(--line);border-radius:12px;
    color:var(--ink);font:inherit;font-size:17px;padding:13px 14px;text-align:center}
  form.door button{margin-top:14px;width:100%}
  .err{color:#D98A8A;font-size:14px;margin-top:10px}
  @media (prefers-reduced-motion:reduce){.toast{transition:none}}
`;

function loginPage(msg = "") {
  return `<!doctype html><html lang="zh"><head>${SHELL_META}<style>${CSS}</style></head>
<body><form class="door" method="post" action="/fuyan/write">
<h1>给傅言留言</h1><p class="sub">第一次进来,对一下家门暗号。</p>
<p style="margin-top:22px"><input type="password" name="key" placeholder="暗号" autocomplete="current-password" autofocus></p>
${msg ? `<p class="err">${esc(msg)}</p>` : ""}
<button class="send" type="submit">进门</button>
</form></body></html>`;
}

function page(nonce) {
  return `<!doctype html><html lang="zh"><head>${SHELL_META}<style>${CSS}</style></head>
<body>
<h1>给傅言留言</h1>
<p class="sub">想到什么就投进来,他来的时候先拆信。<br>打字、拍照、按住说话,都行。</p>
<div class="pad">
  <textarea id="txt" placeholder="写给傅言……"></textarea>
  <div class="row">
    <button id="rec" type="button">按住说话</button>
    <label class="filebtn" for="pic">给他看张图</label>
    <input id="pic" type="file" accept="image/*">
    <button id="send" class="send" type="button">投进信箱</button>
  </div>
</div>
<p class="hint">用 Safari 打开这页 → 分享 → 「添加到主屏幕」,以后点图标直达。</p>
<div id="toast" class="toast"></div>
<script nonce="${nonce}">
(function(){
"use strict";
var txt=document.getElementById("txt"),send=document.getElementById("send"),
    rec=document.getElementById("rec"),pic=document.getElementById("pic"),
    toastEl=document.getElementById("toast"),toastT=null;
function toast(m){toastEl.textContent=m;toastEl.classList.add("on");
  clearTimeout(toastT);toastT=setTimeout(function(){toastEl.classList.remove("on")},2600);}
function fail(r){toast(r&&r.status===401?"门锁过期了,刷新一下重新进门":"没投进去,再试一次");}

send.addEventListener("click",function(){
  var t=txt.value.trim();
  if(!t){toast("先写点什么");return;}
  send.disabled=true;
  fetch("/fuyan/write/note",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({text:t})})
  .then(function(r){if(!r.ok)return fail(r);txt.value="";toast("投进去了,他会看到的");})
  .catch(function(){fail();}).finally(function(){send.disabled=false;});
});

pic.addEventListener("change",function(){
  var f=pic.files&&pic.files[0]; if(!f)return;
  if(f.size>${MAX_MEDIA}){toast("图太大了(上限 20MB)");pic.value="";return;}
  toast("在路上…");
  fetch("/fuyan/write/media",{method:"POST",headers:{"content-type":f.type||"image/jpeg"},body:f})
  .then(function(r){toast(r.ok?"图投进去了":"没投进去,再试一次");})
  .catch(function(){fail();}).finally(function(){pic.value="";});
});

// 录音:按住说,松手投。Safari 出 audio/mp4,Chrome 出 audio/webm,信箱都认。
var mr=null,chunks=[],mime="";
function pickMime(){var c=["audio/mp4","audio/webm;codecs=opus","audio/webm"];
  for(var i=0;i<c.length;i++)if(window.MediaRecorder&&MediaRecorder.isTypeSupported(c[i]))return c[i];
  return "";}
function recStop(){if(mr&&mr.state==="recording")mr.stop();rec.classList.remove("rec-on");rec.textContent="按住说话";}
function recStart(ev){
  ev.preventDefault();
  mime=pickMime();
  if(!mime){toast("这个浏览器不支持录音,打字吧");return;}
  navigator.mediaDevices.getUserMedia({audio:true}).then(function(stream){
    chunks=[];mr=new MediaRecorder(stream,{mimeType:mime});
    mr.ondataavailable=function(e){if(e.data&&e.data.size)chunks.push(e.data);};
    mr.onstop=function(){
      stream.getTracks().forEach(function(t){t.stop()});
      var blob=new Blob(chunks,{type:mime.split(";")[0]});
      if(blob.size<800){toast("太短了,没录上");return;}
      toast("在路上…");
      fetch("/fuyan/write/media",{method:"POST",headers:{"content-type":blob.type},body:blob})
      .then(function(r){toast(r.ok?"他会听到的":"没投进去,再试一次");})
      .catch(function(){fail();});
    };
    mr.start();rec.classList.add("rec-on");rec.textContent="松手投出";
  }).catch(function(){toast("麦克风没给权限");});
}
rec.addEventListener("touchstart",recStart,{passive:false});
rec.addEventListener("touchend",function(e){e.preventDefault();recStop();},{passive:false});
rec.addEventListener("mousedown",recStart);
rec.addEventListener("mouseup",recStop);
rec.addEventListener("mouseleave",recStop);
})();
</script>
</body></html>`;
}

// inbox 是 fuyan-inbox.js 的 FuyanInbox 实例:两边共用同一只信箱。
export function mountFuyanWrite(app, { key, inbox, log = () => {} }) {
  app.use("/fuyan/write", express.urlencoded({ extended: false, limit: "4kb" }));
  const sessions = new Map();
  let fails = [];

  const authed = (req) => {
    const t = cookieOf(req);
    const exp = t && sessions.get(t);
    if (!exp || exp < Date.now()) { if (t) sessions.delete(t); return null; }
    sessions.set(t, Date.now() + SESSION_MS);
    return t;
  };

  app.get("/fuyan/write", (req, res) => {
    if (!key) return res.status(404).end();
    if (!authed(req)) { setHeaders(res); return res.status(401).send(loginPage()); }  // 登录页零脚本,CSP 不开 script
    const nonce = randomBytes(16).toString("base64");
    setHeaders(res, nonce);
    res.send(page(nonce));
  });

  app.post("/fuyan/write", (req, res) => {
    if (!key) return res.status(404).end();
    setHeaders(res);
    if (authed(req)) return res.redirect(303, "/fuyan/write");
    const now = Date.now();
    fails = fails.filter((t) => now - t < FAIL_WINDOW_MS);
    if (fails.length >= FAIL_LIMIT) { log("[fuyan-write] 429"); return res.status(429).send(loginPage("敲得太急了,10 分钟后再来")); }
    const supplied = typeof req.body?.key === "string" ? req.body.key : "";
    if (!safeEqual(supplied, key)) {
      fails.push(now);
      log("[fuyan-write] 暗号不对", fails.length, "/", FAIL_LIMIT);
      return res.status(401).send(loginPage("暗号不对,再想想"));
    }
    const token = randomUUID();
    sessions.set(token, now + SESSION_MS);
    log("[fuyan-write] 她进来留言了");
    res.set("Set-Cookie", `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/fuyan; Max-Age=${SESSION_MS / 1000}`);
    res.redirect(303, "/fuyan/write");
  });

  // 投递(cookie 口):与钥匙口殊途同归,落进同一只信箱。
  app.post("/fuyan/write/note", express.json({ limit: "64kb" }), (req, res) => {
    if (!key || !authed(req)) return res.status(401).json({ ok: false });
    const note = inbox.addText(req.body?.text);
    if (!note) return res.status(400).json({ ok: false, error: "空纸条" });
    log("[fuyan] 收到一张纸条:", note.type, `${(note.text || "").length} 字`);
    res.json({ ok: true, id: note.id });
  });

  app.post("/fuyan/write/media",
    express.raw({ type: ["image/*", "audio/*"], limit: MAX_MEDIA }),
    (req, res) => {
      if (!key || !authed(req)) return res.status(401).json({ ok: false });
      const mime = (req.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const note = Buffer.isBuffer(req.body) ? inbox.addMedia(req.body, mime) : null;
      if (!note) return res.status(400).json({ ok: false, error: "格式不认识或文件太大" });
      log("[fuyan] 收到一张纸条:", note.type, note.file);
      res.json({ ok: true, id: note.id, type: note.type });
    });
}
