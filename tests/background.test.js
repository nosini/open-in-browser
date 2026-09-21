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
      runtime: { onInstalled: event, onStartup: event },
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
