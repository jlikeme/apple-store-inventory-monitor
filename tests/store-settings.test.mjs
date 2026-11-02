import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Exercise the real store with a controllable IPC boundary, without a desktop app.
let invoke;
globalThis.__settingsTestInvoke = (...args) => invoke(...args);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stubs = {
      "@tauri-apps/api/core": "export const invoke = (...args) => globalThis.__settingsTestInvoke(...args);",
      "@tauri-apps/api/event": "export const listen = async () => () => {};",
      "@tauri-apps/plugin-opener": "export const openUrl = async () => {};",
    };
    if (specifier in stubs) {
      return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    }
    if (specifier.startsWith("./") && !specifier.endsWith(".ts") && context.parentURL?.includes("/src/lib/")) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const defaults = {
  locale: "zh_CN", targets: [], intervalSeconds: 30,
  deliveryRegion: null,
  barkUrl: "https://example.invalid/old", soundEnabled: true, openOnHit: "bag", stopOnHit: false,
  productBarkUrls: {},
  barkOptions: { level: "default", sound: "", volume: null, call: false },
  network: {
    mode: "system",
    clash: { controller: "http://127.0.0.1:9097", secret: "", group: "果到雷达", proxyPort: 7899, nodeFilter: "", pinnedNode: "DIRECT" },
  },
  checkout: {
    enabled: false, nationalIdSuffix: "", payment: "alipay",
    installmentBank: "招商银行", installmentPeriods: 24, placeOrder: false, acceptNearestStore: false, product: "",
    fillContact: false, contactLastName: "", contactFirstName: "", contactEmail: "", contactPhone: "",
  },
};
let generation = 0;
async function setup() {
  const store = await import(`../src/lib/store.ts?case=${++generation}`);
  let persisted = { ...defaults };
  let release;
  let blockNext = false;
  const calls = [];
  invoke = async (command, args) => {
    calls.push(command);
    if (blockNext) {
      blockNext = false;
      await new Promise((resolve) => { release = resolve; });
    }
    if (command === "save_settings") persisted = { ...args.settings };
    if (command === "set_interval") persisted.intervalSeconds = Math.max(1, args.seconds);
    if (command === "set_targets") persisted.targets = args.targets;
    if (command === "set_targets") return [];
    if (command === "set_interval") return persisted.intervalSeconds;
    return { ...persisted };
  };
  await store.saveSettings(defaults);
  calls.length = 0;
  return {
    store, calls, persisted: () => persisted,
    block: () => { blockNext = true; },
    release: () => release(),
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("送货地区固定读取中国大陆官网且不跟随当前监控地区", async () => {
  let received;
  invoke = async (command, args) => {
    received = { command, args };
    return { states: [], cities: [], districts: [] };
  };
  const store = await import(`../src/lib/store.ts?delivery=${++generation}`);
  await store.loadDeliveryLocalities("四川", "成都");
  assert.deepEqual(received, {
    command: "list_delivery_localities",
    args: { locale: "zh_CN", stateName: "四川", cityName: "成都" },
  });
});

test("overlapping edits merge with the last saved settings", async () => {
  const ctx = await setup();
  ctx.block();
  const first = ctx.store.saveSettings({ barkUrl: "" });
  await tick();
  const second = ctx.store.saveSettings({ soundEnabled: false });
  const third = ctx.store.saveSettings({ openOnHit: "product" });
  await tick();
  assert.deepEqual(ctx.calls, ["save_settings"]);
  ctx.release();
  await Promise.all([first, second, third]);
  assert.deepEqual(ctx.persisted(), {
    ...defaults,
    barkUrl: "",
    soundEnabled: false,
    openOnHit: "product",
  });
});

test("interval and target commands cannot be overwritten by queued settings", async () => {
  const ctx = await setup();
  ctx.block();
  const interval = ctx.store.setIntervalSeconds(15);
  await tick();
  const targets = [{ locale: "zh_CN", storeNumber: "R390", storeTitle: "Test", partNumber: "TEST/A", productName: "Test" }];
  const updated = ctx.store.setTargets(targets);
  const saved = ctx.store.saveSettings({ soundEnabled: false });
  await tick();
  assert.deepEqual(ctx.calls, ["set_interval"]);
  ctx.release();
  await Promise.all([interval, updated, saved]);
  assert.deepEqual(ctx.persisted(), { ...defaults, intervalSeconds: 15, targets, soundEnabled: false });
});

test("rapid removals use the latest queued target list", async () => {
  const ctx = await setup();
  const target = (partNumber) => ({
    locale: "zh_CN", storeNumber: "R390", storeTitle: "Test",
    partNumber, productName: partNumber,
  });
  const firstTarget = target("FIRST/A");
  const secondTarget = target("SECOND/A");
  const retainedTarget = target("RETAINED/A");
  await ctx.store.setTargets([firstTarget, secondTarget, retainedTarget]);
  ctx.calls.length = 0;

  ctx.block();
  const firstRemoval = ctx.store.removeTarget(firstTarget);
  await tick();
  const secondRemoval = ctx.store.removeTarget(secondTarget);
  await tick();
  assert.deepEqual(ctx.calls, ["set_targets"]);

  ctx.release();
  await Promise.all([firstRemoval, secondRemoval]);
  assert.deepEqual(ctx.calls, ["set_targets", "set_targets"]);
  assert.deepEqual(ctx.persisted().targets, [retainedTarget]);
});

test("test notification waits for the cleared Bark address to finish saving", async () => {
  const ctx = await setup();
  ctx.block();
  const save = ctx.store.saveSettings({ barkUrl: "" });
  await tick();
  const notification = ctx.store.testNotify();
  await tick();
  assert.deepEqual(ctx.calls, ["save_settings"]);
  ctx.release();
  await Promise.all([save, notification]);
  assert.deepEqual(ctx.calls, ["save_settings", "test_notify"]);
  assert.equal(ctx.persisted().barkUrl, "");
});

test("a failed write does not prevent subsequent edits", async () => {
  const ctx = await setup();
  const originalInvoke = invoke;
  invoke = async () => { throw new Error("disk unavailable"); };
  assert.equal(await ctx.store.saveSettings({ soundEnabled: false }), false);
  invoke = originalInvoke;
  assert.equal(await ctx.store.saveSettings({ barkUrl: "" }), true);
  assert.deepEqual(ctx.persisted(), { ...defaults, barkUrl: "" });
});

test("a product-specific Bark URL can be set and cleared", async () => {
  const ctx = await setup();
  const target = {
    locale: "zh_CN", storeNumber: "R390", storeTitle: "Test",
    partNumber: "TEST/A", productName: "Test Product",
  };

  assert.equal(await ctx.store.setProductBarkUrl(target, " https://api.day.app/friend "), true);
  assert.deepEqual(ctx.persisted().productBarkUrls, {
    "TEST/A": "https://api.day.app/friend",
  });

  assert.equal(await ctx.store.setProductBarkUrl(target, ""), true);
  assert.deepEqual(ctx.persisted().productBarkUrls, {});
});

test("queued backend switches preserve the just-edited inactive configuration", async () => {
  const ctx = await setup();
  ctx.block();
  const clash = { ...defaults.network.clash, secret: "new-key", proxyPort: 7999 };
  const edited = ctx.store.saveNetworkSettings({ clash });
  await tick();
  const switched = ctx.store.saveNetworkSettings({ backend: "surge" });
  const surge = { ...clash, controller: "http://127.0.0.1:6171", proxyPort: 7900 };
  const configured = ctx.store.saveNetworkSettings({ surge });
  ctx.release();
  await Promise.all([edited, switched, configured]);
  assert.equal(ctx.persisted().network.backend, "surge");
  assert.deepEqual(ctx.persisted().network.clash, clash);
  assert.deepEqual(ctx.persisted().network.surge, surge);
  await ctx.store.saveNetworkSettings({ backend: "clash" });
  assert.deepEqual(ctx.persisted().network.clash, clash);
  assert.deepEqual(ctx.persisted().network.surge, surge);
});

test("proxy commands use the generic IPC contract", async () => {
  const calls = [];
  invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "select_proxy_node") return { reachable: true, delayMs: null };
    if (command === "list_proxy_nodes") return { now: "A", nodes: [], probeError: null };
    if (command === "test_proxy_route") return { version: "Surge HTTP API", nodes: ["A"], portOpen: true, probeError: null };
  };
  const store = await import(`../src/lib/store.ts?proxy=${++generation}`);
  assert.equal(await store.selectProxyNode("A"), true);
  assert.equal((await store.listProxyNodes()).now, "A");
  await store.testProxyRoute({ ...defaults.network, backend: "surge" });
  assert.deepEqual(calls.map(c => c.command), ["select_proxy_node", "list_proxy_nodes", "test_proxy_route"]);
  assert.equal(calls[2].args.network.backend, "surge");
});

test("queued Bark critical and volume edits keep both settings and routes", async () => {
  const ctx = await setup();
  ctx.block();
  const enabled = ctx.store.saveBarkOptions({ level: "critical" });
  await tick();
  const volume = ctx.store.saveBarkOptions({ volume: 8 });
  const sound = ctx.store.saveBarkOptions({ sound: "alarm", call: true });
  ctx.release();
  await Promise.all([enabled, volume, sound]);
  assert.deepEqual(ctx.persisted().barkOptions, {
    level: "critical", volume: 8, sound: "alarm", call: true,
  });
  assert.equal(ctx.persisted().barkUrl, defaults.barkUrl);
  assert.deepEqual(ctx.persisted().productBarkUrls, defaults.productBarkUrls);
  await ctx.store.saveBarkOptions({ level: "active" });
  assert.equal(ctx.persisted().barkOptions.volume, 8);
});

test("current proxy node reads fresh state without batch probes and exposes failures", async () => {
  let selected = "香港01";
  let unavailable = false;
  const calls = [];
  invoke = async (command, args) => {
    calls.push({ command, args });
    assert.equal(command, "get_proxy_node");
    if (unavailable) throw new Error("控制接口不可用");
    return selected;
  };
  const store = await import(`../src/lib/store.ts?current-node=${++generation}`);
  const network = { ...defaults.network, backend: "surge", surge: { ...defaults.network.clash, controller: "http://127.0.0.1:6171" } };
  assert.equal(await store.getCurrentProxyNode(network), "香港01");
  selected = "日本01";
  assert.equal(await store.getCurrentProxyNode(network), "日本01");
  unavailable = true;
  await assert.rejects(store.getCurrentProxyNode(network), /控制接口不可用/);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].args, { network });
});
