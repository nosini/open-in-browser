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

    // A native-host error (e.g. missing domains.txt) must not wipe the working
    // config: keep the cached domains, rules, and menus untouched.
    if (response.error) {
      console.error("[open-in-browser] Native host error:", response.error);
      return getCachedDomains();
    }

    const domains = response.domains || [];
    const browsers = response.browsers || {};

    await chrome.storage.local.set({ domains, browsers });
    console.log(`[open-in-browser] Loaded ${domains.length} domain(s)`);

    // Isolate the rules update so a rejected batch cannot skip menu rebuilding.
    try {
      await updateBlockRules(domains);
    } catch (err) {
      console.error("[open-in-browser] Failed to update block rules:", err.message);
    }
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
// DNR rules are evaluated at the network layer *before* any connection is opened.
// They only cover top-level navigations (resourceTypes ["main_frame"]), so a
// matched domain gets no DNS/TCP/TLS handshake when the user navigates to it in
// this browser — which is what the Firefox hand-off relies on. Subresource
// requests (iframes, images, fetches) to a matched domain from other sites are
// NOT blocked; widening the scope would break third-party pages that embed it.

let blockRulesUpdate = Promise.resolve();

function updateBlockRules(domains) {
  // Reloads must not overwrite each other's rules or temporary validation rule.
  const update = blockRulesUpdate.then(() => replaceBlockRules(domains));
  blockRulesUpdate = update.catch(() => {});
  return update;
}

async function replaceBlockRules(domains) {
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

  // updateDynamicRules is atomic: one malformed domain rejects the whole batch.
  // Try the batch first, then validate individually without removing the old
  // protection. Only the final atomic update replaces the working ruleset.
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (err) {
    console.error("[open-in-browser] Batch rule update failed, validating individually:", err.message);
    const existingIds = new Set(removeRuleIds);
    let validationId = 1;
    while (existingIds.has(validationId)) validationId++;
    const validRules = [];

    try {
      // Check that validation is possible using a known-good rule. If quota or
      // storage prevents even this add, retain the old set instead of treating
      // every replacement as invalid and committing an empty ruleset.
      if (existing.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          addRules: [{ ...existing[0], id: validationId }],
        });
      }

      // Reuse one spare ID so validation needs only one additional rule slot.
      for (const rule of addRules) {
        try {
          await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [validationId],
            addRules: [{ ...rule, id: validationId }],
          });
          validRules.push(rule);
        } catch (ruleErr) {
          console.error(
            `[open-in-browser] Failed to block domain "${rule.condition.requestDomains[0]}":`,
            ruleErr.message
          );
        }
      }

      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [...removeRuleIds, validationId],
        addRules: validRules,
      });
    } catch (fallbackErr) {
      // A failed commit leaves the original rules intact; remove only the probe.
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [validationId] });
      throw fallbackErr;
    }
  }
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
  // Prerender/speculative navigations reuse the hosting tab's tabId; acting on
  // them would close the user's active tab and launch the other browser with no
  // click. DNR already blocks those fetches, so ignore anything not "active".
  if (details.documentLifecycle && details.documentLifecycle !== "active") return;
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

  // Hand off first; only discard the tab once the other browser actually opened.
  // On failure the tab stays on the DNR-blocked error page, preserving the URL.
  try {
    await callNativeHost({ action: "open", url: details.url, browser });
    chrome.tabs.remove(details.tabId);
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
