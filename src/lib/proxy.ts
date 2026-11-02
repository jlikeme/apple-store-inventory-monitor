import type { ProxyBackend, RouteInfo } from "./types";

export function nodeFromRoute(route: string | null, backend: ProxyBackend): string | null {
  const label = backend === "surge" ? "Surge" : "Clash";
  const match = route?.match(/^(Clash|Surge) 节点 (.+?)(（本轮切换 \d+ 次）)?$/);
  return match?.[1] === label && match[2] !== "尚未选定" ? match[2] ?? null : null;
}

export const MAX_NODE_DELAY_MS = 500;

export function nodeTooSlow(node: RouteInfo): boolean {
  return node.name !== "DIRECT" && node.delay !== null && node.delay > MAX_NODE_DELAY_MS;
}

export function nodeUsable(node: RouteInfo): boolean {
  return node.name === "DIRECT" || (node.reachable === true && !nodeTooSlow(node));
}

export function nodeLabel(node: RouteInfo): string {
  const display = node.name.replace(/^APW·/, "");
  const status = node.name === "DIRECT" ? "家宽直连" : node.reachable === null ? "未能确认连通性"
    : !node.reachable ? "不可达" : node.delay === null ? "可达，未返回延迟" : `${node.delay} ms`;
  return `${display} · ${status}${nodeTooSlow(node) ? ` · 超过 ${MAX_NODE_DELAY_MS} ms，已跳过` : ""}${node.resting ? " · 冷却中" : ""}`;
}
