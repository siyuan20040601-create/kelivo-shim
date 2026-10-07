import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ThresholdState } from "../window-threshold-state.js";

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "thr-")), "window-thresholds.json");
const SID = "a1000000-0000-4000-8000-000000000001";

test("同一会话的 warned/archived 跨重启还在;compact 后重置", () => {
  const file = tempFile();
  const a = new ThresholdState(file);
  assert.deepEqual(a.get(SID), { warned: false, archived: false });
  a.set(SID, { warned: true });
  a.set(SID, { archived: true });

  const b = new ThresholdState(file); // 模拟重启后恢复同一会话
  assert.deepEqual(b.get(SID), { warned: true, archived: true }, "不会重复提醒/重复归档");

  b.reset(SID); // 真实 compact_boundary
  const c = new ThresholdState(file);
  assert.deepEqual(c.get(SID), { warned: false, archived: false });
});

test("没配文件(旧模式)= 纯内存,不写盘也不报错", () => {
  const s = new ThresholdState(null);
  s.set(SID, { warned: true });
  assert.equal(s.get(SID).warned, true);
  s.reset(SID);
  assert.equal(s.get(SID).warned, false);
});

test("损坏的文件按全新处理;旧会话条目有上限不无限膨胀", () => {
  const file = tempFile();
  fs.writeFileSync(file, "{broken");
  const s = new ThresholdState(file);
  assert.deepEqual(s.get(SID), { warned: false, archived: false });
  for (let i = 0; i < 30; i++) s.set(`a1000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`, { warned: true });
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(Object.keys(saved).length <= 20, "最多留 20 个会话");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("sessionId 为空(旧模式/会话未知)时 set/reset 都是空操作", () => {
  const file = tempFile();
  const s = new ThresholdState(file);
  s.set(null, { warned: true });
  s.set(undefined, { archived: true });
  s.reset(null);
  assert.ok(!fs.existsSync(file) || !Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).length);
});
