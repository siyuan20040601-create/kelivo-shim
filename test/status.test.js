import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  writeStatus, unwrapText, validateText, freshness, renderStatus, STATUS_MAX_CHARS,
} from "../status.js";
import { handleRpc, isLoopback, LOOK_DESCRIPTION } from "../status-mcp.js";

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "status-")), "now.json");
const H = 3600e3;

test("写入是原子的、只留最新一条、权限 0600", () => {
  const file = tempFile();
  writeStatus(file, "第一条");
  const rec = writeStatus(file, "第二条\n带换行 and English");
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.text, "第二条\n带换行 and English");
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.writtenAt, rec.writtenAt);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(path.dirname(file)).length, 1, "没有历史副本或残留临时文件");
});

test("快捷指令的各种包裹形状只解窄的,任意对象不硬转", () => {
  assert.equal(unwrapText("裸字符串"), "裸字符串");
  assert.equal(unwrapText(["单元素数组"]), "单元素数组");
  assert.equal(unwrapText({ text: "字段text" }), "字段text");
  assert.equal(unwrapText({ input: [{ value: "嵌套两层" }] }), "嵌套两层");
  assert.equal(unwrapText(["a", "b"]), null, "多元素数组不猜");
  assert.equal(unwrapText({ weird: "x" }), null, "未知字段不猜");
  assert.equal(unwrapText(42), null);
});

test("校验:空白、超长、非文字各报各的错,不回显正文", () => {
  assert.equal(validateText("  今天有点忙  ").text, "今天有点忙");
  assert.ok(validateText("   ").error);
  assert.ok(validateText({ bogus: 1 }).receivedShape, "object");
  const long = "好".repeat(STATUS_MAX_CHARS);
  assert.equal(validateText(long).text, long, "恰好到上限可以");
  assert.ok(validateText(long + "多").error, "超一字就拒");
});

test("新鲜度分档与渲染:当前/较旧/过期/超24h只给时间", () => {
  const file = tempFile();
  const now = Date.now();
  writeStatus(file, "去健身了", now - 1 * H);
  assert.equal(freshness(JSON.parse(fs.readFileSync(file, "utf8")).writtenAt, now), "current");
  assert.match(renderStatus(file, now), /去健身了/);

  writeStatus(file, "去健身了", now - 5 * H);
  const stale = renderStatus(file, now);
  assert.match(stale, /去健身了/);
  assert.match(stale, /旧|别当成此刻/);

  writeStatus(file, "去健身了", now - 12 * H);
  const expired = renderStatus(file, now);
  assert.match(expired, /去健身了/);
  assert.match(expired, /过期/);

  writeStatus(file, "去健身了", now - 30 * H);
  const gone = renderStatus(file, now);
  assert.ok(!gone.includes("去健身了"), "超过24小时不给正文");
  assert.match(gone, /最后一次/);
});

test("无文件与读取故障是两种不同的回答", () => {
  const missing = renderStatus(tempFile());
  assert.match(missing, /没有留下/);
  assert.match(missing, /不代表任何情绪/);
  const file = tempFile();
  fs.writeFileSync(file, "{broken json");
  const broken = renderStatus(file);
  assert.match(broken, /没能读取/);
  assert.ok(!broken.includes("没有留下"), "故障绝不说成「没留便签」");
});

test("look MCP:initialize/tools list/call 走通,未知方法报错,通知不回包", () => {
  const file = tempFile();
  writeStatus(file, "在外面吃饭");
  const opts = { statusFile: file };
  const init = handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, opts);
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.ok(init.result.capabilities.tools);
  const list = handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, opts);
  assert.equal(list.result.tools.length, 1);
  assert.equal(list.result.tools[0].name, "look");
  assert.equal(list.result.tools[0].description, LOOK_DESCRIPTION);
  assert.deepEqual(list.result.tools[0].inputSchema.properties, {}, "无参数工具");
  const call = handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "look", arguments: {} } }, opts);
  assert.match(call.result.content[0].text, /在外面吃饭/);
  assert.equal(handleRpc({ jsonrpc: "2.0", id: 4, method: "nope" }, opts).error.code, -32601);
  assert.equal(handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, opts), null);
  assert.equal(handleRpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "other" } }, opts).error.code, -32602);
});

test("look 端点只认回环地址", () => {
  assert.ok(isLoopback("127.0.0.1"));
  assert.ok(isLoopback("::1"));
  assert.ok(isLoopback("::ffff:127.0.0.1"));
  assert.ok(!isLoopback("10.0.0.7"));
  assert.ok(!isLoopback("::ffff:10.0.0.7"));
  assert.ok(!isLoopback(undefined));
});
