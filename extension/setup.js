const RAW_REPOSITORY = "https://raw.githubusercontent.com/nosini/open-in-browser";
const REPOSITORY = "https://github.com/nosini/open-in-browser";

// Releases are tagged "v" + the manifest version (CI refuses tags that differ),
// so the installer that gets downloaded always matches this extension.
function installCommand(extensionId, version) {
  const ref = `v${version}`;
  return `curl -fsSL ${RAW_REPOSITORY}/refs/tags/${ref}/bootstrap.sh | bash -s -- --ref ${ref} --id ${extensionId}`;
}

const { version } = chrome.runtime.getManifest();
const command = installCommand(chrome.runtime.id, version);

const element = (id) => document.getElementById(id);
element("extension-id").textContent = chrome.runtime.id;
element("version").textContent = version;
element("command").textContent = command;
element("source").href = `${REPOSITORY}/tree/v${version}`;

// Host-supplied text only ever goes through textContent, never innerHTML.
function showStatus(kind, message, detail) {
  const status = element("status");
  status.className = `status ${kind}`;
  status.textContent = message;
  if (detail) {
    const extra = document.createElement("span");
    extra.className = "detail";
    extra.textContent = detail;
    status.append(extra);
  }
}

let checking = false;

async function check() {
  if (checking) return;
  checking = true;
  showStatus("pending", "Checking the helper app…");
  try {
    const result = await chrome.runtime.sendMessage({ action: "check-host" });
    element("install").hidden = result.reachable;
    element("configure").hidden = !result.reachable;
    if (result.ok) {
      showStatus("ok", `The helper app is working. ${result.count} domain(s) loaded.`);
    } else if (result.reachable) {
      showStatus("error", "The helper app is installed, but reported a problem:", result.error);
    } else {
      showStatus("error", "The helper app is not installed, or cannot be started.", result.error);
    }
  } catch (err) {
    showStatus("error", "Could not check the helper app.", err.message);
  } finally {
    checking = false;
  }
}

element("copy").addEventListener("click", async () => {
  const button = element("copy");
  try {
    await navigator.clipboard.writeText(command);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed — select the text instead";
  }
});

element("check").addEventListener("click", check);
// Coming back from the terminal is the moment the answer is likely to change.
window.addEventListener("focus", check);

check();
