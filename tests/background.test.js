const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../extension/background.js"), "utf8");

function blockRule(id, domain) {
  return {
    id,
    priority: 1,
    action: { type: "block" },
    condition: { requestDomains: [domain], resourceTypes: ["main_frame"] },
  };
}

function setup(existing = [], { limit = 30000, rejectUpdate = () => false } = {}) {
  let rules = structuredClone(existing);
  const history = [];
  const event = { addListener() {} };
  const context = {
    console: { log() {}, error() {} },
    URL,
    chrome: {
      declarativeNetRequest: {
        async getDynamicRules() {
          return structuredClone(rules);
        },
        async updateDynamicRules(options) {
          // Yield so concurrent reloads can interleave as they do in Chrome.
          await Promise.resolve();
          const { removeRuleIds = [], addRules = [] } = options;
          const next = rules.filter((rule) => !removeRuleIds.includes(rule.id));
          try {
            for (const rule of addRules) {
              if (next.some((entry) => entry.id === rule.id)) throw new Error("Duplicate rule ID");
              if (rule.condition.requestDomains.some((domain) => !/^[\x00-\x7f]+$/.test(domain))) {
                throw new Error("Non-ASCII request domain");
              }
              next.push(structuredClone(rule));
            }
            if (next.length > limit) throw new Error("Dynamic rule limit exceeded");
            if (rejectUpdate(options)) throw new Error("Rule update failed");
            rules = next;
          } finally {
            history.push(structuredClone(rules));
          }
        },
      },
      contextMenus: { onClicked: event, removeAll() {}, create() {} },
      runtime: { onInstalled: event, onStartup: event, onMessage: event },
      action: { onClicked: event },
      tabs: { onRemoved: event },
      webNavigation: { onBeforeNavigate: event, onErrorOccurred: event, onCommitted: event },
      storage: { session: { async get() { return {}; }, async set() {} } },
    },
  };
  vm.runInNewContext(source, context, { filename: "background.js" });
  return {
    update: context.updateBlockRules,
    matchDomain: context.matchDomain,
    rebuildContextMenus: context.rebuildContextMenus,
    history,
    getRules: () => structuredClone(rules),
  };
}

function domains(...names) {
  return names.map((domain) => ({ domain, browser: "firefox" }));
}

function blocks(rules, hostname) {
  return rules.some((rule) => rule.action.type === "block"
    && rule.condition.resourceTypes.includes("main_frame")
    && rule.condition.requestDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`)));
}

test("valid and empty configurations replace the old rules atomically", async () => {
  const state = setup([blockRule(8, "old.example")]);
  await state.update(domains("new.example"));
  assert.deepEqual(state.getRules(), [blockRule(1, "new.example")]);
  assert.equal(state.history.length, 1);
  await state.update([]);
  assert.deepEqual(state.getRules(), []);
  assert.equal(state.history.length, 2);
});

test("malformed replacements keep every old domain blocked until the valid set is committed", async () => {
  const state = setup([blockRule(1, "kept.example"), blockRule(3, "removed.example")]);
  await state.update(domains("new.example", "kept.example", "bäd.example"));

  assert.deepEqual(state.getRules(), [blockRule(1, "new.example"), blockRule(2, "kept.example")]);
  for (const snapshot of state.history.slice(0, -1)) {
    for (const hostname of ["kept.example", "sub.kept.example", "removed.example"]) {
      assert.ok(blocks(snapshot, hostname), `${hostname} lost protection during validation`);
    }
  }
  assert.ok(!blocks(state.getRules(), "removed.example"));
});

test("initial loads skip malformed domains and install the valid rules", async () => {
  const state = setup();
  await state.update(domains("bäd.example", "new.example"));
  assert.deepEqual(state.getRules(), [blockRule(2, "new.example")]);
});

test("a failed final commit keeps the old rules and cleans up validation rules", async () => {
  const existing = [blockRule(1, "kept.example")];
  const state = setup(existing, {
    rejectUpdate: ({ removeRuleIds = [] }) => removeRuleIds.includes(1),
  });
  await assert.rejects(state.update(domains("new.example", "bäd.example")));
  assert.deepEqual(state.getRules(), existing);
  for (const snapshot of state.history) assert.ok(blocks(snapshot, "kept.example"));
});

test("validation that cannot obtain a spare rule slot leaves existing protection intact", async () => {
  const existing = [blockRule(1, "kept.example"), blockRule(2, "other.example")];
  const state = setup(existing, { limit: 2 });
  await assert.rejects(state.update(domains("kept.example", "bäd.example")));
  assert.deepEqual(state.getRules(), existing);
  for (const snapshot of state.history) {
    assert.ok(blocks(snapshot, "kept.example"));
    assert.ok(blocks(snapshot, "other.example"));
  }
});

test("overlapping reloads finish with only the latest rules", async () => {
  const state = setup([blockRule(1, "old.example")]);
  await Promise.all([
    state.update(domains("first.example", "bäd.example")),
    state.update(domains("latest.example")),
  ]);
  assert.deepEqual(state.getRules(), [blockRule(1, "latest.example")]);
});

test("a failed reload does not prevent a subsequent update", async () => {
  const state = setup([blockRule(1, "old.example")], { limit: 1 });
  await assert.rejects(state.update(domains("new.example", "bäd.example")));
  await state.update(domains("latest.example"));
  assert.deepEqual(state.getRules(), [blockRule(1, "latest.example")]);
});

// ── Matching ──────────────────────────────────────────────────────────────────

test("the most specific matching domain wins", () => {
  const state = setup();
  const entries = [
    { domain: "example.com", browser: "firefox" },
    { domain: "work.example.com", browser: "librewolf" },
  ];
  assert.equal(state.matchDomain("work.example.com", entries).browser, "librewolf");
  assert.equal(state.matchDomain("deep.work.example.com", entries).browser, "librewolf");
  assert.equal(state.matchDomain("other.example.com", entries).browser, "firefox");
  assert.equal(state.matchDomain("example.net", entries), null);
});

// ── Context menus ─────────────────────────────────────────────────────────────

test("overlapping menu rebuilds are serialized and leave the latest aliases", async () => {
  const state = lifecycle(HOST_OK);
  await Promise.all([
    state.context.rebuildContextMenus({ firefox: "firefox" }),
    state.context.rebuildContextMenus({ librewolf: "librewolf" }),
  ]);
  assert.deepEqual(state.menus().map((menu) => menu.id), [
    "open-in-browser-parent",
    "open-in-browser:librewolf",
  ]);
});

// ── Setup page hand-off ───────────────────────────────────────────────────────

const HOST_MISSING = () => ({ lastError: "Specified native messaging host not found." });
const HOST_FORBIDDEN = () => ({ lastError: "Access to the specified native messaging host is forbidden." });
const HOST_SILENT = () => ({ exit: true });
const HOST_CONFIG_ERROR = () => ({ protocol: 2, status: "error", error: "domains.txt not found at /home/user/.config/open-in-browser/domains.txt" });
const HOST_OK = () => ({ protocol: 2, domains: domains("a.example"), browsers: { firefox: "firefox" } });
const HOST_OUTDATED = () => ({ domains: domains("a.example"), browsers: { firefox: "firefox" } });

// Runs background.js against a simulated native host. `host` maps a request to
// a reply, a disconnect with lastError, or a disconnect with no reply at all.
function lifecycle(host, options = {}) {
  const listeners = {};
  const on = (name) => ({ addListener(listener) { listeners[name] = listener; } });
  const opened = [];
  const updated = [];
  const removed = [];
  const goneBack = [];
  const nativeMessages = [];
  const stored = {};
  const session = options.session ?? {};
  const menus = [];
  const tabs = options.tabs ?? [{ id: 1 }, { id: 2 }];
  const setupTabs = options.setupTabs ?? [];

  const runtime = {
    lastError: undefined,
    onInstalled: on("installed"),
    onStartup: on("startup"),
    onMessage: on("message"),
    getURL: (file) => `chrome-extension://test/${file}`,
    connectNative() {
      const messageListeners = [];
      const disconnectListeners = [];
      return {
        onMessage: { addListener: (listener) => messageListeners.push(listener) },
        onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
        disconnect() {},
        postMessage(message) {
          nativeMessages.push(structuredClone(message));
          queueMicrotask(() => {
            const outcome = host(message);
            if ("lastError" in outcome || outcome.exit) {
              runtime.lastError = outcome.lastError ? { message: outcome.lastError } : undefined;
              for (const listener of disconnectListeners) listener();
              runtime.lastError = undefined;
            } else {
              for (const listener of messageListeners) listener(outcome);
            }
          });
        },
      };
    },
  };
  const context = {
    console: { log() {}, error() {} },
    URL,
    chrome: {
      runtime,
      tabs: {
        create: ({ url }) => opened.push(url),
        remove: (id) => removed.push(id),
        goBack: async (id) => goneBack.push(id),
        update(id, properties, callback) {
          updated.push({ id, ...properties });
          callback?.();
        },
        query(queryInfo, callback) {
          const result = queryInfo?.url ? setupTabs : tabs;
          if (typeof callback === "function") {
            callback(result);
            return;
          }
          return Promise.resolve(result);
        },
        onRemoved: on("tabRemoved"),
      },
      storage: {
        local: {
          async set(values) { Object.assign(stored, values); },
          async get(key) { return { [key]: stored[key] }; },
        },
        session: {
          async set(values) { Object.assign(session, values); },
          async get(key) { return { [key]: session[key] }; },
        },
      },
      contextMenus: {
        removeAll(callback) {
          queueMicrotask(() => {
            menus.length = 0;
            callback?.();
          });
        },
        create(details, callback) {
          queueMicrotask(() => {
            if (menus.some((menu) => menu.id === details.id)) {
              runtime.lastError = { message: "Cannot create item with duplicate id" };
            } else {
              menus.push(structuredClone(details));
            }
            callback?.();
            runtime.lastError = undefined;
          });
        },
        onClicked: on("menu"),
      },
      declarativeNetRequest: options.dnr ?? {
        async getDynamicRules() { return []; },
        async updateDynamicRules() {},
      },
      action: { onClicked: on("action") },
      webNavigation: {
        onBeforeNavigate: on("navigate"),
        onErrorOccurred: on("errorNavigate"),
        onCommitted: on("committed"),
      },
    },
  };
  vm.runInNewContext(source, context, { filename: "background.js" });

  // structuredClone moves the reply out of the VM's realm, whose Object
  // prototype would otherwise fail strict deep equality.
  const checkHost = () => new Promise((resolve) => {
    const reply = (status) => resolve(structuredClone(status));
    assert.equal(listeners.message({ action: "check-host" }, {}, reply), true);
  });
  return {
    listeners, opened, updated, removed, goneBack, nativeMessages, stored, session, context,
    menus: () => structuredClone(menus),
    checkHost,
    storage: context.chrome.storage,
  };
}

const SETUP_URL = "chrome-extension://test/setup.html";

function openHost(overrides = {}) {
  return (message) => {
    if (message.action === "open") return overrides.open?.() ?? { status: "ok" };
    return {
      protocol: 2,
      domains: overrides.domains ?? domains("a.example"),
      browsers: overrides.browsers ?? { firefox: "firefox" },
    };
  };
}

async function prime(state, entries = domains("a.example")) {
  await state.storage.local.set({ domains: entries, browsers: { firefox: "firefox" } });
}

test("installing or updating without a reachable host opens the setup page", async () => {
  for (const reason of ["install", "update"]) {
    for (const host of [HOST_MISSING, HOST_FORBIDDEN]) {
      const state = lifecycle(host);
      await state.listeners.installed({ reason });
      assert.deepEqual(state.opened, [SETUP_URL], `${reason} with ${host.name}`);
    }
  }
});

test("browser updates, config errors and silent disconnects leave the setup page closed", async () => {
  const browserUpdate = lifecycle(HOST_MISSING);
  await browserUpdate.listeners.installed({ reason: "chrome_update" });
  assert.deepEqual(browserUpdate.opened, []);

  const working = lifecycle(HOST_OK);
  await working.listeners.installed({ reason: "install" });
  assert.deepEqual(working.opened, []);
  assert.deepEqual(working.stored.domains, domains("a.example"));

  // A config problem or an unexplained disconnect is not an install problem;
  // the icon click or setup page reports it instead.
  for (const host of [HOST_CONFIG_ERROR, HOST_SILENT]) {
    const state = lifecycle(host);
    await state.listeners.installed({ reason: "install" });
    assert.deepEqual(state.opened, [], host.name);
  }
});

test("clicking the icon opens the setup page for any failure", async () => {
  for (const host of [HOST_MISSING, HOST_FORBIDDEN, HOST_SILENT, HOST_CONFIG_ERROR]) {
    const state = lifecycle(host);
    await state.listeners.action();
    assert.deepEqual(state.opened, [SETUP_URL], host.name);
  }
  const working = lifecycle(HOST_OK);
  await working.listeners.action();
  assert.deepEqual(working.opened, []);
});

test("clicking the icon focuses an existing setup page instead of opening another", async () => {
  const state = lifecycle(HOST_MISSING, { setupTabs: [{ id: 7 }] });
  await state.listeners.action();
  assert.deepEqual(state.opened, []);
  assert.deepEqual(state.updated, [{ id: 7, active: true }]);
});

test("the setup page's check tells a missing host from a broken config", async () => {
  assert.deepEqual(await lifecycle(HOST_MISSING).checkHost(), {
    ok: false, reachable: false, error: "Specified native messaging host not found.",
  });
  assert.deepEqual(await lifecycle(HOST_FORBIDDEN).checkHost(), {
    ok: false, reachable: false, error: "Access to the specified native messaging host is forbidden.",
  });
  assert.deepEqual(await lifecycle(HOST_SILENT).checkHost(), {
    ok: false, reachable: true, error: "Native host exited without replying",
  });
  assert.deepEqual(await lifecycle(HOST_CONFIG_ERROR).checkHost(), {
    ok: false, reachable: true, error: HOST_CONFIG_ERROR().error,
  });
  assert.deepEqual(await lifecycle(HOST_OK).checkHost(), { ok: true, reachable: true, count: 1 });
});

test("an outdated host is reported without changing rules, storage or menus", async () => {
  for (const protocol of [undefined, 1]) {
    const updates = [];
    const state = lifecycle(() => ({
      protocol,
      domains: domains("stale.example"),
      browsers: { librewolf: "librewolf" },
    }), {
      dnr: {
        async getDynamicRules() { return []; },
        async updateDynamicRules(options) { updates.push(structuredClone(options)); },
      },
    });
    await prime(state, domains("kept.example"));

    const result = await state.checkHost();
    assert.equal(result.ok, false);
    assert.equal(result.reachable, true);
    assert.equal(result.outdated, true);
    assert.match(result.error, /older than this extension/);
    assert.deepEqual(state.stored.domains, domains("kept.example"));
    assert.deepEqual(state.stored.browsers, { firefox: "firefox" });
    assert.deepEqual(updates, []);
    assert.deepEqual(state.menus(), []);
  }
});

test("updating with an outdated host opens the setup page", async () => {
  for (const reason of ["install", "update"]) {
    const state = lifecycle(HOST_OUTDATED);
    await state.listeners.installed({ reason });
    assert.deepEqual(state.opened, [SETUP_URL], reason);
  }
});

test("a failed rule update is reported and domains are not cached", async () => {
  const state = lifecycle(HOST_OK, {
    dnr: {
      async getDynamicRules() { return []; },
      async updateDynamicRules() { throw new Error("Dynamic rule limit exceeded"); },
    },
  });
  assert.deepEqual(await state.checkHost(), {
    ok: false,
    reachable: true,
    error: "Could not update block rules: Dynamic rule limit exceeded",
  });
  assert.equal(state.stored.domains, undefined);
});

test("unrelated messages are left for other listeners", () => {
  const state = lifecycle(HOST_OK);
  assert.equal(state.listeners.message({ action: "something-else" }, {}, () => {}), false);
});

// ── Navigation hand-off ───────────────────────────────────────────────────────

test("a listed navigation opens the browser and closes a fresh tab", async () => {
  const state = lifecycle(openHost());
  await prime(state);
  await state.listeners.navigate({
    frameId: 0, tabId: 2, url: "https://a.example/page", documentLifecycle: "active", transitionType: "link",
  });
  assert.deepEqual(state.nativeMessages, [{ action: "open", url: "https://a.example/page" }]);
  assert.deepEqual(state.removed, [2]);
});

test("a blocked redirect to a listed domain is handed off from onErrorOccurred", async () => {
  const state = lifecycle(openHost());
  await prime(state);
  await state.listeners.navigate({
    frameId: 0, tabId: 2, url: "https://tracker.example/start", documentLifecycle: "active", transitionType: "link",
  });
  assert.deepEqual(state.nativeMessages, []);

  await state.listeners.errorNavigate({
    frameId: 0, tabId: 2, url: "https://a.example/final", error: "net::ERR_BLOCKED_BY_CLIENT",
  });
  assert.deepEqual(state.nativeMessages, [{ action: "open", url: "https://a.example/final" }]);
  assert.deepEqual(state.removed, [2]);
});

test("one navigation is never handed off twice", async () => {
  const state = lifecycle(openHost());
  await prime(state);
  const details = {
    frameId: 0, tabId: 2, url: "https://a.example/page", documentLifecycle: "active", transitionType: "link",
  };
  await state.listeners.navigate(details);
  await state.listeners.errorNavigate({
    frameId: 0, tabId: 2, url: details.url, error: "net::ERR_BLOCKED_BY_CLIENT",
  });
  assert.equal(state.nativeMessages.length, 1);
  assert.deepEqual(state.removed, [2]);
});

test("a tab with an earlier page is kept and sent back", async () => {
  const state = lifecycle(openHost());
  await prime(state);
  await state.listeners.committed({ frameId: 0, tabId: 2, url: "https://search.example/" });
  await state.listeners.navigate({
    frameId: 0, tabId: 2, url: "https://a.example/page", documentLifecycle: "active", transitionType: "link",
  });
  assert.equal(state.nativeMessages.length, 1);
  assert.deepEqual(state.removed, []);
  assert.deepEqual(state.goneBack, [2]);
});

test("committed tabs survive a worker restart and are cleaned up on close", async () => {
  const session = {};
  const first = lifecycle(openHost(), { session });
  await prime(first);
  await first.listeners.committed({ frameId: 0, tabId: 2, url: "https://search.example/" });

  const second = lifecycle(openHost(), { session });
  await prime(second);
  await second.listeners.navigate({
    frameId: 0, tabId: 2, url: "https://a.example/page", documentLifecycle: "active", transitionType: "link",
  });
  assert.deepEqual(second.goneBack, [2]);
  assert.deepEqual(second.removed, []);

  const third = lifecycle(openHost(), { session });
  await prime(third);
  await third.listeners.tabRemoved(2);
  await third.listeners.navigate({
    frameId: 0, tabId: 2, url: "https://a.example/page", documentLifecycle: "active", transitionType: "link",
  });
  assert.deepEqual(third.removed, [2]);
  assert.deepEqual(third.goneBack, []);
});

test("the last remaining tab is never closed", async () => {
  const state = lifecycle(openHost(), { tabs: [{ id: 5 }] });
  await prime(state);
  await state.listeners.navigate({
    frameId: 0, tabId: 5, url: "https://a.example/page", documentLifecycle: "active", transitionType: "link",
  });
  assert.equal(state.nativeMessages.length, 1);
  assert.deepEqual(state.removed, []);
});

test("a launch error leaves the tab and the URL in place", async () => {
  const state = lifecycle(openHost({ open: () => ({ status: "error", error: "browser command exited with status 1" }) }));
  await prime(state);
  await state.listeners.navigate({
    frameId: 0, tabId: 2, url: "https://a.example/page", documentLifecycle: "active", transitionType: "link",
  });
  assert.deepEqual(state.nativeMessages, [{ action: "open", url: "https://a.example/page" }]);
  assert.deepEqual(state.removed, []);
});

test("restored tabs skip their first hand-off", async () => {
  const state = lifecycle(openHost(), { tabs: [{ id: 4 }] });
  await state.listeners.startup();
  state.nativeMessages.length = 0;

  const first = {
    frameId: 0, tabId: 4, url: "https://a.example/restored", documentLifecycle: "active", transitionType: "link",
  };
  await state.listeners.navigate(first);
  await state.listeners.errorNavigate({
    frameId: 0, tabId: 4, url: first.url, error: "net::ERR_BLOCKED_BY_CLIENT",
  });
  assert.deepEqual(state.nativeMessages, []);

  await state.listeners.navigate({
    frameId: 0, tabId: 4, url: "https://a.example/clicked", documentLifecycle: "active", transitionType: "link",
  });
  assert.deepEqual(state.nativeMessages, [{ action: "open", url: "https://a.example/clicked" }]);
});

test("the context menu sends an alias and ignores non-http links", async () => {
  const state = lifecycle(openHost());
  await prime(state);
  await state.listeners.menu({
    menuItemId: "open-in-browser:firefox", linkUrl: "javascript:alert(1)",
  });
  assert.deepEqual(state.nativeMessages, []);

  await state.listeners.menu({
    menuItemId: "open-in-browser:firefox", linkUrl: "https://a.example/link",
  });
  assert.deepEqual(state.nativeMessages, [
    { action: "open", url: "https://a.example/link", browser: "firefox" },
  ]);
});
