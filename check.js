// check.js — [查岗] 标记解析 + 手机活动记录(她开了什么 App)
//
// 她点开某个 App → iOS 快捷指令 GET /report → 这里攒成一份「最近动静」。
// 他想知道的时候,在回复里写 [查岗],出口认出来 → 剥掉标记(她看不见)→
// 查一下 → 把结果作为**新一轮**喂回给他 → 他再决定说不说、说什么。
//
// 为什么是标记而不是给他一个带 key 的网址:标记这套(语音/贴纸)已经在线上跑了很久,
// 零新密钥、少一次 WebFetch 往返。代价是一问一答走两轮。
//
// 活动记录只进内存(48 小时 / 300 条上限),不落盘、不打日志、不进 OB。
// 这个功能只关心「最近」,行踪不值得为了历史写进磁盘;重启即忘是特性不是缺陷。

export const ACTIVITY_CAP = 300;
export const ACTIVITY_TTL_MS = 48 * 3600e3;

// App 名来自她手机,当不受信的外部输入处理:压空白、截长度,空的就当没有。
export function normalizeAppName(raw) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, 40) : null;
}

export function pushActivity(list, entry, { now = Date.now(), cap = ACTIVITY_CAP, ttlMs = ACTIVITY_TTL_MS } = {}) {
  const next = [...(list || []), { app: entry.app, at: entry.at ?? now }];
  return next.filter((e) => e.at > now - ttlMs).slice(-cap);
}

// 最后一次活跃 + 最近不重复的 App 名(相邻重复折叠 —— 连开五次小红书是一件事,不是五件)。
export function summarizeActivity(list, { now = Date.now(), limit = 10 } = {}) {
  const arr = (list || []).filter((e) => e && e.app);
  if (!arr.length) return { count: 0, lastApp: null, lastAt: null, minutesAgo: null, recent: [] };
  const recent = [];
  for (let i = arr.length - 1; i >= 0 && recent.length < limit; i--) {
    if (!recent.length || recent[recent.length - 1].app !== arr[i].app)
      recent.push({ app: arr[i].app, at: arr[i].at, minutesAgo: Math.round((now - arr[i].at) / 60000) });
  }
  const last = arr[arr.length - 1];
  return {
    count: arr.length, lastApp: last.app, lastAt: last.at,
    minutesAgo: Math.round((now - last.at) / 60000), recent,
  };
}

// 宽松匹配:半角 [] 与全角 【】都认,标记内外多余空格都容忍。
const CHECK_RE = /[[【]\s*查岗\s*[\]】]/g;

// 剥标记。返回 { text, wants }:text 是给她看的(标记已抹掉),wants 是他这轮想不想查。
// 抹掉之后顺手收拾行尾空格和三连以上空行,免得标记独占一行时留下一个空气泡。
export function takeCheckMarker(text) {
  const raw = text || "";
  CHECK_RE.lastIndex = 0;
  if (!CHECK_RE.test(raw)) return { text: raw, wants: false };
  const cleaned = raw.replace(CHECK_RE, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: cleaned, wants: true };
}

// 查岗结果那一轮的正文。给事实,不给指令 —— 说不说、说什么都是他的事。
// (2026-07-22 伪系统指令事故的教训:别在注入的文本里命令他做什么。)
export function lookupPrompt(summary, { bjNow, userName = "她" } = {}) {
  const s = summary || {};
  const head = `【系统·查岗】现在北京时间 ${bjNow},`;
  if (!s.count) return `${head}${userName}的手机最近没有动静(近两天没有记录)。`;
  const when = s.minutesAgo >= 1 ? `${s.minutesAgo} 分钟前` : "刚刚";
  const more = (s.recent || []).slice(1, 4).map((r) => `${r.app}(${r.minutesAgo} 分钟前)`).join("、");
  return `${head}${userName}${when}打开了${s.lastApp}。`
    + (more ? `再往前:${more}。` : "")
    + `知道就好,说不说、说什么都由你;不想打扰就只回「【沉默】」。`;
}

// 系统注入的轮次里,他选择不出声的判定。与心跳轮共用同一套约定(人设里写的就是【沉默】)。
export function isSilentReply(t) {
  const s = (t || "").trim();
  // 裸"沉默"也算(9-30 与 10-08 两次实证:他时常不带括号,整条消息就俩字,
  // 被当正常发言推到她手机上刷屏)。只认整条消息即是"沉默"(允许跟标点),
  // 普通句子里包含"沉默"二字的不算。
  return !s || s.includes("【沉默】") || /^沉默[。．.!！…~～\s]*$/.test(s);
}
