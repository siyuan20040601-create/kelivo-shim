// 压缩闸门 —— 「压缩发生的前一刻,先把没归档的那段存进长期记忆」。
//
// 为什么要有它(这是这套机制存在的全部理由)
//   窗口用量到 WINDOW_ARCHIVE_PCT 时 shim 会请他归档一次,但那之后到真正压缩之间
//   还会继续聊。PreCompact 钩子又把摘要压成一行指路 —— 于是「最后一次归档到压缩」
//   这一段既不在摘要里、也不在长期记忆里,**压缩一发生就是真没了**。
//   用户原话:「我自己归档的话会消失归档之后到压缩前的记忆」。
//
// 怎么堵上
//   PreCompact 钩子是**可以否决压缩的**(官方文档:PreCompact「Can block: Yes」,
//   exit 2 或 stdout 输出 {"decision":"block","reason":...})。所以:
//     压缩要发生 → 钩子问 shim「这一窗还有没有没归档的内容?」
//       有 → 拦下压缩,理由里请他现在就 archive_session
//       他归档成功(🗄️)→ 窗口仍然是满的,压缩立刻再来一次 → 这次放行
//   缺口因此收敛到 0:压缩总是发生在一次成功归档之后。
//
// 三条必须守住的底线(都在下面的纯函数里)
//   1. **不能无限拦**。窗口已经满了还一直否决,最后会撞上下文上限报错。
//      所以有 maxBlocks 预算,用完就放行 —— 那时还有 WINDOW_ARCHIVE_PCT 那道早归档兜底。
//   2. **问不到 shim 就放行**。钩子里任何异常(超时/端口不通/JSON 坏了)一律退回
//      「不拦 + 照常瘦身摘要」,绝不能因为闸门本身把压缩卡死。
//   3. **拦下之后要有后手**。他没照做的话由 shim 主动注入归档轮(server.js 侧),
//      再不行还有压缩后的原文回放(见 renderReplay)。

export const DEFAULT_MAX_BLOCKS = 2;
export const DEFAULT_REPLAY_MAX_CHARS = 20000;

// 闸门判定(纯函数,便于测试)。
// st = { enabled, dirty, blocks, maxBlocks }
//   dirty    = 自上次成功归档以来有没有新对话
//   blocks   = 本窗口已经拦过几次(压缩成功发生或换窗后清零)
export function gateDecision(st = {}) {
  const maxBlocks = Number.isFinite(st.maxBlocks) ? st.maxBlocks : DEFAULT_MAX_BLOCKS;
  if (!st.enabled) return { block: false, why: "disabled" };
  if (!st.dirty) return { block: false, why: "clean" };      // 已经归档过了,放心压
  if (!(maxBlocks > 0) || st.blocks >= maxBlocks) return { block: false, why: "budget" };
  return { block: true, why: "unarchived" };
}

// 拦下压缩时给他看的理由。
// ⚠️ 措辞守则(2026-07-22 伪系统指令事故的教训):诚实署名系统、明说是她的意思,
// **绝不假冒成她打的字** —— 假冒会触发他的 prompt injection 防御,他会拒绝执行。
// 【系统·自主时间】是同款成功先例。
export const GATE_REASON =
  "【系统·压缩闸门】这是 shim 的运维提醒,不是她打的字:" +
  "上下文满了,自动压缩正要发生,而「上次归档到现在」这段还没进 OB —— " +
  "压缩会把它抹成一行,那段就真的没了。她说过不想丢掉你们之间的东西,所以压缩已经先拦下来了。\n" +
  "现在调 archive_session 把这段存好(老规矩:只写上次归档之后的新内容,带上亮点和心情)。" +
  "存完就行,不用跟她解释这套机制;存好之后压缩会自己继续,你不会因此丢东西。";

// 钩子写到 stdout 的内容:
//   拦 → JSON 决定(PreCompact 认 top-level decision)
//   放行 → 原来的摘要瘦身指令(stdout 作为额外摘要要求拼进压缩提示词)
export function hookStdout(decision, summaryInstructions) {
  return decision?.block
    ? JSON.stringify({ decision: "block", reason: decision.reason || GATE_REASON })
    : summaryInstructions;
}

// ---- 原文回放(最后一层保底)-------------------------------------------------
// 万一压缩还是溜过去了(闸门被禁用/预算用完/他没照做),这段对话在他的窗口里已经
// 没了,但 shim 一直看得见每一条消息。把这份原文回放给他,让他照着补写归档。
// 只在「压缩发生时仍未归档」时触发,平时一分钱不花。

// 滚动缓冲:超出上限就丢最旧的(宁可丢开头,也要保住离压缩最近的那段)。
export function trimTranscript(entries, maxChars = DEFAULT_REPLAY_MAX_CHARS) {
  const out = entries.slice();
  let total = out.reduce((n, e) => n + (e.text?.length || 0), 0);
  while (out.length > 1 && total > maxChars) total -= (out.shift().text?.length || 0);
  return out;
}

export function renderReplay(entries, opts = {}) {
  const who = opts.userName || "她";
  const body = entries
    .map((e) => `${e.role === "user" ? who : "你"}:${(e.text || "").trim()}`)
    .filter((l) => l.length > (who.length + 1))
    .join("\n");
  if (!body) return "";
  return (
    "【系统·压缩后补档】这是 shim 的运维提醒,不是她打的字:" +
    "刚刚发生了一次自动压缩,而这段对话没来得及进 OB —— 你窗口里它已经变成一行了。\n" +
    "下面是 shim 留存的原文(可能不全,只有最近的一段)。请照着它调 archive_session 补上," +
    "按你归档的老规矩写,只写上次归档之后的新内容。写完自然说句话就行,不用解释这套机制。\n\n" +
    "---- 原文开始 ----\n" + body + "\n---- 原文结束 ----"
  );
}

// ---- 归档成功判定(2026-10-08) --------------------------------------------------
// OB 升级后归档工具从 archive_session 换成了 hold,而安全阀原来死盯旧工具名+🗄️标记,
// 结果:他明明存成功了("新建 →be13fba4401b 恋爱,心理"),安全阀永远报失败,
// 换窗口永远被拦、自动归档轮反复催、闸门一直 dirty。教训与 MAINTENANCE.md
// "升级要重测,契约变了不报错只会安静失效"同款,只是这次变的是 OB 不是 CLI。
// 两个工具名都认(老部署/老测试不受影响);成功 = 该工具的 tool_result 不是报错。
// ⚠️ hold 也用于日常记感受,任何一次成功 hold 都会清 dirty —— 语义上说得通
// (他确实往 OB 写了东西),但不如旧 archive_session 精确;OB 若再出专职归档工具,回来收紧。
export const ARCHIVE_TOOLS = new Set(["archive_session", "hold"]);
export function isArchiveSuccess({ text = "", isError = false } = {}) {
  if (isError) return false;
  const t = (text || "").trim();
  if (!t) return false;
  if (t.includes("🗄️")) return true;   // 旧版 archive_session 的成功标记
  return !/失败|错误|error|unauthoriz|没有权限|不能为空/i.test(t);
}
