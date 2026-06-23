const NATIVE_HOST = "open_in_firefox";

// ── Native host communication ─────────────────────────────────────────────────

function callNativeHost(message) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative(NATIVE_HOST);

    port.onMessage.addListener((response) => {
      port.disconnect();
      resolve(response);
    });

    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      }
    });

    port.postMessage(message);
  });
}

// ── Domain list management ────────────────────────────────────────────────────

async function loadDomains() {
  try {
    const response = await callNativeHost({ action: "get_domains" });
    const domains = response.domains || [];
    const browsers = response.browsers || {};

    await chrome.storage.local.set({ domains, browsers });
    console.log(`[open-in-browser] Loaded ${domains.length} domain(s)`);

    await updateBlockRules(domains);
    rebuildContextMenus(browsers);
    return domains;
  } catch (err) {
    console.error("[open-in-browser] Failed to load domains:", err.message);
    return [];
  }
}

async function getCachedDomains() {
  const { domains } = await chrome.storage.local.get("domains");
  return domains || [];
}

async function getCachedBrowsers() {
  const { browsers } = await chrome.storage.local.get("browsers");
  return browsers || {};
}

// ── Connection blocking (declarativeNetRequest) ───────────────────────────────
//
// DNR rules are evaluated at the network layer *before* any connection is opened,
// so the matched domains never get a DNS/TCP/TLS handshake from this browser. This
// is what actually guarantees privacy — the webNavigation listener below only
// handles the Firefox hand-off and cannot prevent the connection on its own.

async function updateBlockRules(domains) {
  // Replace the full dynamic ruleset on every load so removed domains stop being
  // blocked. requestDomains matches the domain and all of its subdomains, which
  // mirrors matchDomain()'s `hostname.endsWith("." + domain)` behavior.
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((rule) => rule.id);

  const addRules = domains.map((entry, i) => ({
    id: i + 1,
    priority: 1,
    action: { type: "block" },
    condition: {
      requestDomains: [entry.domain],
      resourceTypes: ["main_frame"],
    },
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

// ── Context menus ─────────────────────────────────────────────────────────────

function rebuildContextMenus(browsers) {
  chrome.contextMenus.removeAll(() => {
    const aliases = Object.keys(browsers);
    if (aliases.length === 0) return;

    chrome.contextMenus.create({
      id: "open-in-browser-parent",
      title: "Open in Browser",
      contexts: ["link"],
    });

    for (const alias of aliases) {
      chrome.contextMenus.create({
        id: `open-in-browser:${alias}`,
        parentId: "open-in-browser-parent",
        title: alias.charAt(0).toUpperCase() + alias.slice(1),
        contexts: ["link"],
      });
    }
  });
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (!info.menuItemId.startsWith("open-in-browser:")) return;

  const alias = info.menuItemId.replace("open-in-browser:", "");
  const browsers = await getCachedBrowsers();
  const browser = browsers[alias];

  if (!browser) {
    console.error(`[open-in-browser] Unknown browser alias: ${alias}`);
    return;
  }

  const url = info.linkUrl;

  try {
    await callNativeHost({ action: "open", url, browser });
  } catch (err) {
    console.error("[open-in-browser] Failed to open browser:", err.message);
  }
});

// ── Matching logic ────────────────────────────────────────────────────────────

function matchDomain(hostname, domains) {
  for (const entry of domains) {
    if (hostname === entry.domain || hostname.endsWith("." + entry.domain)) {
      return entry.browser;
    }
  }
  return null;
}

// ── Firefox hand-off ──────────────────────────────────────────────────────────
//
// The actual connection is already blocked by the DNR rules in updateBlockRules();
// this listener only reacts to the same navigation to launch the other browser and
// dispose of the (blocked) tab. Its async timing no longer affects privacy.

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (!details.url.startsWith("http")) return;

  const domains = await getCachedDomains();
  if (domains.length === 0) return;

  let hostname;
  try {
    hostname = new URL(details.url).hostname;
  } catch {
    return;
  }

  const browser = matchDomain(hostname, domains);
  if (!browser) return;

  chrome.tabs.remove(details.tabId);

  try {
    await callNativeHost({ action: "open", url: details.url, browser });
  } catch (err) {
    console.error("[open-in-browser] Failed to open browser:", err.message);
  }
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(loadDomains);
chrome.runtime.onStartup.addListener(loadDomains);

chrome.action.onClicked.addListener(async () => {
  await loadDomains();
});
