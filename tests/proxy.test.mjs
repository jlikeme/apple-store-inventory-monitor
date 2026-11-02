import test from "node:test";
import assert from "node:assert/strict";
import { nodeFromRoute, nodeLabel } from "../src/lib/proxy.ts";

test("route labels only select nodes from the current backend", () => {
  assert.equal(nodeFromRoute("Clash 节点 香港01（本轮切换 2 次）", "clash"), "香港01");
  assert.equal(nodeFromRoute("Surge 节点 日本01", "surge"), "日本01");
  assert.equal(nodeFromRoute("Clash 节点 香港01", "surge"), null);
  assert.equal(nodeFromRoute("Surge 节点 尚未选定", "surge"), null);
  assert.equal(nodeFromRoute(null, "surge"), null);
});

test("missing latency distinguishes reachable, unreachable and untested nodes", () => {
  const node = { name: "香港01", delay: null, reachable: true, resting: false };
  assert.match(nodeLabel(node), /可达，未返回延迟/);
  assert.match(nodeLabel({ ...node, reachable: false }), /不可达/);
  assert.match(nodeLabel({ ...node, reachable: null }), /未能确认/);
  assert.match(nodeLabel({ ...node, delay: 125, resting: true }), /125 ms · 冷却中/);
  assert.match(nodeLabel({ ...node, name: "DIRECT" }), /家宽直连/);
});

test("500ms nodes are usable but slower nodes are excluded", async () => {
  const { nodeTooSlow, nodeUsable } = await import("../src/lib/proxy.ts");
  const node = { name: "香港01", delay: 500, reachable: true, resting: false };
  assert.equal(nodeUsable(node), true);
  assert.equal(nodeTooSlow(node), false);
  assert.equal(nodeUsable({ ...node, delay: 501 }), false);
  assert.match(nodeLabel({ ...node, delay: 501 }), /超过 500 ms，已跳过/);
  assert.equal(nodeUsable({ ...node, delay: null }), true);
  assert.equal(nodeUsable({ ...node, reachable: null }), false);
  assert.equal(nodeUsable({ ...node, name: "DIRECT", delay: null }), true);
});
