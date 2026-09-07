/**
 * background.js — Tab Grouper Phase 3: Smart Auto-Collapse & Group Cleanup
 *
 * Phase 3 additions (on top of Phase 2):
 *  - autoCollapseInactive: when the user activates a tab outside any group,
 *    all other groups in that window are collapsed accordion-style. Switching
 *    into a grouped tab expands that group automatically.
 *  - Group dissolution: when a group's tab count drops to 1 after a close or
 *    detach, the remaining tab is ungrouped so solo tabs never linger inside
 *    an empty group container.
 *
 * Storage strategy:
 *  - User settings  → chrome.storage.sync   (syncs across devices)
 *  - Internal state → chrome.storage.local  (group map, color index)
 *  - Sync fallback  → graceful fallback to local if sync is unavailable.
 *
 * Cross-browser note:
 *  Firefox 139+ ships full tabGroups API support (tabGroups.query,
 *  tabGroups.update including collapsed-state, tabGroups.get, tabGroups.move).
 *  The Firefox manifest must declare the "tabGroups" permission and set
 *  strict_min_version to "139.0".  All tabGroups calls are still guarded
 *  with api?.tabGroups?.query / api?.tabGroups?.update so the extension
 *  degrades gracefully on older Firefox versions that lack the API.
 *  Versions below 139 treat all Phase 3 features as silent no-ops.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Default Settings & Constants
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Canonical default settings. Written to storage.sync on first install.
 * Options page reads/writes these same keys.
 *
 * @type {{
 *   minTabThreshold: number,
 *   autoGroupEnabled: boolean,
 *   excludedDomains: string[],
 *   groupColors: 'auto'
 * }}
 */
const DEFAULT_SETTINGS = {
  minTabThreshold:      3,
  autoGroupEnabled:     true,
  autoCollapseInactive: false, // Phase 3: collapse unfocused groups on tab switch
  excludedDomains:      [],    // Empty by default — only user-added domains are excluded
  groupColors:          'auto',
};

/**
 * Tab group colors supported by Chrome's tabGroups API, in rotation order.
 * Used when groupColors === 'auto' (the only mode in Phase 2).
 */
const GROUP_COLORS = [
  'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange',
];

/**
 * URL schemes we silently ignore — internal browser pages with no groupable domain.
 */
const IGNORED_SCHEMES = [
  'chrome://', 'chrome-extension://', 'edge://',
  'about:', 'data:', 'javascript:', 'file://',
  'moz-extension://',
];

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Cross-browser API Shim
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve the browser extension API namespace.
 * Chrome MV3 → `chrome`; Firefox → `browser` (with chrome as alias in some builds).
 * We prefer `chrome` because Chrome's tabGroups API lives there.
 */
const api = globalThis.chrome ?? globalThis.browser;

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Settings Cache
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * In-memory settings cache. Populated lazily by getSettings() on first use,
 * and updated by chrome.storage.onChanged so we never serve stale values
 * within the same service-worker lifetime.
 *
 * Set to null to signal "not yet loaded — must read from storage".
 *
 * NOTE: Service workers are ephemeral (~30 s idle timeout). After a restart,
 * settingsCache starts as null again and is re-populated from storage on the
 * next grouping pass. This is intentional — we never rely on in-memory state
 * surviving a restart.
 *
 * @type {typeof DEFAULT_SETTINGS | null}
 */
let settingsCache = null;

/**
 * Reads current settings from storage.sync (with fallback to storage.local).
 * Returns merged defaults so callers always get a fully-populated object,
 * even if some keys are missing from storage.
 *
 * Result is cached in settingsCache for the duration of this SW lifetime.
 *
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
async function getSettings() {
  if (settingsCache !== null) return settingsCache;

  const keys = Object.keys(DEFAULT_SETTINGS);

  let stored = {};
  try {
    stored = await api.storage.sync.get(keys);
  } catch (syncErr) {
    // storage.sync may be unavailable (e.g., user not signed in, or Firefox
    // without sync configured). Fall back to local storage.
    console.warn('[TabGrouper] storage.sync unavailable, falling back to local:', syncErr.message);
    try {
      stored = await api.storage.local.get(keys);
    } catch (localErr) {
      console.error('[TabGrouper] Both sync and local storage failed:', localErr);
    }
  }

  // Merge stored values over defaults — any missing key uses the default
  settingsCache = { ...DEFAULT_SETTINGS, ...stored };
  return settingsCache;
}

/**
 * Writes settings to storage.sync with a local fallback.
 * Used by the options page (via messaging) and internally.
 *
 * @param {Partial<typeof DEFAULT_SETTINGS>} updates
 */
async function saveSettings(updates) {
  try {
    await api.storage.sync.set(updates);
  } catch {
    await api.storage.local.set(updates);
  }
  // Eagerly patch the cache so the next grouping pass uses fresh values
  // without waiting for storage.onChanged to fire.
  if (settingsCache) {
    Object.assign(settingsCache, updates);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Storage Change Listener (settings hot-reload)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Whenever a setting changes (from the options page or another device via sync),
 * patch the in-memory cache immediately so the next grouping pass picks it up
 * without a round-trip to storage.
 *
 * Registered synchronously at the top level — Chrome requires this so the
 * listener survives service-worker restarts.
 */
api.storage.onChanged.addListener((changes, areaName) => {
  // We only care about keys that belong to our settings schema
  const settingsKeys = new Set(Object.keys(DEFAULT_SETTINGS));
  const relevantChange = Object.keys(changes).some(k => settingsKeys.has(k));

  if (!relevantChange) return;

  if (settingsCache !== null) {
    // Patch the cache in-place with new values
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (settingsKeys.has(key) && newValue !== undefined) {
        settingsCache[key] = newValue;
      }
    }
    console.log('[TabGrouper] Settings cache updated from storage.onChanged:', changes);
  }
  // If cache is null (SW just restarted), getSettings() will load fresh from
  // storage on the next pass — no action needed here.
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Debounce State
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Per-window debounce guard (in-memory Set).
 * Safe to keep in memory: the 150 ms debounce window is shorter than any
 * realistic SW restart cycle. Worst case of a missed restart: one extra
 * grouping pass, which is idempotent.
 */
const pendingWindows = new Set();

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — URL & Domain Utilities
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extracts the effective hostname from a URL, stripping 'www.' for grouping.
 *
 * Returns the FULL hostname (e.g. "mail.google.com") rather than just the
 * root domain — this preserves the exclusion logic which may target specific
 * subdomains.
 *
 * Examples:
 *   "https://www.youtube.com/..."       → "youtube.com"
 *   "https://mail.google.com/mail/"     → "mail.google.com"
 *   "https://docs.google.com/"          → "docs.google.com"
 *   "chrome://newtab/"                  → null
 *
 * @param {string} url
 * @returns {string|null}
 */
function getHostname(url) {
  if (!url || typeof url !== 'string') return null;

  for (const scheme of IGNORED_SCHEMES) {
    if (url.startsWith(scheme)) return null;
  }

  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }

  if (!hostname) return null;

  // Strip 'www.' so that www.youtube.com groups with youtube.com
  if (hostname.startsWith('www.')) hostname = hostname.slice(4);

  return hostname || null;
}

/**
 * Derives the grouping key from a hostname.
 *
 * Rule: use the FULL hostname as-is (www. is already stripped by getHostname).
 * This means every distinct subdomain is its own group:
 *
 *   gemini.google.com  → groups only with other gemini.google.com tabs
 *   mail.google.com    → groups only with other mail.google.com tabs
 *   google.com         → groups only with other google.com tabs
 *   youtube.com        → groups only with other youtube.com tabs
 *
 * This is intentional: functional web apps living on different subdomains
 * (Gemini, Gmail, Docs, Calendar…) are distinct products and should not
 * be merged into a single "google.com" group.
 *
 * @param {string} hostname  Already www-stripped by getHostname().
 * @returns {string}
 */
function getGroupingKey(hostname) {
  return hostname;
}

/**
 * Well-known hostname aliases.
 *
 * Keys   = colloquial / alternative names a user might type.
 * Values = the canonical hostname that the extension actually sees in tab.url.
 *
 * This allows exclusion entries like "gmail.com" to match tabs at
 * "mail.google.com" without breaking grouping for unrelated Google subdomains.
 *
 * Keep this list small and only add entries with genuine user confusion potential.
 */
const DOMAIN_ALIASES = {
  'gmail.com':        'mail.google.com',
  'google.mail.com':  'mail.google.com',   // typo variant
  'googlemail.com':   'mail.google.com',   // legacy Google Mail domain
  'googledocs.com':   'docs.google.com',   // colloquial
  'googledrive.com':  'drive.google.com',  // colloquial
};

/**
 * Checks whether a tab's hostname should be skipped before grouping.
 *
 * Three tiers of matching (all case-insensitive, applied in order):
 *
 *  1. Exact match
 *       excluded = "gemini.google.com", hostname = "gemini.google.com" → SKIP
 *       excluded = "google.com",        hostname = "google.com"         → SKIP
 *
 *  2. Parent-domain match  (excluded entry is a suffix of the hostname)
 *       excluded = "google.com",  hostname = "mail.google.com"    → SKIP
 *       excluded = "google.com",  hostname = "gemini.google.com"  → SKIP
 *       excluded = "mail.google.com", hostname = "gemini.google.com" → NOT skipped
 *       excluded = "slack.com",   hostname = "app.slack.com"      → SKIP
 *
 *  3. Known-alias match
 *       excluded = "gmail.com",   hostname = "mail.google.com"    → SKIP
 *       excluded = "gmail.com",   hostname = "gemini.google.com"  → NOT skipped
 *
 * Subdomain grouping separation is fully preserved — only the exclusion
 * check uses this function; getGroupingKey() is untouched.
 *
 * @param {string}   hostname        Normalised tab hostname (www-stripped).
 * @param {string[]} excludedDomains User-configured exclusion list.
 * @returns {boolean}
 */
function isExcluded(hostname, excludedDomains) {
  if (!Array.isArray(excludedDomains) || excludedDomains.length === 0) return false;

  for (const entry of excludedDomains) {
    const e = entry.toLowerCase().trim();
    if (!e) continue;

    // Tier 1 — Exact match
    if (hostname === e) return true;

    // Tier 2 — Parent-domain match
    //   hostname "mail.google.com" ends with ".google.com"  ✓
    //   hostname "google.com"      ends with ".google.com"  ✗  (handled by Tier 1)
    if (hostname.endsWith(`.${e}`)) return true;

    // Tier 3 — Known-alias match
    //   If the user typed "gmail.com", DOMAIN_ALIASES["gmail.com"] = "mail.google.com"
    //   We then apply Tier 1 + Tier 2 against the canonical target.
    const aliasTarget = DOMAIN_ALIASES[e];
    if (aliasTarget) {
      if (hostname === aliasTarget) return true;
      if (hostname.endsWith(`.${aliasTarget}`)) return true;
    }
  }
  return false;
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — Display Name & Color Utilities
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Human-readable group titles keyed by the FULL normalised hostname
 * (post www-strip). Subdomain entries take priority so that e.g.
 * "gemini.google.com" shows "Gemini", not "google.com".
 *
 * When no entry matches, getGroupTitle() falls back to the raw hostname.
 */
const DOMAIN_DISPLAY_NAMES = {
  // ── Google suite (subdomain-specific) ─────────────────────────────────────
  'gemini.google.com':       'Gemini',
  'mail.google.com':         'Gmail',
  'docs.google.com':         'Google Docs',
  'sheets.google.com':       'Google Sheets',
  'slides.google.com':       'Google Slides',
  'drive.google.com':        'Google Drive',
  'calendar.google.com':     'Google Calendar',
  'meet.google.com':         'Google Meet',
  'chat.google.com':         'Google Chat',
  'photos.google.com':       'Google Photos',
  'maps.google.com':         'Google Maps',
  'translate.google.com':    'Google Translate',
  'news.google.com':         'Google News',
  'play.google.com':         'Google Play',
  'classroom.google.com':    'Google Classroom',
  'keep.google.com':         'Google Keep',
  'sites.google.com':        'Google Sites',
  'analytics.google.com':    'Google Analytics',
  'ads.google.com':          'Google Ads',
  'console.cloud.google.com':'Google Cloud',
  'search.google.com':       'Google Search',
  'google.com':              'Google',
  // ── YouTube ────────────────────────────────────────────────────────────────
  'youtube.com':             'YouTube',
  'studio.youtube.com':      'YouTube Studio',
  'music.youtube.com':       'YouTube Music',
  // ── Microsoft / Office 365 ────────────────────────────────────────────────
  'outlook.live.com':        'Outlook',
  'outlook.office.com':      'Outlook',
  'outlook.office365.com':   'Outlook',
  'teams.microsoft.com':     'Microsoft Teams',
  'onedrive.live.com':       'OneDrive',
  'office.com':              'Microsoft Office',
  'sharepoint.com':          'SharePoint',
  'microsoft.com':           'Microsoft',
  'azure.microsoft.com':     'Azure',
  'portal.azure.com':        'Azure Portal',
  // ── GitHub ────────────────────────────────────────────────────────────────
  'github.com':              'GitHub',
  'gist.github.com':         'GitHub Gist',
  // ── Developer tools ───────────────────────────────────────────────────────
  'stackoverflow.com':       'Stack Overflow',
  'stackexchange.com':       'Stack Exchange',
  'vercel.com':              'Vercel',
  'app.vercel.com':          'Vercel',
  'netlify.com':             'Netlify',
  'app.netlify.com':         'Netlify',
  'codepen.io':              'CodePen',
  'codesandbox.io':          'CodeSandbox',
  'replit.com':              'Replit',
  'jsfiddle.net':            'JSFiddle',
  'npmjs.com':               'npm',
  // ── Social ────────────────────────────────────────────────────────────────
  'reddit.com':              'Reddit',
  'twitter.com':             'Twitter / X',
  'x.com':                   'Twitter / X',
  'facebook.com':            'Facebook',
  'instagram.com':           'Instagram',
  'linkedin.com':            'LinkedIn',
  'discord.com':             'Discord',
  'slack.com':               'Slack',
  'app.slack.com':           'Slack',
  'threads.net':             'Threads',
  'bsky.app':                'Bluesky',
  // ── Productivity ──────────────────────────────────────────────────────────
  'notion.so':               'Notion',
  'figma.com':               'Figma',
  'app.figma.com':           'Figma',
  'linear.app':              'Linear',
  'jira.atlassian.net':      'Jira',
  'confluence.atlassian.net':'Confluence',
  'trello.com':              'Trello',
  'asana.com':               'Asana',
  'airtable.com':            'Airtable',
  'miro.com':                'Miro',
  'loom.com':                'Loom',
  // ── Shopping & media ──────────────────────────────────────────────────────
  'amazon.com':              'Amazon',
  'netflix.com':             'Netflix',
  'medium.com':              'Medium',
  'wikipedia.org':           'Wikipedia',
  // ── AI assistants ─────────────────────────────────────────────────────────
  'chat.openai.com':         'ChatGPT',
  'chatgpt.com':             'ChatGPT',
  'claude.ai':               'Claude',
  'perplexity.ai':           'Perplexity',
  'copilot.microsoft.com':   'Copilot',
};

function getGroupTitle(groupingKey) {
  return DOMAIN_DISPLAY_NAMES[groupingKey] ?? groupingKey;
}

/**
 * Returns the next color from the rotation, persisted in storage.local
 * so the cycle is consistent across service-worker restarts.
 *
 * @returns {Promise<string>}
 */
async function getNextColor() {
  try {
    const { colorIndex = 0 } = await api.storage.local.get('colorIndex');
    const color = GROUP_COLORS[colorIndex % GROUP_COLORS.length];
    await api.storage.local.set({ colorIndex: (colorIndex + 1) % GROUP_COLORS.length });
    return color;
  } catch (err) {
    console.warn('[TabGrouper] Could not read/write colorIndex:', err);
    return 'blue';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Core Grouping Logic
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Main grouping pass for a single browser window.
 *
 * Phase 2 additions (marked ★):
 *  ★ Reads live settings from cache (with storage fallback).
 *  ★ Bails immediately if autoGroupEnabled is false.
 *  ★ Skips excluded domains.
 *  ★ Uses dynamic minTabThreshold instead of hardcoded 3.
 *
 * @param {number} windowId
 */
async function groupTabsForWindow(windowId) {
  // Guard: chrome.tabs.group may not exist on Firefox yet
  if (!api?.tabs?.group) {
    console.log('[TabGrouper] tabs.group API unavailable — skipping.');
    return;
  }

  // ★ Load settings (from cache or storage)
  const settings = await getSettings();

  // ★ Master toggle — bail early if auto-grouping is disabled
  if (!settings.autoGroupEnabled) {
    console.log('[TabGrouper] Auto-grouping is disabled — skipping pass.');
    return;
  }

  const { minTabThreshold, excludedDomains } = settings;

  // ── Step 1: Query non-pinned tabs ─────────────────────────────────────────
  let allTabs;
  try {
    allTabs = await api.tabs.query({ windowId, pinned: false });
  } catch (err) {
    console.error('[TabGrouper] Failed to query tabs for window', windowId, err);
    return;
  }

  // ── Step 2: Build groupingKey → tabs map ──────────────────────────────────
  /** @type {Map<string, { tabs: chrome.tabs.Tab[], hostname: string }>} */
  const groupingMap = new Map();

  for (const tab of allTabs) {
    if (tab.id == null || !tab.url) continue;

    const hostname = getHostname(tab.url);
    if (!hostname) continue;

    // ★ Skip excluded domains
    if (isExcluded(hostname, excludedDomains)) continue;

    const key = getGroupingKey(hostname);

    if (!groupingMap.has(key)) {
      groupingMap.set(key, { tabs: [], hostname });
    }
    groupingMap.get(key).tabs.push(tab);
  }

  // ── Step 3: Load existing tab groups in this window ───────────────────────
  /** @type {Map<number, { title: string }>} */
  const existingGroups = new Map();

  if (api?.tabGroups?.query) {
    try {
      const groups = await api.tabGroups.query({ windowId });
      for (const group of groups) {
        if (group.id != null && group.title) {
          existingGroups.set(group.id, { title: group.title });
        }
      }
    } catch (err) {
      console.warn('[TabGrouper] Could not query existing tab groups:', err);
    }
  }

  // ── Step 4: Load persisted domain→groupId map ─────────────────────────────
  let domainGroupMap;
  try {
    const stored = await api.storage.local.get('domainGroupMap');
    domainGroupMap = stored.domainGroupMap ?? {};
  } catch {
    domainGroupMap = {};
  }

  // ── Step 5: Process each grouping key ─────────────────────────────────────
  for (const [key, { tabs }] of groupingMap.entries()) {
    const storageKey     = `${windowId}:${key}`;
    const existingGroupId = domainGroupMap[storageKey];
    const groupStillExists = existingGroupId != null && existingGroups.has(existingGroupId);

    if (groupStillExists) {
      // ── Case A: Group exists — add any ungrouped tabs to it ───────────────
      const UNGROUPED = -1; // Chrome uses -1 for TAB_ID_NONE in tab.groupId
      const ungrouped = tabs.filter(t =>
        t.groupId === UNGROUPED || t.groupId == null,
      );

      if (ungrouped.length > 0) {
        const tabIds = ungrouped.map(t => t.id).filter(id => id != null);
        try {
          await api.tabs.group({ groupId: existingGroupId, tabIds });
          console.log(`[TabGrouper] Added ${tabIds.length} tab(s) to group "${key}".`);
        } catch (err) {
          console.warn(`[TabGrouper] Failed to add to group ${existingGroupId}:`, err);
          delete domainGroupMap[storageKey];
        }
      }
    } else {
      // Clean up stale storage entry
      if (existingGroupId != null) delete domainGroupMap[storageKey];

      // ── Case B: No group — create one if threshold met ────────────────────
      // ★ Use dynamic minTabThreshold from settings
      if (tabs.length >= minTabThreshold) {
        const tabIds = tabs.map(t => t.id).filter(id => id != null);
        if (tabIds.length < minTabThreshold) continue;

        let newGroupId;
        try {
          newGroupId = await api.tabs.group({ tabIds, createProperties: { windowId } });
        } catch (err) {
          console.error(`[TabGrouper] Failed to create group for "${key}":`, err);
          continue;
        }

        if (api?.tabGroups?.update && newGroupId != null) {
          const color = await getNextColor();
          const title = getGroupTitle(key);
          try {
            await api.tabGroups.update(newGroupId, { title, color });
            console.log(`[TabGrouper] Created group "${title}" (${color}) — ${tabIds.length} tabs.`);
          } catch (err) {
            console.warn(`[TabGrouper] Failed to style group ${newGroupId}:`, err);
          }
        }

        if (newGroupId != null) domainGroupMap[storageKey] = newGroupId;
      }
    }
  }

  // ── Step 6: Persist updated domainGroupMap ────────────────────────────────
  try {
    await api.storage.local.set({ domainGroupMap });
  } catch (err) {
    console.warn('[TabGrouper] Could not persist domainGroupMap:', err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — Debounced Scheduler
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Schedules a grouping pass for windowId, debounced to 150 ms.
 * Collapses burst events (created → loading → complete) into a single pass.
 *
 * @param {number} windowId
 */
function scheduleGrouping(windowId) {
  if (windowId == null || windowId < 0) return;
  if (pendingWindows.has(windowId)) return;

  pendingWindows.add(windowId);
  setTimeout(async () => {
    pendingWindows.delete(windowId);
    await groupTabsForWindow(windowId);
  }, 150);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10 — Auto-Collapse (Phase 3 — deterministic accordion)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Safely updates a single tab group's collapsed state.
 *
 * Guards:
 *  - Returns immediately if the tabGroups API is unavailable (Firefox).
 *  - Skips the API call if the group is already in the desired state to avoid
 *    redundant round-trips and Chrome's "flickering" on simultaneous updates.
 *  - Catches all errors so a group that closed mid-loop can't abort the caller.
 *
 * @param {chrome.tabGroups.TabGroup} group     Full group object from tabGroups.query.
 * @param {boolean}                   collapsed  The desired collapsed state.
 */
/**
 * Milliseconds to wait between retry attempts when Chrome rejects a
 * tabGroups.update call with the "Tabs cannot be edited right now" error.
 * This error occurs because the browser locks tab state during mouse-down
 * (the user is clicking or dragging a tab). A short delay lets the lock clear.
 */
const COLLAPSE_RETRY_DELAY_MS = 60;

/** Maximum number of retry attempts before giving up on a single group update. */
const COLLAPSE_MAX_RETRIES = 3;

async function safeSetGroupCollapsed(group, collapsed) {
  if (!api?.tabGroups?.update) return;

  // Skip if already in the desired state — avoids unnecessary API calls and
  // the subtle flicker that occurs when Chrome redraws an already-correct group.
  if (group.collapsed === collapsed) {
    console.log(
      `[TabGrouper] Group ${group.id} ("${group.title ?? '?'}") already collapsed=${collapsed} — skipping.`,
    );
    return;
  }

  // ── Diagnostic log 5: each collapse/expand API call ───────────────────────
  console.log('[TabGrouper] Updating group:', group.id, `("${group.title ?? '?'}")`, 'collapsed ->', collapsed);

  // Retry loop — Chrome rejects tabGroups.update with "Tabs cannot be edited
  // right now" when the user is mid-click (mouse-down drag lock). We wait
  // COLLAPSE_RETRY_DELAY_MS and try again, up to COLLAPSE_MAX_RETRIES times.
  for (let attempt = 1; attempt <= COLLAPSE_MAX_RETRIES; attempt++) {
    try {
      await api.tabGroups.update(group.id, { collapsed });
      return; // success — exit immediately
    } catch (err) {
      const isDragLock = err?.message?.includes('Tabs cannot be edited right now');

      if (isDragLock && attempt < COLLAPSE_MAX_RETRIES) {
        console.warn(
          `[TabGrouper] Group ${group.id} drag-locked — retrying in ${COLLAPSE_RETRY_DELAY_MS}ms ` +
          `(attempt ${attempt}/${COLLAPSE_MAX_RETRIES})`,
        );
        await new Promise(resolve => setTimeout(resolve, COLLAPSE_RETRY_DELAY_MS));
        continue;
      }

      // Non-retryable error (group gone, invalid ID, etc.) OR out of retries.
      console.warn(
        `[TabGrouper] Could not set collapsed=${collapsed} on group ${group.id} ` +
        `("${group.title ?? '?'}") after ${attempt} attempt(s):`,
        err.message,
      );
      return;
    }
  }
}

/**
 * Deterministic accordion collapse handler.
 *
 * Called on every tab activation. Implements strict two-branch logic:
 *
 *  Branch A — active tab is UNGROUPED (groupId === -1 or missing):
 *    → Collapse ALL groups in the window.
 *
 *  Branch B — active tab BELONGS TO A GROUP (groupId !== -1):
 *    → Expand that specific group.
 *    → Collapse ALL other groups.
 *
 * Each group is updated sequentially (not with Promise.all) so Chrome's
 * tabGroups API processes them one at a time, preventing race-condition
 * flickering that occurs with concurrent updates to the same window.
 *
 * Each update is individually guarded — one failing group (e.g. closing
 * mid-loop) never aborts the remaining updates.
 *
 * The autoCollapseInactive setting check is the caller's responsibility so
 * it can be read fresh from storage.sync on every activation event instead
 * of from the possibly-stale settingsCache.
 *
 * @param {number} windowId      Window whose groups to update.
 * @param {number} activeGroupId groupId of the active tab; -1 when ungrouped.
 */
async function handleAutoCollapse(windowId, activeGroupId) {
  if (!api?.tabGroups?.query) return; // Firefox guard — API not available yet

  // NOTE: settings check (autoCollapseInactive) is performed by the caller
  //       so this function can be called without hitting the settings cache.

  // Fetch the current state of every group in this window
  let groups;
  try {
    groups = await api.tabGroups.query({ windowId });
  } catch (err) {
    console.warn('[TabGrouper] Auto-collapse: could not query groups:', err.message);
    return;
  }

  if (!groups.length) {
    console.log('[TabGrouper] No groups found in window', windowId, '— nothing to collapse.');
    return;
  }

  // ── Diagnostic log 4: all groups visible to this handler ──────────────────
  console.log('[TabGrouper] Found groups:', groups.map(g => ({
    id:        g.id,
    title:     g.title,
    collapsed: g.collapsed,
  })));

  // Determine the target state for each group
  const isTabUngrouped = activeGroupId == null || activeGroupId === -1;

  let expanded = 0;
  let collapsed = 0;

  // Sequential loop — Chrome handles one tabGroups.update at a time reliably
  for (const group of groups) {
    if (group.id == null) continue;

    // Branch A: ungrouped tab → collapse everything
    // Branch B: grouped tab  → expand active group, collapse the rest
    const shouldCollapse = isTabUngrouped || group.id !== activeGroupId;

    await safeSetGroupCollapsed(group, shouldCollapse);

    if (shouldCollapse) collapsed++;
    else expanded++;
  }

  console.log(
    `[TabGrouper] Auto-collapse: window=${windowId} activeGroup=${activeGroupId} ` +
    `expanded=${expanded} collapsed=${collapsed}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11 — Group Dissolution (Phase 3)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Per-window debounce timers for the auto-collapse accordion.
 *
 * Key:   windowId (number)
 * Value: setTimeout timer ID
 *
 * When onActivated fires, we cancel any pending timer for that window and
 * schedule a new one 80 ms in the future. This has two benefits:
 *  1. Rapid tab switching (arrow-key cycling, mouse clicks) collapses only once.
 *  2. The 80 ms gap lets Chrome release its mouse-down drag lock before we call
 *     tabGroups.update, eliminating the "Tabs cannot be edited right now" error
 *     in the common case (safeSetGroupCollapsed still retries as a safety net).
 *
 * The Map is intentionally in-memory: if the service worker restarts, the
 * pending timer is gone but so is any mid-flight user action — the next
 * onActivated event will start a fresh timer correctly.
 */
const collapseTimers = new Map();

/** Milliseconds to delay handleAutoCollapse after a tab-activation event. */
const COLLAPSE_DEBOUNCE_MS = 80;

/**
 * Schedules an auto-collapse pass for the given window, cancelling any
 * previously pending pass for the same window.
 *
 * @param {number} windowId
 * @param {number} activeGroupId
 */
function scheduleCollapse(windowId, activeGroupId) {
  // Cancel any still-pending collapse for this window
  if (collapseTimers.has(windowId)) {
    clearTimeout(collapseTimers.get(windowId));
  }

  const timerId = setTimeout(async () => {
    collapseTimers.delete(windowId);
    try {
      await handleAutoCollapse(windowId, activeGroupId);
    } catch (err) {
      console.warn('[TabGrouper] scheduleCollapse: unhandled error:', err.message);
    }
  }, COLLAPSE_DEBOUNCE_MS);

  collapseTimers.set(windowId, timerId);
}

/**
 * onActivated — primary driver of the accordion auto-collapse behaviour.
 *
 * Registered synchronously at top level so Chrome replays it after every
 * service-worker restart (required for MV3 event-driven listeners).
 *
 * The actual collapse work is deferred 80 ms via scheduleCollapse() so the
 * browser's mouse-down drag lock has time to clear before any API call.
 */
api.tabs.onActivated.addListener(async (activeInfo) => {
  // ── Diagnostic log 1: confirm the listener fires ──────────────────────────
  console.log('[TabGrouper] Tab activated:', activeInfo.tabId, '| window:', activeInfo.windowId);

  if (!api?.tabGroups?.query) {
    console.warn('[TabGrouper] onActivated: tabGroups API not available — Firefox?');
    return;
  }

  try {
    // ── Diagnostic log 2: settings (raw object logged inside readAutoCollapseSetting)
    const autoCollapseInactive = await readAutoCollapseSetting();
    console.log('[TabGrouper] autoCollapseInactive resolved to:', autoCollapseInactive);
    if (!autoCollapseInactive) {
      console.log('[TabGrouper] Auto-collapse disabled — skipping.');
      return;
    }

    // Fetch the activated tab to read its groupId
    let activeGroupId = -1;
    try {
      const activeTab = await api.tabs.get(activeInfo.tabId);
      activeGroupId = activeTab.groupId ?? -1;
    } catch {
      // Tab closed before tabs.get completed — treat as ungrouped (collapse all)
      console.warn('[TabGrouper] tabs.get failed — treating tab as ungrouped.');
    }

    // ── Diagnostic log 3: the active tab's groupId ──────────────────────────
    console.log('[TabGrouper] Active Tab Group ID:', activeGroupId);

    // Defer the collapse by 80 ms so Chrome's drag lock clears first
    scheduleCollapse(activeInfo.windowId, activeGroupId);
  } catch (err) {
    console.warn('[TabGrouper] onActivated: auto-collapse error:', err.message);
  }
});

/**
 * onHighlighted — secondary fallback for edge cases where onActivated doesn't
 * fire (e.g. keyboard tab-cycling in some Chrome builds).
 *
 * Shares the same scheduleCollapse debounce as onActivated so duplicate calls
 * from both listeners firing in quick succession collapse only once.
 */
api.tabs.onHighlighted.addListener(async (highlightInfo) => {
  if (!api?.tabGroups?.query)        return; // Firefox guard
  if (!highlightInfo.tabIds?.length) return;

  try {
    const autoCollapseInactive = await readAutoCollapseSetting();
    if (!autoCollapseInactive) return;

    let activeGroupId = -1;
    try {
      const tab = await api.tabs.get(highlightInfo.tabIds[0]);
      activeGroupId = tab.groupId ?? -1;
    } catch {
      // Tab gone — treat as ungrouped
    }

    scheduleCollapse(highlightInfo.windowId, activeGroupId);
  } catch (err) {
    console.warn('[TabGrouper] onHighlighted: auto-collapse error:', err.message);
  }
});

/**
 * After a tab is removed or detached, check every group in the affected window
 * and ungroup any group whose tab count has dropped to exactly 1.
 *
 * Why the dissolution threshold is 1 (not minTabThreshold):
 *  A single tab inside a group container is visually misleading and offers no
 *  grouping value. Groups with 2+ tabs are kept even if below the user's
 *  creation threshold — the user may have manually collapsed or reorganised them.
 *
 * Cleanup: also removes the stale domainGroupMap entry so the next grouping
 * pass can recreate the group cleanly if enough tabs accumulate again.
 *
 * @param {number} windowId
 */
async function dissolveUndersizedGroups(windowId) {
  if (!api?.tabGroups?.query || !api?.tabs?.ungroup) return;

  let groups;
  try {
    groups = await api.tabGroups.query({ windowId });
  } catch (err) {
    console.warn('[TabGrouper] Dissolution: could not query groups:', err.message);
    return;
  }
  if (!groups.length) return;

  // Single round-trip: fetch all non-pinned tabs in the window at once
  let allTabs;
  try {
    allTabs = await api.tabs.query({ windowId, pinned: false });
  } catch (err) {
    console.warn('[TabGrouper] Dissolution: could not query tabs:', err.message);
    return;
  }

  for (const group of groups) {
    if (group.id == null) continue;

    const groupTabs = allTabs.filter(t => t.groupId === group.id);

    // Only dissolve groups with exactly 1 remaining tab
    if (groupTabs.length !== 1) continue;

    const [soloTab] = groupTabs;
    if (soloTab.id == null) continue;

    try {
      await api.tabs.ungroup([soloTab.id]);
      console.log(
        `[TabGrouper] Dissolved solo-tab group ${group.id} ("${group.title ?? '?'}") — ` +
        `tab ${soloTab.id} ungrouped.`,
      );

      // Remove the stale domainGroupMap entry so the next pass starts clean
      try {
        const stored = await api.storage.local.get('domainGroupMap');
        const map    = stored.domainGroupMap ?? {};
        for (const [k, v] of Object.entries(map)) {
          if (v === group.id) delete map[k];
        }
        await api.storage.local.set({ domainGroupMap: map });
      } catch {
        // Non-fatal — stale entries are cleaned up on the next grouping pass
      }
    } catch (err) {
      console.warn(`[TabGrouper] Could not ungroup solo tab ${soloTab.id}:`, err.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 12 — Tab Lifecycle Listeners
// ═══════════════════════════════════════════════════════════════════════════════
//
// All listeners registered synchronously at top-level so Chrome replays them
// after a service-worker restart.

api.tabs.onCreated.addListener((tab) => {
  if (tab.url && tab.windowId != null) scheduleGrouping(tab.windowId);
});

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (tab.windowId == null || tab.windowId < 0) return;
  scheduleGrouping(tab.windowId);
});

/**
 * onRemoved — dissolve undersized groups first (immediate cleanup), then
 * schedule the normal grouping pass so new groups can form if needed.
 */
api.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (removeInfo.windowClosing) return;
  if (removeInfo.windowId == null || removeInfo.windowId < 0) return;

  // Dissolution runs in the background — no need to await before scheduling
  dissolveUndersizedGroups(removeInfo.windowId);
  scheduleGrouping(removeInfo.windowId);
});

/**
 * onDetached — dissolve on the old window (tab left), regroup on both ends.
 */
api.tabs.onDetached.addListener((tabId, detachInfo) => {
  if (detachInfo.oldWindowId != null) {
    dissolveUndersizedGroups(detachInfo.oldWindowId);
    scheduleGrouping(detachInfo.oldWindowId);
  }
});

api.tabs.onAttached.addListener((tabId, attachInfo) => {
  if (attachInfo.newWindowId != null) scheduleGrouping(attachInfo.newWindowId);
});

/**
 * Helper: reads autoCollapseInactive from storage.sync, falling back to
 * storage.local when sync is unavailable (e.g. user not signed into Chrome).
 *
 * Reading directly from storage on every activation event avoids relying on
 * settingsCache, which can contain the default value (false) after a SW
 * restart when storage was temporarily unavailable during cache population.
 *
 * @returns {Promise<boolean>}
 */
async function readAutoCollapseSetting() {
  try {
    const r = await api.storage.sync.get({ autoCollapseInactive: false });
    console.log('[TabGrouper] Loaded settings (sync):', r);
    return Boolean(r.autoCollapseInactive);
  } catch {
    // storage.sync unavailable (not signed in, or Firefox without sync)
    try {
      const r = await api.storage.local.get({ autoCollapseInactive: false });
      console.log('[TabGrouper] Loaded settings (local fallback):', r);
      return Boolean(r.autoCollapseInactive);
    } catch {
      console.warn('[TabGrouper] Both storage areas unavailable — auto-collapse disabled.');
      return false; // both stores down — disable to avoid unexpected collapsing
    }
  }
}



// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 13 — Initialization
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * On first install: write default settings to storage.sync so the options
 * page always has something to read. On update: leave existing settings alone.
 *
 * Also runs an initial grouping pass across all open windows.
 */
api.runtime.onInstalled.addListener(async (details) => {
  console.log(`[TabGrouper] ${details.reason}. Initializing...`);

  if (details.reason === 'install') {
    // Only write defaults on a fresh install — never overwrite user settings
    try {
      await saveSettings(DEFAULT_SETTINGS);
      console.log('[TabGrouper] Default settings written to storage.');
    } catch (err) {
      console.error('[TabGrouper] Failed to write default settings:', err);
    }

    // Open the onboarding welcome page so the user sees the first-run banner
    try {
      const optionsUrl = api.runtime.getURL('options/options.html') + '?welcome=true';
      await api.tabs.create({ url: optionsUrl, active: true });
    } catch (err) {
      console.warn('[TabGrouper] Could not open welcome page:', err.message);
    }
  }

  // Run initial grouping pass on all open windows
  try {
    const windows = await api.windows.getAll({ windowTypes: ['normal'] });
    for (const win of windows) {
      if (win.id != null) scheduleGrouping(win.id);
    }
  } catch (err) {
    console.error('[TabGrouper] Failed to run initial grouping pass:', err);
  }
});

console.log('[TabGrouper] v1.2 Service worker started. Listeners registered.');

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 14 — Phase 4: Popup Message Handler (ADDITIVE ONLY)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Handles quick-action messages from popup.js. All existing event listeners and
// core grouping/collapse logic above this point are untouched.

/**
 * SEC: URL scheme allowlist for session restore.
 *
 * Only http: and https: are permitted when opening tabs from a stored stash.
 * Rejects javascript:, data:, file:, blob:, vbscript:, chrome:, about:,
 * moz-extension:, and any other scheme that could execute code or access
 * privileged browser pages.
 *
 * @param {unknown} url
 * @returns {boolean}
 */
function isSafeUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    // URL constructor throws on malformed strings — treat as unsafe
    return false;
  }
}

/**
 * Returns the windowId of the tab that sent a runtime message, falling back to
 * querying the currently focused window if the sender tab isn't available.
 *
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<number|null>}
 */
async function resolveWindowId(sender) {
  if (sender?.tab?.windowId != null) return sender.tab.windowId;
  try {
    const win = await api.windows.getCurrent();
    return win?.id ?? null;
  } catch {
    return null;
  }
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // SEC: validate message structure before any processing.
  // Reject non-object messages, missing action fields, and non-string actions.
  if (!msg || typeof msg !== 'object' || typeof msg.action !== 'string') return false;

  // Explicit allowlist — any action not in this list is silently ignored.
  const handled = [
    'FORCE_GROUP_ALL', 'UNGROUP_ALL', 'TOGGLE_COLLAPSE_ALL',
    'STASH_WINDOW', 'RESTORE_SESSION',
  ];
  if (!handled.includes(msg.action)) return false;

  // Wrap the async work in an IIFE so we can use sendResponse after awaiting.
  (async () => {
    try {
      const windowId = await resolveWindowId(sender);
      if (windowId == null) {
        sendResponse({ ok: false, error: 'Could not determine window ID' });
        return;
      }

      // ── FORCE_GROUP_ALL ──────────────────────────────────────────────────────
      if (msg.action === 'FORCE_GROUP_ALL') {
        // Bypass the debounce — call groupTabsForWindow directly so the popup
        // sees immediate results without waiting for a tab event.
        await groupTabsForWindow(windowId);
        sendResponse({ ok: true });
        return;
      }

      // ── UNGROUP_ALL ──────────────────────────────────────────────────────────
      if (msg.action === 'UNGROUP_ALL') {
        if (!api?.tabs?.ungroup) {
          sendResponse({ ok: false, error: 'tabs.ungroup not available' });
          return;
        }
        const tabs = await api.tabs.query({ windowId, pinned: false });
        const grouped = tabs.filter(t => (t.groupId ?? -1) !== -1).map(t => t.id);
        if (grouped.length > 0) await api.tabs.ungroup(grouped);
        sendResponse({ ok: true });
        return;
      }

      // ── TOGGLE_COLLAPSE_ALL ──────────────────────────────────────────────────
      if (msg.action === 'TOGGLE_COLLAPSE_ALL') {
        if (!api?.tabGroups?.query) {
          sendResponse({ ok: false, error: 'tabGroups API not available' });
          return;
        }
        const groups = await api.tabGroups.query({ windowId });
        if (!groups.length) { sendResponse({ ok: true, collapsed: false }); return; }

        // Collapse all if ANY group is expanded; expand all if ALL are collapsed
        const anyExpanded = groups.some(g => !g.collapsed);
        const targetState = anyExpanded; // true = collapse all, false = expand all

        for (const g of groups) {
          if (g.collapsed === targetState) continue; // already in desired state
          try {
            await api.tabGroups.update(g.id, { collapsed: targetState });
          } catch {
            // Group may have closed between query and update — skip
          }
        }
        sendResponse({ ok: true, collapsed: targetState });
        return;
      }

      // ── STASH_WINDOW ─────────────────────────────────────────────────────────
      if (msg.action === 'STASH_WINDOW') {
        const tabs = await api.tabs.query({ windowId, pinned: false });

        // Build group snapshots (title, color, collapsed, member URLs in order)
        const groupSnapshots = [];
        if (api?.tabGroups?.query) {
          const groups = await api.tabGroups.query({ windowId });
          for (const g of groups) {
            const members = tabs
              .filter(t => t.groupId === g.id)
              .sort((a, b) => a.index - b.index)
              .map(t => t.url || t.pendingUrl || '');
            if (members.length) {
              groupSnapshots.push({
                title:     g.title ?? '',
                color:     g.color ?? 'blue',
                collapsed: g.collapsed ?? false,
                urls:      members,
              });
            }
          }
        }

        // Collect ungrouped tab URLs
        const ungroupedUrls = tabs
          .filter(t => (t.groupId ?? -1) === -1)
          .sort((a, b) => a.index - b.index)
          .map(t => t.url || t.pendingUrl || '')
          .filter(Boolean);

        const stash = {
          savedAt:       Date.now(),
          groups:        groupSnapshots,
          ungroupedUrls,
        };

        await api.storage.local.set({ tabGroupStash: stash });
        sendResponse({ ok: true });
        return;
      }

      // ── RESTORE_SESSION ──────────────────────────────────────────────────────
      if (msg.action === 'RESTORE_SESSION') {
        const { tabGroupStash } = await api.storage.local.get('tabGroupStash');
        if (!tabGroupStash) {
          sendResponse({ ok: false, error: 'No stash found' });
          return;
        }

        // Open grouped tabs and re-group them
        for (const grp of tabGroupStash.groups) {
          if (!Array.isArray(grp.urls) || !grp.urls.length) continue;

          const tabIds = [];
          for (const url of grp.urls) {
            // SEC: reject any URL that isn't plain http / https
            if (!isSafeUrl(url)) {
              console.warn('[TabGrouper] RESTORE_SESSION: blocked unsafe URL scheme:', url);
              continue;
            }
            try {
              const t = await api.tabs.create({ url, active: false });
              tabIds.push(t.id);
            } catch {
              // Bad URL — skip
            }
          }

          if (tabIds.length && api?.tabs?.group) {
            try {
              const groupId = await api.tabs.group({ tabIds });
              if (api?.tabGroups?.update) {
                await api.tabGroups.update(groupId, {
                  title:     grp.title  || undefined,
                  color:     grp.color  || undefined,
                  collapsed: grp.collapsed ?? false,
                });
              }
            } catch {
              // Grouping failed — tabs still opened, just ungrouped
            }
          }
        }

        // Open ungrouped tabs
        for (const url of tabGroupStash.ungroupedUrls) {
          // SEC: reject any URL that isn't plain http / https
          if (!isSafeUrl(url)) {
            console.warn('[TabGrouper] RESTORE_SESSION: blocked unsafe URL scheme:', url);
            continue;
          }
          try {
            await api.tabs.create({ url, active: false });
          } catch {
            // Bad URL — skip
          }
        }

        sendResponse({ ok: true });
        return;
      }
    } catch (err) {
      console.error('[TabGrouper] onMessage handler error:', err);
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // keep the message channel open for the async sendResponse
});

