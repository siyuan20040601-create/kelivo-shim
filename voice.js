// voice.js — [语音] 标记解析 + ElevenLabs TTS(Telegram 语音条用)
//
// 回复文本里 [语音]English content[/语音] 包住的段落转成 Ogg/Opus 语音,
// 其余照常发文字,顺序保持混排。任何环节失败由调用方降级为文字,内容不丢。

import { spawn } from "child_process";

// 宽松匹配:方括号接受半角 [] 与全角 【】 混用,斜杠接受半角/全角。
// 未闭合的开标记匹配不上 → 原样当普通文本,不吞字。
const VOICE_RE = /[\[【]\s*语音\s*[\]】]([\s\S]*?)[\[【]\s*[/／]\s*语音\s*[\]】]/g;

// 中文也出声(2026-10-10 拆闸):早期计划的音色按英文调,所以这里曾有一道
// 「语音段含 CJK 就退回文字」的保底闸。今天正式启用的音色是安安在 ElevenLabs
// 亲自挑的中文男声 + eleven_multilingual_v2 多语言模型,中文才是主场 ——
// 旧闸不拆,张辰的中文语音段会被安静按成文字,不出声也不报错(10-10 实锤)。
// 念坏了也有兜底:TTS 失败由调用方降级为文字,内容不丢。

// 把一轮回复切成 [{ type: "text"|"voice", content }] 有序段落。
// 空白的语音段丢弃;文字段原样保留(交给发送方自己 trim/分行)。
export function splitVoiceSegments(text) {
  const segs = [];
  let last = 0;
  VOICE_RE.lastIndex = 0;
  for (let m; (m = VOICE_RE.exec(text)); ) {
    if (m.index > last) segs.push({ type: "text", content: text.slice(last, m.index) });
    const inner = m[1].trim();
    if (inner) segs.push({ type: "voice", content: inner });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ type: "text", content: text.slice(last) });
  return segs;
}

// ElevenLabs TTS → Ogg/Opus Buffer(Telegram sendVoice 要求的格式)。
// 优先请求 opus 直出;拿不到(部分 output_format 有套餐门槛)退 mp3 + ffmpeg 转码。
// voiceSettings 整个对象透传(speed/stability/similarity_boost/style/use_speaker_boost),
// 配方由人耳盲测定,见机教版环境变量表。
export async function ttsOgg({ text, apiKey, voiceId, modelId, voiceSettings, log = () => {} }) {
  const call = async (fmt) => {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${fmt}`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: modelId, voice_settings: voiceSettings }),
        signal: AbortSignal.timeout(60000),
      }
    );
    if (!r.ok) throw new Error(`elevenlabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return Buffer.from(await r.arrayBuffer());
  };
  try {
    return await call("opus_48000_64");
  } catch (e) {
    log("[voice] opus direct failed, falling back to mp3+ffmpeg:", e.message);
    return mp3ToOgg(await call("mp3_44100_128"));
  }
}

function mp3ToOgg(mp3) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-i", "pipe:0", "-c:a", "libopus", "-b:a", "48k", "-f", "ogg", "pipe:1"],
      { stdio: ["pipe", "pipe", "pipe"] });
    const out = [], err = [];
    ff.stdout.on("data", (d) => out.push(d));
    ff.stderr.on("data", (d) => err.push(d));
    ff.on("error", reject); // ffmpeg 未安装等
    ff.on("close", (code) => code === 0 && out.length
      ? resolve(Buffer.concat(out))
      : reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(err).toString().slice(-200)}`)));
    ff.stdin.on("error", () => {}); // EPIPE 由 close 兜底
    ff.stdin.end(mp3);
  });
}

// ---- 简版耳朵(2026-10-10,安安:「先弄简单版」)---------------------------------
// 她在 TG 发语音,他至少要听懂**说了什么**。完整版「耳朵」(转写+语气+声音基线)
// 是栋单独的小楼(EARS_URL),还没盖;在那之前,用同一把 ElevenLabs 钥匙走官方
// 转写接口,只出文字,不出语气。模型名可换(scribe_v1 下架就换下一代),不必改代码。
export async function sttText({ ogg, apiKey, modelId = "scribe_v1" }) {
  const fd = new FormData();
  fd.append("file", new Blob([ogg], { type: "audio/ogg" }), "voice.ogg");
  fd.append("model_id", modelId);
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST", headers: { "xi-api-key": apiKey }, body: fd,
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error(`elevenlabs stt ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();   // { text, language_code, ... }
}

// 转写结果 → 给他看的一行。与完整版 voiceLine 同款口径([语音] 开头),
// 以后换成完整耳朵时他那边的体感不变,只是多出语气括号。
export function simpleEarLine(j = {}) {
  const said = (j.text || "").trim();
  return said ? `[语音] ${said}` : "(她发来一条语音,但没听清内容)";
}
