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
      contextMenus: { onClicked: event },
      runtime: { onInstalled: event, onStartup: event, onMessage: event },
      action: { onClicked: event },
      webNavigation: { onBeforeNavigate: event },
    },
  };
  vm.runInNewContext(source, context, { filename: "background.js" });
  return { update: context.updateBlockRules, history, getRules: () => structuredClone(rules) };
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

// ── Setup page hand-off ───────────────────────────────────────────────────────

const HOST_MISSING = () => ({ lastError: "Specified native messaging host not found." });
const HOST_SILENT = () => ({ exit: true });
const HOST_CONFIG_ERROR = () => ({ error: "domains.txt not found at /home/user/.config/open-in-browser/domains.txt" });
const HOST_OK = () => ({ domains: domains("a.example"), browsers: {} });

// Runs background.js against a simulated native host. `host` maps a request to
// a reply, a disconnect with lastError, or a disconnect with no reply at all.
function lifecycle(host) {
  const listeners = {};
  const on = (name) => ({ addListener(listener) { listeners[name] = listener; } });
  const opened = [];
  const stored = {};
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
    chrome: {
      runtime,
      tabs: { create: ({ url }) => opened.push(url), remove() {} },
      storage: {
        local: {
          async set(values) { Object.assign(stored, values); },
          async get(key) { return { [key]: stored[key] }; },
        },
      },
      contextMenus: { removeAll(callback) { callback?.(); }, create() {}, onClicked: on("menu") },
      declarativeNetRequest: { async getDynamicRules() { return []; }, async updateDynamicRules() {} },
      action: { onClicked: on("action") },
      webNavigation: { onBeforeNavigate: on("navigate") },
    },
  };
  vm.runInNewContext(source, context, { filename: "background.js" });

  // structuredClone moves the reply out of the VM's realm, whose Object
  // prototype would otherwise fail strict deep equality.
  const checkHost = () => new Promise((resolve) => {
    const reply = (status) => resolve(structuredClone(status));
    assert.equal(listeners.message({ action: "check-host" }, {}, reply), true);
  });
  return { listeners, opened, stored, checkHost };
}

const SETUP_URL = "chrome-extension://test/setup.html";

test("installing or updating without a reachable host opens the setup page", async () => {
  for (const reason of ["install", "update"]) {
    for (const host of [HOST_MISSING, HOST_SILENT]) {
      const state = lifecycle(host);
      await state.listeners.installed({ reason });
      assert.deepEqual(state.opened, [SETUP_URL], `${reason} with ${host.name}`);
    }
  }
});

test("browser updates and working hosts leave the setup page closed", async () => {
  const browserUpdate = lifecycle(HOST_MISSING);
  await browserUpdate.listeners.installed({ reason: "chrome_update" });
  assert.deepEqual(browserUpdate.opened, []);

  const working = lifecycle(HOST_OK);
  await working.listeners.installed({ reason: "install" });
  assert.deepEqual(working.opened, []);
  assert.deepEqual(working.stored.domains, domains("a.example"));

  // A config problem is not an install problem; the icon click reports it.
  const misconfigured = lifecycle(HOST_CONFIG_ERROR);
  await misconfigured.listeners.installed({ reason: "install" });
  assert.deepEqual(misconfigured.opened, []);
});

test("clicking the icon opens the setup page for any failure", async () => {
  for (const host of [HOST_MISSING, HOST_SILENT, HOST_CONFIG_ERROR]) {
    const state = lifecycle(host);
    await state.listeners.action();
    assert.deepEqual(state.opened, [SETUP_URL], host.name);
  }
  const working = lifecycle(HOST_OK);
  await working.listeners.action();
  assert.deepEqual(working.opened, []);
});

test("the setup page's check tells a missing host from a broken config", async () => {
  assert.deepEqual(await lifecycle(HOST_MISSING).checkHost(), {
    ok: false, reachable: false, error: "Specified native messaging host not found.",
  });
  assert.deepEqual(await lifecycle(HOST_SILENT).checkHost(), {
    ok: false, reachable: false, error: "Native host exited without replying",
  });
  assert.deepEqual(await lifecycle(HOST_CONFIG_ERROR).checkHost(), {
    ok: false, reachable: true, error: HOST_CONFIG_ERROR().error,
  });
  assert.deepEqual(await lifecycle(HOST_OK).checkHost(), { ok: true, reachable: true, count: 1 });
});

test("unrelated messages are left for other listeners", () => {
  const state = lifecycle(HOST_OK);
  assert.equal(state.listeners.message({ action: "something-else" }, {}, () => {}), false);
});
