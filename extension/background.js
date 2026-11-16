const NATIVE_HOST = "open_in_browser";

// Must match PROTOCOL_VERSION in native_host.py. Hosts from before that constant
// existed are protocol 1 and silently ignore browser selection by domain.
const HOST_PROTOCOL = 2;

// ── Native host communication ─────────────────────────────────────────────────

function isHostUnreachable(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("native messaging host not found") || text.includes("forbidden");
}

function callNativeHost(message) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative(NATIVE_HOST);

    port.onMessage.addListener((response) => {
      port.disconnect();
      resolve(response);
    });

    // Always settle: a host that exits without replying must not leave callers
    // waiting forever. Rejecting after a reply has resolved is a no-op.
    port.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message || "Native host exited without replying";
      reject(new Error(message));
    });

    port.postMessage(message);
  });
}

// ── Domain list management ────────────────────────────────────────────────────

// Resolves to { ok, reachable, outdated?, error?, count? }. `reachable: false`
// means the native host could not be started at all (not installed or not
// allowed for this extension ID), which only installing it can fix;
// `outdated: true` means an older helper replied and must be replaced;
// `reachable: true` with an error means the host ran but its config is broken.
async function loadDomains() {
  let response;
  try {
    response = await callNativeHost({ action: "get_domains" });
  } catch (err) {
    console.error("[open-in-browser] Failed to reach the native host:", err.message);
    return { ok: false, reachable: !isHostUnreachable(err.message), error: err.message };
  }

  try {
    // A helper older than this extension would silently open every site in
    // Firefox, so it must be reinstalled. Check this before the status error:
    // a current host's config errors are not a protocol problem.
    if (response.protocol !== HOST_PROTOCOL) {
      const error = "The helper app is older than this extension and must be reinstalled.";
      console.error("[open-in-browser] Native host protocol is outdated:", response.protocol);
      return { ok: false, reachable: true, outdated: true, error };
    }

    // A native-host error (e.g. missing domains.txt) must not wipe the working
    // config: keep the cached domains, rules, and menus untouched.
    if (response.status === "error" || response.error) {
      const error = response.error || "The native host reported an error";
      console.error("[open-in-browser] Native host error:", error);
      return { ok: false, reachable: true, error };
    }

    const domains = response.domains || [];
    const browsers = response.browsers || {};

    // Install the block rules first: caching domains before the rules exist
    // would let onBeforeNavigate match sites the network layer does not block.
    try {
      await updateBlockRules(domains);
    } catch (err) {
      console.error("[open-in-browser] Failed to update block rules:", err.message);
      return { ok: false, reachable: true, error: `Could not update block rules: ${err.message}` };
    }

    await chrome.storage.local.set({ domains, browsers });
    console.log(`[open-in-browser] Loaded ${domains.length} domain(s)`);
    rebuildContextMenus(browsers).catch((err) => {
      console.error("[open-in-browser] Failed to rebuild context menus:", err.message);
    });
    return { ok: true, reachable: true, count: domains.length };
  } catch (err) {
    console.error("[open-in-browser] Failed to load domains:", err.message);
    return { ok: false, reachable: true, error: err.message };
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

let contextMenusUpdate = Promise.resolve();

function rebuildContextMenus(browsers) {
  // Serialize like the rule update: overlapping removals would otherwise let a
  // second create() batch hit the first batch's IDs and fail with "duplicate id".
  const update = contextMenusUpdate.then(() => replaceContextMenus(browsers));
  contextMenusUpdate = update.catch(() => {});
  return update;
}

function createContextMenu(details) {
  return new Promise((resolve) => {
    chrome.contextMenus.create(details, () => {
      if (chrome.runtime.lastError) {
        console.error("[open-in-browser] Failed to create context menu:", chrome.runtime.lastError.message);
      }
      resolve();
    });
  });
}

async function replaceContextMenus(browsers) {
  await new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => {
      if (chrome.runtime.lastError) {
        console.error("[open-in-browser] Failed to remove context menus:", chrome.runtime.lastError.message);
      }
      resolve();
    });
  });

  const aliases = Object.keys(browsers);
  if (aliases.length === 0) return;

  await createContextMenu({
    id: "open-in-browser-parent",
    title: "Open in Browser",
    contexts: ["link"],
  });

  for (const alias of aliases) {
    await createContextMenu({
      id: `open-in-browser:${alias}`,
      parentId: "open-in-browser-parent",
      title: alias.charAt(0).toUpperCase() + alias.slice(1),
      contexts: ["link"],
    });
  }
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (!info.menuItemId.startsWith("open-in-browser:")) return;

  const alias = info.menuItemId.replace("open-in-browser:", "");
  const browsers = await getCachedBrowsers();

  if (!browsers[alias]) {
    console.error(`[open-in-browser] Unknown browser alias: ${alias}`);
    return;
  }

  const url = info.linkUrl;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;

  try {
    const response = await callNativeHost({ action: "open", url, browser: alias });
    if (response.status === "error" || response.error) {
      throw new Error(response.error || "The native host reported an error");
    }
  } catch (err) {
    console.error("[open-in-browser] Failed to open browser:", err.message);
  }
});

// ── Matching logic ────────────────────────────────────────────────────────────

function matchDomain(hostname, domains) {
  // Most specific entry wins: work.example.com beats example.com even when the
  // broader entry appears first in domains.txt.
  let best = null;
  for (const entry of domains) {
    if (hostname === entry.domain || hostname.endsWith("." + entry.domain)) {
      if (!best || entry.domain.length > best.domain.length) best = entry;
    }
  }
  return best;
}

function isHttpUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

// ── Firefox hand-off ──────────────────────────────────────────────────────────
//
// The actual connection is already blocked by the DNR rules in updateBlockRules();
// these listeners only react to the same navigation to launch the other browser
// and dispose of the (blocked) tab. Their async timing no longer affects privacy.

const HANDOFF_WINDOW_MS = 5000;
const recentNavigations = new Map();
const restoredTabs = new Set();

// Claim a tabId+URL pair so onBeforeNavigate and onErrorOccurred cannot hand off
// the same navigation twice (a redirect, or a blocked fetch after onBeforeNavigate).
function claimNavigation(tabId, url) {
  const key = `${tabId}\n${url}`;
  const now = Date.now();
  for (const [oldKey, time] of recentNavigations) {
    if (now - time > HANDOFF_WINDOW_MS) recentNavigations.delete(oldKey);
  }
  if (recentNavigations.has(key)) return false;
  recentNavigations.set(key, now);
  return true;
}

// On startup, tabs restored by "continue where you left off" already existed
// before this extension saw them. Their first navigation is not a user click.
function skipRestoredTab(tabId) {
  if (!restoredTabs.has(tabId)) return false;
  restoredTabs.delete(tabId);
  return true;
}

// ── Committed tabs (chrome.storage.session survives worker restarts) ──────────

async function getCommittedTabs() {
  const { committedTabs } = await chrome.storage.session.get("committedTabs");
  return new Set(committedTabs || []);
}

async function isTabCommitted(tabId) {
  return (await getCommittedTabs()).has(String(tabId));
}

async function markTabCommitted(tabId) {
  const committed = await getCommittedTabs();
  committed.add(String(tabId));
  await chrome.storage.session.set({ committedTabs: [...committed] });
}

async function clearTabCommitted(tabId) {
  const committed = await getCommittedTabs();
  if (committed.delete(String(tabId))) {
    await chrome.storage.session.set({ committedTabs: [...committed] });
  }
}

async function handOff(tabId, url) {
  // Hand off first; only discard the tab once the other browser actually opened.
  // On failure the tab stays on the DNR-blocked error page, preserving the URL.
  try {
    const response = await callNativeHost({ action: "open", url });
    if (response.status === "error" || response.error) {
      throw new Error(response.error || "The native host reported an error");
    }
  } catch (err) {
    console.error("[open-in-browser] Failed to open browser:", err.message);
    return;
  }

  try {
    // A tab with an earlier page (search results, a half-written form) is left
    // alone: go back to that page instead of destroying the user's history.
    if (await isTabCommitted(tabId)) {
      if (typeof chrome.tabs.goBack === "function") {
        try {
          await chrome.tabs.goBack(tabId);
        } catch (err) {
          console.error("[open-in-browser] Could not go back in the tab:", err.message);
        }
      }
      return;
    }

    // Closing the only tab of the last window would quit the browser.
    const tabs = await chrome.tabs.query({});
    if (tabs.length <= 1) return;
    await chrome.tabs.remove(tabId);
  } catch (err) {
    console.error("[open-in-browser] Failed to tidy up the tab:", err.message);
  }
}

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await markTabCommitted(details.tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  restoredTabs.delete(tabId);
  await clearTabCommitted(tabId);
});

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  // Prerender/speculative navigations reuse the hosting tab's tabId; acting on
  // them would close the user's active tab and launch the other browser with no
  // click. DNR already blocks those fetches, so ignore anything not "active".
  if (details.documentLifecycle && details.documentLifecycle !== "active") return;
  if (details.frameId !== 0) return;
  if (!isHttpUrl(details.url)) return;

  if (skipRestoredTab(details.tabId)) {
    // Suppress the matching onErrorOccurred for this blocked first navigation.
    claimNavigation(details.tabId, details.url);
    return;
  }

  const domains = await getCachedDomains();
  if (domains.length === 0) return;

  let hostname;
  try {
    hostname = new URL(details.url).hostname;
  } catch {
    return;
  }

  if (!matchDomain(hostname, domains)) return;
  if (!claimNavigation(details.tabId, details.url)) return;
  await handOff(details.tabId, details.url);
});

chrome.webNavigation.onErrorOccurred.addListener(async (details) => {
  // A server redirect can land on a blocked domain without onBeforeNavigate
  // seeing the final URL; the DNR block still reports this error for it.
  if (details.frameId !== 0) return;
  if (details.error !== "net::ERR_BLOCKED_BY_CLIENT") return;
  if (!isHttpUrl(details.url)) return;

  if (skipRestoredTab(details.tabId)) {
    claimNavigation(details.tabId, details.url);
    return;
  }

  const domains = await getCachedDomains();
  if (domains.length === 0) return;

  let hostname;
  try {
    hostname = new URL(details.url).hostname;
  } catch {
    return;
  }

  if (!matchDomain(hostname, domains)) return;
  if (!claimNavigation(details.tabId, details.url)) return;
  await handOff(details.tabId, details.url);
});

// ── Setup page ────────────────────────────────────────────────────────────────
//
// The extension cannot install its own native host, but it knows the two facts
// the installer needs: its ID and its version. setup.html turns those into a
// single command to paste into a terminal.

function openSetupPage() {
  const url = chrome.runtime.getURL("setup.html");
  // Matching by url works for the extension's own pages without the tabs
  // permission. Re-use an open setup tab instead of stacking duplicates.
  chrome.tabs.query({ url }, (tabs) => {
    if (chrome.runtime.lastError) {
      console.error("[open-in-browser] Could not look for the setup page:", chrome.runtime.lastError.message);
      chrome.tabs.create({ url });
      return;
    }
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true }, () => {
        if (chrome.runtime.lastError) {
          console.error("[open-in-browser] Could not focus the setup page:", chrome.runtime.lastError.message);
        }
      });
    } else {
      chrome.tabs.create({ url });
    }
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action !== "check-host") return false;
  loadDomains().then(sendResponse);
  return true; // Keep the channel open for the asynchronous reply.
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const status = await loadDomains();
  // Also covers updates across a host rename and an extension update that left
  // an older helper behind. Browser updates are left alone: popping a tab after
  // every browser update would be noise. Config errors are reported by the icon
  // click or setup page, not treated as a missing install.
  if ((!status.reachable || status.outdated) && (reason === "install" || reason === "update")) {
    openSetupPage();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) restoredTabs.add(tab.id);
  await loadDomains();
});

chrome.action.onClicked.addListener(async () => {
  // A click is an explicit request, so explain any failure, config included.
  const status = await loadDomains();
  if (!status.ok) openSetupPage();
});
