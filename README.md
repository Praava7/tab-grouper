# Tab Grouper — Phase 1: Core Auto-Grouping Engine

Automatically groups open browser tabs by their root domain when 3 or more tabs from the same site are open.

---

## Features (Phase 1)

- ✅ Monitors tab lifecycle events (`created`, `updated`, `removed`, `detached`, `attached`)
- ✅ Extracts root domain from any URL (strips `www.`, handles subdomains)
- ✅ Skips internal pages (`chrome://`, `about:`, `edge://`, etc.)
- ✅ Skips pinned tabs
- ✅ Groups 3+ tabs from the same domain automatically
- ✅ Adds new same-domain tabs to existing groups automatically
- ✅ Assigns display-friendly group titles (e.g., "YouTube", "GitHub")
- ✅ Cycles through 8 group colors (`blue`, `red`, `yellow`, `green`, `pink`, `purple`, `cyan`, `orange`)
- ✅ Debounced processing to handle rapid tab openings without race conditions
- ✅ Persists group state across service-worker restarts via `chrome.storage.local`
- ✅ Runs an initial grouping pass on install / update

---

## Project Structure

```
Tab_grouper/
├── manifest.json      # Manifest V3 configuration
├── background.js      # Service worker — core auto-grouping engine
├── icons/
│   ├── icon-16.png    # 16x16 toolbar icon
│   ├── icon-48.png    # 48x48 extension management icon
│   └── icon-128.png   # 128x128 Chrome Web Store icon
└── README.md
```

---

## Installation (Development)

### Chrome / Chromium
1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this project folder

### Microsoft Edge
1. Open `edge://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this project folder

### Firefox (partial support)
> **Note:** Firefox's MV3 implementation does not yet support the `tabGroups` API. The extension will load without errors, but auto-grouping will be silently skipped until Firefox ships support.

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select `manifest.json`

---

## Configuration

| Constant               | Location             | Default  | Description                                       |
|------------------------|----------------------|----------|---------------------------------------------------|
| `MIN_TABS_TO_GROUP`    | `background.js:15`   | `3`      | Minimum tabs from same domain to form a group     |
| `GROUP_COLORS`         | `background.js:21`   | 8 colors | Color rotation order for new groups               |
| `IGNORED_SCHEMES`      | `background.js:28`   | —        | URL schemes that are never grouped                |
| `DOMAIN_DISPLAY_NAMES` | `background.js:~100` | Map      | Human-friendly titles for popular domains         |

All constants are clearly marked with comments in `background.js` — no build step needed to change them.

---

## Architecture Notes

### Race Condition Handling
Tab events fire in rapid bursts (create → loading → complete). A **150 ms debounce per window** (`pendingWindows` Set + `setTimeout`) collapses burst events into a single grouping pass. The debounce window is shorter than any service-worker restart cycle, so the in-memory Set is sufficient.

### Service Worker Ephemeralness
Chrome terminates extension service workers after ~30 seconds of inactivity. All persistent state (color rotation index, domain→groupId mapping) is stored in `chrome.storage.local`. Every event handler reads from storage rather than relying on global variables.

### Idempotency
The grouping algorithm is idempotent — running it multiple times on the same window state produces the same result. This means edge cases (SW restart mid-pass, double-fire) are safe.

---

## Roadmap

| Phase | Feature |
|-------|---------|
| **Phase 1** (done) | Core auto-grouping engine |
| Phase 2 | Settings popup (configurable threshold, enable/disable per domain) |
| Phase 3 | Manual group management UI (rename, recolor, ungroup) |
| Phase 4 | Session persistence (save/restore groups across browser restarts) |
| Phase 5 | Firefox full compatibility as MV3 tabGroups support matures |
