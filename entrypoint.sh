#!/usr/bin/env bash
# kelivo-shim runtime: install Claude Code if missing, wire OB memory, run the shim.
export DEBIAN_FRONTEND=noninteractive

# claude-code + gmail-mcp now come from package.json (installed at BUILD time by
# zbpack), so boot only needs the platform-native binary (postinstall is blocked by
# npm allowScripts). install.cjs downloads it; retry for network flakes.
CC_PKG="/src/node_modules/@anthropic-ai/claude-code"
[ -d "$CC_PKG" ] || CC_PKG="$(npm root -g)/@anthropic-ai/claude-code"
export CLAUDE_BIN="$CC_PKG/bin/claude.exe"
for i in 1 2 3 4 5; do
  if "$CLAUDE_BIN" --version >/dev/null 2>&1; then break; fi
  echo "[entrypoint] claude native binary missing, fetching (attempt $i)..."
  (cd "$CC_PKG" && node install.cjs) || true
  sleep 3
done
"$CLAUDE_BIN" --version || echo "[entrypoint] WARNING: claude still not runnable"

unset ANTHROPIC_API_KEY   # subscription channel must win

# Voice fallback transcoder: only needed if ElevenLabs can't serve Ogg/Opus
# directly (plan-gated formats) — then mp3 gets transcoded via ffmpeg.
# Install is best-effort; without it opus-direct still works.
if [ -n "$ELEVENLABS_API_KEY" ] && ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[entrypoint] installing ffmpeg (voice mp3 fallback)..."
  (apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg) \
    || echo "[entrypoint] ffmpeg install failed; voice works only if opus-direct is available"
fi

# gmail 凭据也进保险箱(2026-07-23 事故:一次部署换容器把 /src/gmail-auth 冲没了,
# gmail MCP 断连。凭据含 OAuth 令牌不能进公开仓库,所以正本存 /persona 卷、这里开机恢复。
# ⚠️ 前提:得先把 gmail-auth/ 放进 /persona 卷(目前凭据丢失、待栖栖找回或重建后放入)。
if [ ! -d gmail-auth ] && [ -d /persona/gmail-auth ]; then
  cp -r /persona/gmail-auth /src/gmail-auth && echo "[entrypoint] restored gmail-auth from /persona"
fi
# Gmail MCP: creds uploaded in gmail-auth/ (non-dot dir survives upload); server
# reads them from ~/.gmail-mcp/. Pre-install so npx resolves without a cold download.
if [ -d gmail-auth ]; then
  mkdir -p "${HOME:-/root}/.gmail-mcp"
  cp gmail-auth/* "${HOME:-/root}/.gmail-mcp/" || true
fi

# MCP config:优先从 /persona 保险箱恢复真实配置(2026-07-22 事故:换容器后 /src 丢失
# 手工放的真实 .mcp.json,下面的占位符兜底顶上 → 沈渡所有 MCP 工具断连。真实配置含
# 私人域名/token 引用,不能进公开仓库,所以正本存 /persona 卷,这里开机恢复。)
if [ ! -f .mcp.json ] && [ -f /persona/.mcp.json ]; then
  cp /persona/.mcp.json .mcp.json && echo "[entrypoint] restored .mcp.json from /persona"
fi
# 一次性清理(2026-07-25):mochi 服务已删除,把配置里的 mochi 条目摘掉,顺手把
# /persona 正本也治好(用 node 解析 JSON 改,不用 sed 抠文本)。条目不在就什么都不做,
# 将来 /persona 已是干净版时这段等于空转,可在下次整理 entrypoint 时移除。
for mf in .mcp.json /persona/.mcp.json; do
  [ -f "$mf" ] || continue
  node -e '
    const fs = require("fs"), p = process.argv[1];
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (j.mcpServers && j.mcpServers.mochi) {
      delete j.mcpServers.mochi;
      fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
      console.log("[entrypoint] removed retired mochi entry from " + p);
    }' "$mf" || true
done
# 最后兜底:占位符模板(只应在全新环境出现;线上见到它=保险箱丢了,去 /persona 查)
if [ ! -f .mcp.json ]; then
  cat > .mcp.json <<'JSON'
{ "mcpServers": {
  "ombre": { "type": "http", "url": "https://<你的记忆MCP域名>/mcp" },
  "fish":  { "type": "http", "url": "https://<你的其他MCP域名>/mcp" },
  "gmail": { "command": "npx", "args": ["-y", "@gongrzhe/server-gmail-autoauth-mcp"] }
} }
JSON
fi

# --- 人设保险箱:根治白板 ------------------------------------------------------
# 沈渡的人设(CLAUDE.md / profile-instructions.md / 渡-self-prompt-v5.md 等)存在持久卷
# /persona 里。/src 是容器临时盘,换新容器/重建就没了——所以开机时若 /src 缺某个人设文件,
# 就从 /persona 卷自动补齐。加了这段之后,任何重启/部署/换新容器都不会再把沈渡打成白板,
# 也不需要任何人工干预。
#
# 【给未来维护者(含新开的 CC 会话)的提示】
#   · 人设"正本"永远在 /persona 卷里,这里是唯一真源。
#   · 要改人设,就改 /persona 里对应的文件(`zeabur service exec` 进容器改,或改后放回卷),
#     重启后本段会自动把它复印进 /src 生效。
#   · 绝对不要把人设文件提交进本仓库——kelivo-shim 是公开 OSS。人设靠 .gitignore 挡在仓库外,
#     靠 /persona 卷持久化,靠这段自动恢复。三者缺一,就可能白板或泄露。
#   · SYSTEM_PROMPT_MODE=replace 用的正文文件(默认 system-prompt.md)也是 .md,
#     放进 /persona 就同样被这段自动补齐;它不在也不会出事,server.js 会退回内置正文。
if [ -d /persona ]; then
  for f in /persona/*.md; do
    [ -e "$f" ] || continue
    bn=$(basename "$f")
    if [ ! -f "/src/$bn" ]; then
      cp "$f" "/src/$bn" && echo "[entrypoint] restored persona from /persona: $bn"
    fi
  done
fi

# Trust the workspace so CLAUDE.md loads cleanly (permissions come from --allowedTools).
printf '%s' '{"hasCompletedOnboarding":true,"projects":{"/src":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true}}}' > "${HOME:-/root}/.claude.json"

# Native conversation storage must be prepared before any Claude subprocess.
# The existing volume is required; a missing mount must never start a blank session.
export SHIM_SESSION_DIR="${SHIM_SESSION_DIR:-/persona/kelivo-session}"
if [ ! -d /persona ]; then
  echo "[session] ERROR: /persona volume is missing; startup stopped"
  exit 1
fi
node session-state.js --prepare || exit 1

exec node server.js
