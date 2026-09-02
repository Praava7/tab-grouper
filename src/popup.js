/**
 * popup.js — Tab Grouper Phase 4: Toolbar Popup UI
 *
 * Responsibilities:
 *  - Populate live counters (tabs, groups, ungrouped) for the current window.
 *  - Wire quick-action buttons to background via chrome.runtime.sendMessage.
 *  - Handle session stash: save/restore window snapshot via chrome.storage.local.
 *  - Open the options page when the settings gear icon is clicked.
 *
 * All browser API calls use the cross-browser shim so the popup works in both
 * Chrome (chrome namespace) and Firefox (browser namespace with chrome alias).
 */

'use strict';

const api = globalThis.chrome ?? globalThis.browser;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const els = {
  tabCount:       $('tabCount'),
  groupCount:     $('groupCount'),
  ungroupedCount: $('ungroupedCount'),
  btnGroupAll:    $('btnGroupAll'),
  btnUngroupAll:  $('btnUngroupAll'),
  btnCollapseAll: $('btnCollapseAll'),
  collapseLabel:  $('collapseLabel'),
  btnStash:       $('btnStash'),
  btnRestore:     $('btnRestore'),
  stashBadge:     $('stashBadge'),
  stashMeta:      $('stashMeta'),
  settingsLink:   $('settingsLink'),
  toast:          $('toast'),
};

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer = null;

function showToast(msg, durationMs = 2200) {
  if (toastTimer) clearTimeout(toastTimer);
  els.toast.textContent = msg;
  els.toast.classList.add('is-visible');
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('is-visible');
    toastTimer = null;
  }, durationMs);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sends a message to the background service worker and returns the response.
 * Errors are caught and surfaced as a toast so the popup never silently fails.
 *
 * @param {object} msg
 * @returns {Promise<any>}
 */
async function sendAction(msg) {
  try {
    return await api.runtime.sendMessage(msg);
  } catch (err) {
    console.error('[TabGrouper Popup] sendAction error:', err);
    showToast('⚠ Action failed — reload extension', 3500);
    return null;
  }
}

/**
 * Disables all action buttons while a background action is in progress, then
 * re-enables them and refreshes the counters once the action completes.
 *
 * @param {() => Promise<void>} fn
 */
async function withLoading(fn) {
  const buttons = [
    els.btnGroupAll, els.btnUngroupAll,
    els.btnCollapseAll, els.btnStash, els.btnRestore,
  ];
  buttons.forEach(b => { b.disabled = true; });
  try {
    await fn();
  } finally {
    buttons.forEach(b => { b.disabled = false; });
    // btnRestore stays disabled unless a stash exists
    await refreshStashState();
    await refreshCounters();
  }
}

// ─── Counters ─────────────────────────────────────────────────────────────────

/**
 * Queries the current window's tabs and groups, then updates the three
 * stat-card values.
 */
async function refreshCounters() {
  try {
    const win = await api.windows.getCurrent({ populate: true });
    if (!win?.tabs) return;

    const allTabs = win.tabs.filter(t => !t.pinned);
    const total   = allTabs.length;

    let groupCount    = 0;
    let ungroupedCount = 0;

    if (api?.tabGroups?.query) {
      const groups = await api.tabGroups.query({ windowId: win.id });
      groupCount = groups.length;
      ungroupedCount = allTabs.filter(t => (t.groupId ?? -1) === -1).length;
    } else {
      // Firefox < 139 fallback: no tabGroups API
      ungroupedCount = total;
    }

    els.tabCount.textContent       = total;
    els.groupCount.textContent     = groupCount;
    els.ungroupedCount.textContent = ungroupedCount;

    // Flip the Collapse/Expand label based on whether any group is expanded
    if (api?.tabGroups?.query && groupCount > 0) {
      const groups = await api.tabGroups.query({ windowId: win.id });
      const anyExpanded = groups.some(g => !g.collapsed);
      els.collapseLabel.textContent = anyExpanded ? 'Collapse All' : 'Expand All';
    }
  } catch (err) {
    console.warn('[TabGrouper Popup] refreshCounters error:', err);
  }
}

// ─── Stash State ──────────────────────────────────────────────────────────────

async function refreshStashState() {
  try {
    const { tabGroupStash } = await api.storage.local.get('tabGroupStash');
    if (tabGroupStash) {
      els.stashBadge.hidden = false;
      els.btnRestore.disabled = false;
      const ts = new Date(tabGroupStash.savedAt);
      els.stashMeta.textContent =
        `${tabGroupStash.groups.length} group(s), ${tabGroupStash.ungroupedUrls.length} ungrouped tab(s) — saved ${ts.toLocaleTimeString()}`;
      els.stashMeta.hidden = false;
    } else {
      els.stashBadge.hidden   = true;
      els.btnRestore.disabled = true;
      els.stashMeta.hidden    = true;
    }
  } catch (err) {
    console.warn('[TabGrouper Popup] refreshStashState error:', err);
  }
}

// ─── Event Wiring ─────────────────────────────────────────────────────────────

// Settings gear → open options page
els.settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  api.runtime.openOptionsPage();
});

// Group All Tabs
els.btnGroupAll.addEventListener('click', () => {
  withLoading(async () => {
    const resp = await sendAction({ action: 'FORCE_GROUP_ALL' });
    if (resp?.ok) showToast('✓ Tabs grouped');
    else if (resp)  showToast('✓ Grouping triggered');
  });
});

// Ungroup All
els.btnUngroupAll.addEventListener('click', () => {
  withLoading(async () => {
    const resp = await sendAction({ action: 'UNGROUP_ALL' });
    if (resp?.ok) showToast('✓ All tabs ungrouped');
  });
});

// Collapse / Expand All (toggle)
els.btnCollapseAll.addEventListener('click', () => {
  withLoading(async () => {
    const resp = await sendAction({ action: 'TOGGLE_COLLAPSE_ALL' });
    if (resp?.ok) {
      showToast(resp.collapsed ? '✓ All groups collapsed' : '✓ All groups expanded');
    }
  });
});

// Stash Window
els.btnStash.addEventListener('click', () => {
  withLoading(async () => {
    const resp = await sendAction({ action: 'STASH_WINDOW' });
    if (resp?.ok) showToast('✓ Session stashed');
  });
});

// Restore Session
els.btnRestore.addEventListener('click', () => {
  withLoading(async () => {
    const resp = await sendAction({ action: 'RESTORE_SESSION' });
    if (resp?.ok) showToast('✓ Session restored');
    else if (resp?.error) showToast(`⚠ ${resp.error}`, 3000);
  });
});

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await Promise.all([refreshCounters(), refreshStashState()]);
}

document.addEventListener('DOMContentLoaded', init);
