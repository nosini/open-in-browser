const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../extension/setup.js"), "utf8");

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

// Just enough of an element for setup.js: text, visibility, class and events.
class FakeElement {
  constructor() {
    this.hidden = false;
    this.className = "";
    this.href = "";
    this.children = [];
    this.listeners = {};
    this.text = "";
  }
  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    this.text = value;
    this.children = [];
  }
  append(child) {
    this.children.push(child);
  }
  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }
}

// Loads setup.js with `reply` as the background's answer to "check-host".
async function page(reply) {
  const elements = {};
  const windowListeners = {};
  const clipboard = [];
  const sent = [];
  const context = {
    chrome: {
      runtime: {
        id: EXTENSION_ID,
        getManifest: () => ({ version: "1.3" }),
        async sendMessage(message) {
          // Clone out of the VM's realm so strict deep equality can compare it.
          sent.push(structuredClone(message));
          if (reply instanceof Error) throw reply;
          return reply;
        },
      },
    },
    document: {
      getElementById: (id) => (elements[id] ??= new FakeElement()),
      createElement: () => new FakeElement(),
    },
    navigator: { clipboard: { writeText: async (text) => clipboard.push(text) } },
    window: { addEventListener: (type, listener) => (windowListeners[type] = listener) },
  };
  vm.runInNewContext(source, context, { filename: "setup.js" });
  await new Promise(setImmediate); // Let the initial check finish.
  return { element: (id) => elements[id], windowListeners, clipboard, sent };
}

const COMMAND = "curl -fsSL https://raw.githubusercontent.com/nosini/open-in-browser/refs/tags/v1.3/bootstrap.sh"
  + ` | bash -s -- --ref v1.3 --id ${EXTENSION_ID}`;

test("the command pins this version's installer and fills in this extension's ID", async () => {
  const state = await page({ ok: false, reachable: false, error: "not found" });
  assert.equal(state.element("command").textContent, COMMAND);
  assert.equal(state.element("extension-id").textContent, EXTENSION_ID);
  assert.equal(state.element("source").href, "https://github.com/nosini/open-in-browser/tree/v1.3");

  await state.element("copy").listeners.click();
  assert.deepEqual(state.clipboard, [COMMAND]);
});

test("a missing host shows the install command with the browser's reason", async () => {
  const state = await page({ ok: false, reachable: false, error: "Specified native messaging host not found." });
  assert.deepEqual(state.sent, [{ action: "check-host" }]);
  assert.equal(state.element("install").hidden, false);
  assert.equal(state.element("configure").hidden, true);
  assert.equal(state.element("status").className, "status error");
  assert.match(state.element("status").textContent, /not installed.*Specified native messaging host not found\./);
});

test("a working host hides the install steps", async () => {
  const state = await page({ ok: true, reachable: true, count: 3 });
  assert.equal(state.element("install").hidden, true);
  assert.equal(state.element("configure").hidden, false);
  assert.equal(state.element("status").className, "status ok");
  assert.match(state.element("status").textContent, /3 domain\(s\) loaded/);
});

test("a config error keeps the install steps hidden and shows the host's message as text", async () => {
  const error = '<img src=x onerror="alert(1)"> domains.txt not found';
  const state = await page({ ok: false, reachable: true, error });
  assert.equal(state.element("install").hidden, true);
  assert.equal(state.element("configure").hidden, false);
  assert.ok(state.element("status").textContent.endsWith(error));
  assert.equal(state.element("status").innerHTML, undefined);
});

test("returning to the page checks again", async () => {
  const state = await page({ ok: false, reachable: false, error: "not found" });
  await state.windowListeners.focus();
  await state.element("check").listeners.click();
  assert.equal(state.sent.length, 3);
});

test("a failed check is reported instead of leaving the page pending", async () => {
  const state = await page(new Error("Could not establish connection"));
  assert.equal(state.element("status").className, "status error");
  assert.match(state.element("status").textContent, /Could not establish connection/);
});
