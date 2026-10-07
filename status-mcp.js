// status-mcp.js — 把「看一眼她的便签」做成他能调的 MCP 工具 look。
//
// shim 自己就是个 HTTP 服务,claude 子进程又跑在同一个容器里,所以这里直接在
// express 上开一个最小的 Streamable HTTP MCP 端点(POST JSON-RPC),.mcp.json 里
// 指向 http://127.0.0.1:<PORT>/mcp/look 即可,不用多起一个进程。
//
// 安全:这个端点只认**本机回环地址**的连接。外网流量经 Zeabur 网关转发过来,
// remoteAddress 不是回环,直接 403 —— 她的便签不暴露在公网口子上。
import { renderStatus } from "./status.js";

export const LOOK_DESCRIPTION =
  "看一眼她在手机上留的临时状态便签(只有最新一条)。只在确实需要了解她当下情况时调用一次;" +
  "不要轮询、不要连续调用、失败也不要自动重试。返回的是临时信息,不要写进长期记忆、续接信或压缩摘要。" +
  "没有便签不代表任何情绪或意图。";

export const isLoopback = (addr) =>
  addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";

// 处理一条 JSON-RPC 消息,返回 response 对象;通知(无 id)返回 null。
export function handleRpc(msg, { statusFile, now = () => Date.now() } = {}) {
  if (!msg || typeof msg !== "object" || msg.id === undefined || msg.id === null) return null;
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion || "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "look", version: "1.0.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: [{
          name: "look",
          description: LOOK_DESCRIPTION,
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        }],
      });
    case "tools/call": {
      if (msg.params?.name !== "look") {
        return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown tool" } };
      }
      return reply({ content: [{ type: "text", text: renderStatus(statusFile, now()) }], isError: false });
    }
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } };
  }
}

// 挂到 express app 上。只在便签功能启用时由 server.js 调用。
export function mountLookMcp(app, { path = "/mcp/look", statusFile, log = () => {} }) {
  app.post(path, (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) return res.status(403).json({ error: "loopback only" });
    const body = req.body;
    const messages = Array.isArray(body) ? body : [body];
    const responses = messages.map((m) => handleRpc(m, { statusFile })).filter(Boolean);
    for (const m of messages) if (m?.method === "tools/call") log("[look] 他看了一眼便签");
    if (!responses.length) return res.status(202).end();
    res.json(Array.isArray(body) ? responses : responses[0]);
  });
  // Streamable HTTP 的可选 GET(SSE)流:按规范允许直接 405,CLI 能正常处理。
  app.get(path, (_q, res) => res.status(405).end());
}
