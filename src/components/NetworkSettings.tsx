import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, FileCode2, Globe, LoaderCircle, PlugZap, RefreshCw } from "lucide-react";
import { Combobox } from "@/components/Combobox";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getCurrentProxyNode, listProxyNodes, saveNetworkSettings, selectProxyNode, testProxyRoute } from "@/lib/store";
import { MAX_NODE_DELAY_MS, nodeFromRoute, nodeLabel, nodeTooSlow, nodeUsable } from "@/lib/proxy";
import type {
  ProxyRouteCheck,
  ProxyBackend,
  ClashSettings,
  NetworkMode,
  NetworkSettings as Network,
  RouteList,
} from "@/lib/types";

const MODE_HINTS: Record<NetworkMode, string> = {
  system: "跟随系统代理，出口由系统代理或增强模式的规则决定。",
  pinned: "经所选代理软件的专用端口固定使用指定节点，不自动切换；选 DIRECT 即用本机网络。",
  clash: "只走专用端口；节点被 Apple 拒绝时冷却并换下一个，不影响电脑本身的节点。",
};

const MODE_LABELS: Record<NetworkMode, string> = {
  system: "跟随系统代理",
  pinned: "指定节点",
  clash: "节点轮换",
};

/** Clash Verge「全局扩展脚本」模板，与 README 中的脚本保持一致。 */
const SCRIPT_TEMPLATE = "// Clash Verge「全局扩展脚本」：节点只供果到雷达的专用端口使用，不影响电脑本身的节点\nconst APW_PREFIX = \"APW·\";\nconst APW_GROUP = __GROUP__;\nconst APW_SUBSCRIPTIONS = {\n  机场1: \"机场订阅地址\",\n};\n\nfunction main(config, profileName) {\n  const providers = config[\"proxy-providers\"] || {};\n  const used = [];\n  for (const [label, url] of Object.entries(APW_SUBSCRIPTIONS)) {\n    if (!/^https?:\\/\\//.test(url)) continue;\n    const key = `apw-${label}`;\n    providers[key] = {\n      type: \"http\",\n      url,\n      interval: 86400,\n      path: `./providers/${key}.yaml`,\n      override: { \"additional-prefix\": `${APW_PREFIX}${label}|` },\n      \"health-check\": { enable: false },\n    };\n    used.push(key);\n  }\n  config[\"proxy-providers\"] = providers;\n\n  // 原有策略组若自动收录全部节点（include-all / include-all-providers），排除专用节点\n  const guard = `^${APW_PREFIX}`;\n  const groups = (config[\"proxy-groups\"] || []).filter((g) => g.name !== APW_GROUP);\n  for (const group of groups) {\n    if (group[\"include-all\"] || group[\"include-all-providers\"]) {\n      const old = group[\"exclude-filter\"];\n      if (old && old.includes(guard)) continue;\n      group[\"exclude-filter\"] = old ? `(?:${old})|${guard}` : guard;\n    }\n  }\n  groups.push({ name: APW_GROUP, type: \"select\", proxies: [\"DIRECT\"], use: used });\n  config[\"proxy-groups\"] = groups;\n\n  const listeners = (config.listeners || []).filter((l) => l.name !== \"apple-store-monitor\");\n  listeners.push({ name: \"apple-store-monitor\", type: \"mixed\", port: __PORT__, listen: \"127.0.0.1\", proxy: APW_GROUP });\n  config.listeners = listeners;\n  return config;\n}";

function configSnippet(clash: ClashSettings): string {
  return SCRIPT_TEMPLATE.replace("__GROUP__", JSON.stringify(clash.group || "果到雷达")).replace(
    "__PORT__",
    String(clash.proxyPort),
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 rounded-lg"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied ? "已复制" : label}
    </Button>
  );
}

function GuideStep({ index, title, children }: { index: number; title: string; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
      <span
        className="flex size-7 items-center justify-center rounded-full border border-border/70 bg-muted/40 text-xs font-semibold tabular-nums"
        aria-hidden="true"
      >
        {index}
      </span>
      <div className="min-w-0 pt-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="mt-1.5 space-y-2 text-[13px] leading-6 text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] leading-4 break-words text-muted-foreground">{children}</p>;
}

/** 醒目的界面名称，例如菜单、按钮。 */
function Ui({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-foreground">{children}</span>;
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-xs text-foreground">{children}</code>;
}

/** 手把手的 Clash 配置教程。用户不必查 README 也能完成节点轮换的配置。 */
function ClashSetupGuide({ clash }: { clash: ClashSettings }) {
  const script = configSnippet(clash);
  const group = clash.group || "果到雷达";
  const port = clash.proxyPort || 7899;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" className="h-9 rounded-xl text-muted-foreground">
          <FileCode2 aria-hidden="true" /> 配置教程
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b border-border/60 px-6 pt-6 pb-4">
          <DialogTitle>配置 Clash 节点轮换</DialogTitle>
          <DialogDescription className="leading-5">
            以 Clash Verge Rev（mihomo 内核）为例，约 3 分钟。配置只新增一个果到雷达专用的策略组和端口，电脑本身使用的节点不受影响。
          </DialogDescription>
        </DialogHeader>
        <ol className="min-h-0 space-y-5 overflow-y-auto px-6 py-5">
          <GuideStep index={1} title="开启 Clash 外部控制器">
            <p>
              打开 Clash Verge，进入 <Ui>设置</Ui> → <Ui>Clash 设置</Ui> → <Ui>外部控制</Ui>，打开
              <Ui>「启用外部控制器」</Ui>，然后保存。果到雷达通过它读取节点和切换节点。
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <Ui>外部控制器监听地址</Ui>（例如 <Code>127.0.0.1:9097</Code>）→ 填到果到雷达的<Ui>「控制接口」</Ui>，直接粘贴即可。
              </li>
              <li>
                <Ui>API 访问密钥</Ui> → 填到果到雷达的<Ui>「密钥」</Ui>。没有设置密钥可留空，建议设置一个。
              </li>
            </ul>
          </GuideStep>

          <GuideStep index={2} title="添加果到雷达专用的扩展脚本">
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                进入 Clash Verge 的 <Ui>订阅</Ui> 页面，在页面底部找到 <Ui>「全局扩展脚本」</Ui>（右上角标着 Script）。
              </li>
              <li>
                右键点击它 → <Ui>编辑文件</Ui>，把编辑器里原有内容<Ui>全部替换</Ui>为下面的脚本。
              </li>
              <li>
                修改脚本开头的 <Code>APW_SUBSCRIPTIONS</Code>：把 <Code>"机场订阅地址"</Code> 换成你的订阅链接（在订阅卡片上右键可复制，或到机场官网复制）。
                有多个机场就照格式多写几行，例如 <Code>红杏: "https://…"</Code>。
              </li>
              <li>保存。如果「代理」页没有变化，在当前订阅卡片上点一下刷新。</li>
            </ol>
            <div className="rounded-lg border border-border/60 bg-muted/25">
              <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
                <span className="text-xs">全局扩展脚本（端口 {port}，策略组「{group}」）</span>
                <CopyButton text={script} label="复制脚本" />
              </div>
              <pre className="max-h-56 overflow-auto p-3 font-mono text-xs leading-5 text-foreground/85 select-text">{script}</pre>
            </div>
            <p className="rounded-lg border border-unknown/40 bg-unknown/10 px-3 py-2 text-xs leading-5">
              不要把脚本写进旁边的「全局扩展覆写配置」（Merge）：它不支持追加策略组，写错会替换掉原有的全部策略组，导致电脑上网分流异常。
            </p>
          </GuideStep>

          <GuideStep index={3} title="确认 Clash 已生效">
            <ul className="list-disc space-y-1 pl-5">
              <li>
                Clash Verge 的 <Ui>代理</Ui> 页面出现<Ui>「{group}」</Ui>策略组，里面有 DIRECT 和带 <Code>APW·</Code> 前缀的节点。
              </li>
              <li>
                你平时使用的策略组（如「节点选择」「自动选择」）里<Ui>没有</Ui> <Code>APW·</Code> 开头的节点。
              </li>
            </ul>
          </GuideStep>

          <GuideStep index={4} title="回到果到雷达填写并检查">
            <div className="overflow-hidden rounded-lg border border-border/60">
              <table className="w-full text-left text-xs leading-5">
                <thead className="bg-muted/40 text-foreground">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">果到雷达中的项目</th>
                    <th className="px-3 py-1.5 font-medium">填写什么</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  <tr>
                    <td className="px-3 py-1.5">控制接口</td>
                    <td className="px-3 py-1.5">第 1 步的「外部控制器监听地址」</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-1.5">密钥</td>
                    <td className="px-3 py-1.5">第 1 步的「API 访问密钥」</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-1.5">专用端口</td>
                    <td className="px-3 py-1.5">
                      <Code>{port}</Code>，即脚本最后 listeners 中的 port，两边必须一致
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-1.5">策略组</td>
                    <td className="px-3 py-1.5">
                      <Code>{group}</Code>，即脚本中的 APW_GROUP
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-1.5">节点关键词</td>
                    <td className="px-3 py-1.5">可留空；只用部分节点时填，例如 <Code>香港|日本</Code></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              填完点 <Ui>「检查线路」</Ui>：显示可用节点数量和「端口 {port} 可连接」即配置成功。这一步只访问本机 Clash，不会请求 Apple。
            </p>
          </GuideStep>

          <GuideStep index={5} title="开始监控">
            <p>
              出口方式选 <Ui>「Clash 节点轮换」</Ui>，点 <Ui>开始监控</Ui>。节点被 Apple 拒绝时会自动冷却并换下一个，活动日志每轮显示实际使用的节点。
              也可以在「当前节点」中手动指定节点；想固定用一个节点，改选「指定节点」。
            </p>
          </GuideStep>
        </ol>
      </DialogContent>
    </Dialog>
  );
}

function SurgeSetupGuide({ settings }: { settings: ClashSettings }) {
  const group = settings.group || "果到雷达";
  const port = settings.proxyPort || 7900;
  const address = settings.controller.replace(/^https?:\/\//, "").replace(/\/$/, "") || "127.0.0.1:6171";
  return (
    <Dialog>
      <DialogTrigger asChild><Button variant="outline" size="sm">Surge 配置教程</Button></DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>配置 Surge for Mac</DialogTitle>
          <DialogDescription>手动添加专用策略组与端口。保留原有监听和规则，应用只切换专用组。</DialogDescription>
        </DialogHeader>
        <ol className="space-y-5">
          <GuideStep index={1} title="开启 HTTP API">
            <p>在 [General] 中配置本机控制接口，将 YOUR_API_KEY 换成自己的密钥，再把相同密钥填入应用。推荐 Surge Mac 6.10 或更新版本。</p>
            <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs select-text">{`http-api = YOUR_API_KEY@${address}`}</pre>
            <p>控制接口默认使用 HTTP；若自行开启 TLS，需先信任 Surge 证书。</p>
          </GuideStep>
          <GuideStep index={2} title="追加专用监听端口">
            <p>在 [General] 现有 http-listen 后追加 127.0.0.1:{port}。例如原端口为 6152：</p>
            <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs select-text">{`http-listen = 127.0.0.1:6152, 127.0.0.1:${port}`}</pre>
            <p>保留自己原有的地址和端口；专用端口不要与其他软件重复。</p>
          </GuideStep>
          <GuideStep index={3} title="添加专用 select 策略组">
            <p>在 [Proxy Group] 中添加下面一行，将机场A、机场B 替换为已有策略组名。使用组内节点，不改变原策略组的选择。</p>
            <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs select-text">{`${group} = select, DIRECT, include-other-group="机场A,机场B"`}</pre>
            <p>多个订阅有同名节点时，先在 Surge 中设置名称前缀。外部节点以策略组 API 返回的成员名为准。</p>
          </GuideStep>
          <GuideStep index={4} title="添加端口规则并检查">
            <p>在 [Rule] 最前面添加下面一行，保存并保持 Surge 为规则模式，然后在应用中检查线路。</p>
            <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs select-text">{`IN-PORT,${port},${group}`}</pre>
            <p>检查端口可连接不代表专用路由已生效。应在 Surge 请求记录中确认命中该规则，并切换节点验证出口。目录刷新失败时仍可能回退系统网络。</p>
          </GuideStep>
        </ol>
      </DialogContent>
    </Dialog>
  );
}

interface CurrentNodeStatus {
  now: string | null;
  loading: boolean;
  error: string | null;
}

function NodePicker({
  route,
  backend,
  network,
  pinned,
  onPin,
  onCurrentChange,
}: {
  route: string | null;
  backend: ProxyBackend;
  network: Network;
  onCurrentChange: (status: CurrentNodeStatus) => void;
  /** 指定节点模式下固定使用的节点；轮换模式为 null。 */
  pinned: string | null;
  onPin: (node: string) => Promise<void>;
}) {
  const [list, setList] = useState<RouteList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [currentError, setCurrentError] = useState<string | null>(null);
  const currentRequest = useRef(0);
  const mounted = useRef(false);

  const refreshCurrent = useCallback(async () => {
    if (!mounted.current) return;
    const request = ++currentRequest.current;
    try {
      const now = await getCurrentProxyNode(network);
      if (!mounted.current || request !== currentRequest.current) return;
      setCurrent(now);
      setCurrentError(null);
      onCurrentChange({ now, loading: false, error: null });
    } catch (error) {
      if (!mounted.current || request !== currentRequest.current) return;
      const message = String(error);
      setCurrent(null);
      setCurrentError(message);
      onCurrentChange({ now: null, loading: false, error: message });
    }
  }, [network, onCurrentChange]);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    onCurrentChange({ now: null, loading: true, error: null });
    const poll = async () => {
      if (document.visibilityState !== "hidden") await refreshCurrent();
      if (!cancelled) timer = setTimeout(() => void poll(), 5000);
    };
    const onFocus = () => {
      if (document.visibilityState !== "hidden") void refreshCurrent();
    };
    void poll();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      mounted.current = false;
      currentRequest.current += 1;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refreshCurrent, onCurrentChange]);

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await listProxyNodes();
    if (typeof result === "string") {
      setError(result);
    } else {
      setError(result.probeError);
      setList(result);
      // A batch probe may take seconds. Its `now` snapshot must not replace
      // the live selection read independently from the controller.
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A completed cycle is a refresh signal, not the current source of truth:
  // the user may have switched the proxy again before this event arrived.
  const routeNode = nodeFromRoute(route, backend);
  useEffect(() => {
    if (routeNode) void refreshCurrent();
  }, [route, routeNode, refreshCurrent]);
  const value = pinned ?? current;

  const options = (list?.nodes ?? []).map((node) => ({
    value: node.name,
    label: nodeLabel(node),
    disabled: nodeTooSlow(node),
  }));
  const reachable = list?.nodes.filter(nodeUsable).length ?? 0;

  return (
    <div className="field-group">
      <div className="flex items-center justify-between gap-2">
        <Label className="control-label">{pinned !== null ? "指定节点" : "当前节点"}</Label>
        <span className="text-[10px] text-muted-foreground">
          {loading ? "测速中…" : list ? `${reachable}/${list.nodes.length} 个可用` : ""}
        </span>
      </div>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2">
        <Combobox
          className="control-surface w-full min-w-0"
          options={options}
          value={value ?? ""}
          placeholder={loading ? "正在读取节点…" : "选择节点"}
          searchPlaceholder="搜索节点，如 香港"
          emptyText="没有匹配的节点"
          disabled={switching || options.length === 0}
          onChange={async (node) => {
            if (node === value) return;
            setSwitching(true);
            if (pinned !== null) {
              await onPin(node);
            } else {
              await selectProxyNode(node, backend);
            }
            await refreshCurrent();
            setSwitching(false);
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-10 rounded-xl border-border/70 bg-background/30"
          aria-label="重新测速"
          title="重新测速"
          disabled={loading}
          onClick={() => { void refresh(); void refreshCurrent(); }}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} aria-hidden="true" />
        </Button>
      </div>
      <p className="text-[11px] leading-4 break-words text-muted-foreground">
        {currentError ?? error ??
          (pinned !== null
            ? "固定使用该节点；延迟超过 500 ms 或测速不可达时停止本次查询，不自动切换。"
            : "自动跳过延迟超过 500 ms 的节点；被 Apple 拒绝或连不通时仍会自动切换。")}
      </p>
    </div>
  );
}

function CheckResult({ check, port, currentNode }: { check: ProxyRouteCheck | string | null; port: number; currentNode: CurrentNodeStatus }) {
  if (check === null) return null;
  if (typeof check === "string") {
    return <p role="alert" className="text-[11px] leading-4 break-words text-destructive">{check}</p>;
  }
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg border border-border/55 bg-background/30 px-3 py-2 text-[11px] leading-4">
      <dt className="text-muted-foreground">内核</dt>
      <dd className="truncate">{check.version}</dd>
      <dt className="text-muted-foreground">节点总数</dt>
      <dd>
        {check.nodes.length} 个{check.skipped > 0 ? `（已排除 ${check.skipped} 个信息节点）` : ""}
      </dd>
      <dt className="text-muted-foreground">测速不可达</dt>
      <dd className={check.timeoutCount > 0 ? "text-unknown" : ""}>
        {check.probeError ?? `${check.timeoutCount} 个${check.timeoutCount > 0 ? "，切换前会逐个复测并跳过" : ""}`}
      </dd>
      <dt className="text-muted-foreground">超过 {MAX_NODE_DELAY_MS} ms</dt>
      <dd className={check.slowCount > 0 ? "text-unknown" : ""}>
        {check.probeError ? "未能确认" : `${check.slowCount} 个，查询时自动跳过`}
      </dd>
      <dt className="text-muted-foreground">当前节点</dt>
      <dd className={currentNode.error ? "break-words text-destructive" : "break-words"}>
        {currentNode.loading ? "读取中…" : currentNode.error ? "无法读取当前节点" : currentNode.now ?? "未选择"}
      </dd>
      <dt className="text-muted-foreground">端口 {port}</dt>
      <dd className={check.portOpen ? "text-in-stock" : "text-destructive"}>
        {check.portOpen ? "可连接" : "无法连接，请检查专用端口配置"}
      </dd>
      {check.portOpen && !check.routeVerified ? <>
        <dt className="text-muted-foreground">专用路由</dt>
        <dd>尚未验证，请在代理软件中核对请求命中的策略组。</dd>
      </> : null}
    </dl>
  );
}

function NetworkSettingsEditor({
  network,
  running,
  route,
}: {
  network: Network;
  running: boolean;
  route: string | null;
}) {
  const backend = network.backend;
  const isSurge = backend === "surge";
  const active = network[backend];
  const [draft, setDraft] = useState<ClashSettings>(active);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<ProxyRouteCheck | string | null>(null);
  const [currentNode, setCurrentNode] = useState<CurrentNodeStatus>({ now: null, loading: true, error: null });
  const checkGeneration = useRef(0);
  const draftKey = JSON.stringify(draft);
  useEffect(() => { checkGeneration.current += 1; setCheck(null); }, [draftKey, backend]);

  useEffect(() => { setDraft(active); setCheck(null); }, [active, backend]);

  const saveProxy = () => {
    if (JSON.stringify(draft) === JSON.stringify(active)) return;
    setCheck(null);
    void saveNetworkSettings({ [backend]: draft });
  };
  const text = (key: "controller" | "secret" | "group" | "nodeFilter") => ({
    value: draft[key],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [key]: event.target.value }),
    onBlur: saveProxy,
  });

  return (
    <CollapsiblePanel
      id="network"
      icon={<Globe className="size-4" />}
      title="查询线路"
      subtitle={route ? `最近查询：${route}` : "Apple 查询使用的出口 IP"}
      summary={route ? `最近查询：${route}` : MODE_LABELS[network.mode]}
    >
      <div className="field-group">
        <Label htmlFor="network-mode" className="control-label">出口方式</Label>
        <Select
          value={network.mode}
          onValueChange={(mode) => {
            setCheck(null);
            void saveNetworkSettings({ mode: mode as NetworkMode });
          }}
        >
          <SelectTrigger id="network-mode" className="control-surface w-full" aria-label="出口方式">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(MODE_LABELS) as NetworkMode[]).map((mode) => (
              <SelectItem key={mode} value={mode}>{MODE_LABELS[mode]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] leading-4 break-words text-muted-foreground">
          {MODE_HINTS[network.mode]}
          {running ? " 修改后会在下一次查询时重启查询浏览器。" : ""}
        </p>
      </div>

      {network.mode !== "system" ? (
        <div className="mt-3 grid min-w-0 gap-3">
          <div className="field-group">
            <Label htmlFor="proxy-backend" className="control-label">代理软件</Label>
            <Select value={backend} onValueChange={(value) => {
              setCheck(null);
              void saveNetworkSettings({ backend: value as ProxyBackend });
            }}>
              <SelectTrigger id="proxy-backend" className="control-surface w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="clash">Clash / mihomo</SelectItem>
                <SelectItem value="surge">Surge for Mac</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
            <p className="text-[11px] leading-4 text-muted-foreground">
              {isSurge ? "首次使用需要在 Surge 中开启 HTTP API，添加专用组、监听端口和 IN-PORT 规则。" : "首次使用需要先在 Clash 中开启外部控制器并添加扩展脚本，按教程约 3 分钟完成。"}
            </p>
            {isSurge ? <SurgeSetupGuide settings={draft} /> : <ClashSetupGuide clash={draft} />}
          </div>
          <NodePicker
            key={JSON.stringify([backend, active.controller, active.secret, active.group, active.nodeFilter])}
            backend={backend}
            network={network}
            onCurrentChange={setCurrentNode}
            route={route}
            pinned={network.mode === "pinned" ? active.pinnedNode : null}
            onPin={async (node) => {
              // 先保存，保证重启后仍用该节点；再立即切换，不必等到下一轮。
              if (await saveNetworkSettings({ [backend]: { ...active, pinnedNode: node } })) {
                await selectProxyNode(node, backend);
              }
            }}
          />
          <div className="field-group">
            <Label htmlFor="clash-controller" className="control-label">控制接口</Label>
            <Input
              id="clash-controller"
              className="control-surface select-text"
              placeholder={isSurge ? "127.0.0.1:6171" : "127.0.0.1:9097"}
              {...text("controller")}
            />
            <FieldHint>{isSurge ? "Surge [General] 中 http-api 的监听地址" : "Clash → 设置 → Clash 设置 → 外部控制中的「监听地址」"}</FieldHint>
          </div>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_6rem] gap-2">
            <div className="field-group">
              <Label htmlFor="clash-secret" className="control-label">密钥</Label>
              <Input
                id="clash-secret"
                type="password"
                className="control-surface select-text"
                placeholder={isSurge ? "http-api 的 API 密钥" : "没有可留空"}
                {...text("secret")}
              />
              <FieldHint>{isSurge ? "http-api 中 @ 前面的密钥" : "同一处的「API 访问密钥」"}</FieldHint>
            </div>
            <div className="field-group">
              <Label htmlFor="clash-port" className="control-label">专用端口</Label>
              <Input
                id="clash-port"
                inputMode="numeric"
                className="control-surface select-text tabular-nums"
                placeholder={isSurge ? "7900" : "7899"}
                value={draft.proxyPort ? String(draft.proxyPort) : ""}
                onChange={(event) => {
                  const port = Number.parseInt(event.target.value.replace(/\D/g, ""), 10);
                  setDraft({ ...draft, proxyPort: Number.isFinite(port) ? Math.min(port, 65535) : 0 });
                }}
                onBlur={saveProxy}
              />
              <FieldHint>{isSurge ? "http-listen 与 IN-PORT 的专用端口" : "脚本 listeners 的端口"}</FieldHint>
            </div>
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-2">
            <div className="field-group">
              <Label htmlFor="clash-group" className="control-label">策略组</Label>
              <Input id="clash-group" className="control-surface select-text" placeholder="果到雷达" {...text("group")} />
              <FieldHint>{isSurge ? "独立的 select 策略组" : "脚本中的 APW_GROUP"}</FieldHint>
            </div>
            <div className="field-group">
              <Label htmlFor="clash-filter" className="control-label">节点关键词</Label>
              <Input
                id="clash-filter"
                className="control-surface select-text"
                placeholder="全部，或 香港|日本"
                {...text("nodeFilter")}
              />
              <FieldHint>可留空，用 | 分隔</FieldHint>
            </div>
          </div>

          <div className="grid gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-9 rounded-xl border-border/70 bg-background/30"
              disabled={checking}
              onClick={async () => {
                setChecking(true);
                const generation = checkGeneration.current;
                const result = await testProxyRoute({ ...network, [backend]: draft });
                if (generation === checkGeneration.current) setCheck(result);
                setChecking(false);
              }}
            >
              {checking ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <PlugZap aria-hidden="true" />}
              检查线路
            </Button>
          </div>
          <CheckResult check={check} port={draft.proxyPort} currentNode={currentNode} />
        </div>
      ) : null}
    </CollapsiblePanel>
  );
}

export function NetworkSettings(props: { network: Network; running: boolean; route: string | null }) {
  return <NetworkSettingsEditor key={props.network.backend} {...props} />;
}
