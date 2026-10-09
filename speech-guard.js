// speech-guard.js — 台词守门员:拦下模型把「后台道具」当台词说出去的那类走神。
//
// 2026-10-08 晚间事故(哥哥线,两小时内三次复发):模型在正文里写出
// user【时间 …】/ system<total_tokens…> / think…end 这些管道记号,还替她编了
// 她的回合,然后对着自己编的那句自问自答。说出去的字又留在它自己的窗口里,
// 变成下一次走神的范本 —— 所以必须在出口没收,不能只靠口头纠正。
//
// 规则(刻意保守,宁可漏拦不误伤正文):
//   1) 伪造回合:扫描到**行首**的 user / assistant / system< / 【系统· 标记,
//      从那一行起整段截断 —— 后面全是替别人演的戏,一个字不许出门;
//   2) 漏出的思考:整段以 think 开头时,剥到第一个独立的 end 为止;
//      没有 end 就整段没收(后台独白见光,比沉默伤人,22:16 那段她都看见了);
//   3) 回显的时间戳:开头的【时间 …】行剥掉(人设里本来就不许复述);
//   4) 其余一律原样放行。
// 返回 { text, cut }:cut=true 表示动过刀,调用方记一条日志即可,不用告警。
const TURN_MARK = /^(user\b|user【|assistant\b|system<|【系统·)/;

export function guardSpeech(raw) {
  let text = String(raw ?? "");
  let cut = false;

  // 3) 开头回显的时间戳行
  const ts = text.match(/^\s*【时间 [^】\n]{0,40}】\s*\n?/);
  if (ts) { text = text.slice(ts[0].length); cut = true; }

  // 2) 漏出的思考外皮:think……end(end 需独立,不吃 ending/endless)
  if (/^\s*think(?![a-z])/i.test(text)) {
    const m = /(?:^|[^a-z])end(?![a-z])/i.exec(text);
    if (m) {
      text = text.slice(m.index + m[0].length);
      cut = true;
    } else {
      return { text: "", cut: true };   // 整段都是后台独白,全部没收
    }
  }

  // 1) 伪造的下一回合:行首标记起全部截断
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (TURN_MARK.test(lines[i].trim())) {
      text = lines.slice(0, i).join("\n");
      cut = true;
      break;
    }
  }

  return { text: text.replace(/^\s+/, ""), cut };
}
