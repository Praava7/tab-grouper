/**
 * options.js — Tab Grouper Phase 2: Settings Page Logic
 *
 * Responsibilities:
 *  1. On load: read settings from storage (sync → local fallback) and populate UI.
 *  2. On any setting change: validate, auto-save to storage, show status indicator.
 *  3. Domain exclusion manager: add/remove domains with input validation.
 *  4. "Reset to Defaults" flow: show confirmation dialog, apply defaults on confirm.
 *
 * Storage contract:
 *  Settings are read/written to chrome.storage.sync with a fallback to
 *  chrome.storage.local if sync is unavailable. This mirrors the background.js
 *  strategy so both scripts always operate on the same values.
 *
 * Cross-browser:
 *  Uses `globalThis.chrome ?? globalThis.browser` so this file works on both
 *  Chrome and Firefox without modification.
 */

// ─── Cross-browser API ────────────────────────────────────────────────────────

const api = globalThis.chrome ?? globalThis.browser;

// ─── Default Settings (must match background.js) ─────────────────────────────

const DEFAULT_SETTINGS = {
  minTabThreshold:      3,
  autoGroupEnabled:     true,
  autoCollapseInactive: false, // Phase 3: collapse unfocused groups on tab switch
  excludedDomains:      [],    // Empty by default — only user-added domains are excluded
  groupColors:          'auto',
};

// ─── DOM References ───────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const els = {
  autoGroupEnabled:     $('autoGroupEnabled'),
  autoCollapseInactive: $('autoCollapseInactive'),  // Phase 3
  minTabThreshold:      $('minTabThreshold'),
  thresholdValue:       $('thresholdValue'),
  domainInput:          $('domainInput'),
  addDomainBtn:         $('addDomainBtn'),
  domainError:          $('domainError'),
  tagList:              $('tagList'),
  emptyNotice:          $('emptyNotice'),
  saveStatus:           $('saveStatus'),
  saveStatusLabel:      $('saveStatusLabel'),
  resetBtn:             $('resetBtn'),
  resetOverlay:         $('resetOverlay'),
  resetCancelBtn:       $('resetCancelBtn'),
  resetConfirmBtn:      $('resetConfirmBtn'),
  // Phase 5: welcome banner
  welcomeBanner:        $('welcomeBanner'),
  welcomeDismissBtn:    $('welcomeDismissBtn'),
  welcomeScrollBtn:     $('welcomeScrollBtn'),
  generalCard:          $('generalCard'),
};

// ─── State ────────────────────────────────────────────────────────────────────

/**
 * Local working copy of excludedDomains. We keep this as the source of truth
 * in memory so we can add/remove tags without full storage round-trips.
 * It is persisted to storage after every mutation.
 *
 * @type {string[]}
 */
let excludedDomains = [];

/** Save debounce timer ID */
let saveTimer = null;

// ─── Storage Helpers ──────────────────────────────────────────────────────────

/**
 * Reads all settings keys from storage.sync with a storage.local fallback.
 * Returns a merged object with defaults for any missing keys.
 *
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
async function loadSettings() {
  const keys = Object.keys(DEFAULT_SETTINGS);
  let stored = {};

  try {
    stored = await api.storage.sync.get(keys);
  } catch {
    try {
      stored = await api.storage.local.get(keys);
    } catch (err) {
      console.error('[TabGrouper Options] Failed to read settings:', err);
    }
  }

  return { ...DEFAULT_SETTINGS, ...stored };
}

/**
 * Persists a partial settings update to storage.sync (local fallback).
 *
 * @param {Partial<typeof DEFAULT_SETTINGS>} updates
 */
async function persistSettings(updates) {
  try {
    await api.storage.sync.set(updates);
  } catch {
    try {
      await api.storage.local.set(updates);
    } catch (err) {
      console.error('[TabGrouper Options] Failed to save settings:', err);
      throw err; // Re-throw so the caller can show an error state
    }
  }
}

// ─── Save Status Indicator ────────────────────────────────────────────────────

let statusTimer = null;

/**
 * Updates the save-status pill in the header.
 *
 * @param {'saving'|'saved'|'error'} state
 * @param {string} [message]
 */
function setStatus(state, message) {
  const { saveStatus, saveStatusLabel } = els;

  // Clear any existing auto-reset timer
  if (statusTimer) clearTimeout(statusTimer);

  saveStatus.classList.remove('is-saving', 'is-error');

  if (state === 'saving') {
    saveStatus.classList.add('is-saving');
    saveStatusLabel.textContent = 'Saving…';
  } else if (state === 'error') {
    saveStatus.classList.add('is-error');
    saveStatusLabel.textContent = message ?? 'Failed to save';
    // Auto-reset to saved after 4 s
    statusTimer = setTimeout(() => setStatus('saved'), 4000);
  } else {
    // 'saved'
    saveStatusLabel.textContent = 'All changes saved';
    // Flash the pill briefly to confirm
    statusTimer = setTimeout(() => {}, 0); // no-op, just clears timer ref
  }
}

// ─── Auto-save Helper ─────────────────────────────────────────────────────────

/**
 * Debounced save. Waits 300 ms after the last call before persisting.
 * This prevents hitting storage on every keystroke/slider tick.
 *
 * @param {Partial<typeof DEFAULT_SETTINGS>} updates
 */
function scheduleSave(updates) {
  if (saveTimer) clearTimeout(saveTimer);
  setStatus('saving');

  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await persistSettings(updates);
      setStatus('saved');
    } catch {
      setStatus('error', 'Failed to save');
    }
  }, 300);
}

// ─── UI Renderers ─────────────────────────────────────────────────────────────

/**
 * Populates all UI elements from a settings object.
 *
 * @param {typeof DEFAULT_SETTINGS} settings
 */
function renderSettings(settings) {
  // Auto-grouping toggle
  const enabled = Boolean(settings.autoGroupEnabled);
  els.autoGroupEnabled.setAttribute('aria-checked', String(enabled));

  // Auto-collapse toggle (Phase 3)
  const collapse = Boolean(settings.autoCollapseInactive);
  els.autoCollapseInactive.setAttribute('aria-checked', String(collapse));

  // Slider
  const threshold = Number(settings.minTabThreshold);
  els.minTabThreshold.value = threshold;
  updateSliderDisplay(threshold);

  // Domain tags
  excludedDomains = Array.isArray(settings.excludedDomains)
    ? [...settings.excludedDomains]
    : [];
  renderTagList();
}

/**
 * Updates the slider's visual fill and value readout.
 *
 * @param {number} value
 */
function updateSliderDisplay(value) {
  const min = Number(els.minTabThreshold.min);
  const max = Number(els.minTabThreshold.max);
  const pct  = ((value - min) / (max - min)) * 100;

  // Drive the CSS gradient via custom property
  els.minTabThreshold.style.setProperty('--slider-fill', `${pct}%`);
  els.thresholdValue.textContent = `${value} tab${value === 1 ? '' : 's'}`;
  els.minTabThreshold.setAttribute('aria-valuenow', value);
}

/**
 * Re-renders the excluded domains tag list from the `excludedDomains` array.
 */
function renderTagList() {
  const { tagList, emptyNotice } = els;
  tagList.innerHTML = '';

  if (excludedDomains.length === 0) {
    emptyNotice.hidden = false;
    return;
  }

  emptyNotice.hidden = true;

  for (const domain of excludedDomains) {
    tagList.appendChild(createTag(domain));
  }
}

/**
 * Creates a single domain tag <li> element.
 *
 * @param {string} domain
 * @returns {HTMLLIElement}
 */
function createTag(domain) {
  const li = document.createElement('li');
  li.className = 'tag';
  li.dataset.domain = domain;

  const span = document.createElement('span');
  span.className = 'tag__text';
  span.textContent = domain;
  span.title = domain; // Full domain on hover for long values

  const removeBtn = document.createElement('button');
  removeBtn.className = 'tag__remove';
  removeBtn.type = 'button';
  removeBtn.setAttribute('aria-label', `Remove ${domain} from exclusions`);
  removeBtn.innerHTML = '&times;';

  removeBtn.addEventListener('click', () => removeDomain(domain, li));

  li.appendChild(span);
  li.appendChild(removeBtn);
  return li;
}

/**
 * Strips noise from raw user input so that pasting a full URL,
 * a mobile URL (m.example.com), or accidentally typing "www." all
 * resolve to the clean, canonical hostname we actually want to store.
 *
 * Transformations applied in order:
 *  1. Trim surrounding whitespace
 *  2. Lowercase
 *  3. Strip protocol  (https://, http://, ftp://, …)
 *  4. Strip path, query string, and fragment  (/path?q=1#anchor)
 *  5. Strip port  (:8080)
 *  6. Strip leading "www."  (www.example.com → example.com)
 *  7. Strip leading "m."    (m.reddit.com    → reddit.com)
 *
 * Examples:
 *   "https://www.Reddit.com/r/programming" → "reddit.com"
 *   "  MAIL.GOOGLE.COM  "                  → "mail.google.com"
 *   "http://m.youtube.com/watch?v=abc"     → "youtube.com"
 *   "slack.com"                            → "slack.com"
 *
 * @param {string} raw
 * @returns {string}
 */
function sanitizeDomainInput(raw) {
  let s = raw.trim().toLowerCase();

  // Strip protocol (everything up to and including "://")
  s = s.replace(/^[a-z][a-z0-9+\-.]*:\/\//, '');

  // Strip path, query, and fragment — take only the host[:port] part
  s = s.split('/')[0].split('?')[0].split('#')[0];

  // Strip port number
  s = s.replace(/:\d+$/, '');

  // Strip generic web prefixes that carry no grouping identity
  if (s.startsWith('www.')) s = s.slice(4);
  if (s.startsWith('m.'))   s = s.slice(2);

  return s;
}

/**
 * Sanitizes then validates a domain string for the exclusion list.
 * Returns the clean, canonical domain on success; returns null and
 * shows an inline error on failure.
 *
 * @param {string} raw  Raw text from the input field.
 * @returns {string|null}
 */
function validateDomain(raw) {
  // Sanitize first — this way pasting a URL is a friendly non-error
  const domain = sanitizeDomainInput(raw);

  if (!domain) {
    showFieldError('Please enter a domain name.');
    return null;
  }

  // Basic hostname regex: a-z, 0-9, hyphens, dots — no spaces or special chars
  if (!/^[a-z0-9]([a-z0-9\-\.]*[a-z0-9])?$/.test(domain)) {
    showFieldError('Invalid domain. Use letters, numbers, hyphens, and dots only.');
    return null;
  }

  // Must contain at least one dot (reject bare labels like "localhost")
  if (!domain.includes('.')) {
    showFieldError('Enter a full domain with a TLD (e.g. example.com).');
    return null;
  }

  // Duplicate check
  if (excludedDomains.includes(domain)) {
    showFieldError(`"${domain}" is already in your exclusion list.`);
    return null;
  }

  // Reflect the sanitized value back into the input so the user can see
  // exactly what will be stored (e.g. after pasting a full URL)
  els.domainInput.value = domain;

  clearFieldError();
  return domain;
}

function showFieldError(message) {
  els.domainError.textContent = message;
  els.domainError.hidden = false;
  els.domainInput.classList.add('has-error');
  els.domainInput.setAttribute('aria-invalid', 'true');
}

function clearFieldError() {
  els.domainError.textContent = '';
  els.domainError.hidden = true;
  els.domainInput.classList.remove('has-error');
  els.domainInput.removeAttribute('aria-invalid');
}

// ─── Domain Add / Remove Actions ──────────────────────────────────────────────

/**
 * Adds a new domain to the exclusion list after validation.
 */
function addDomain() {
  const domain = validateDomain(els.domainInput.value);
  if (!domain) return;

  excludedDomains.push(domain);
  els.tagList.appendChild(createTag(domain));
  els.emptyNotice.hidden = true;

  // Clear input and focus it for quick consecutive adds
  els.domainInput.value = '';
  els.domainInput.focus();

  scheduleSave({ excludedDomains: [...excludedDomains] });
}

/**
 * Removes a domain from the exclusion list with an exit animation.
 *
 * @param {string} domain
 * @param {HTMLLIElement} tagEl
 */
function removeDomain(domain, tagEl) {
  excludedDomains = excludedDomains.filter(d => d !== domain);

  // Animate out, then remove from DOM
  tagEl.classList.add('is-removing');
  tagEl.addEventListener('animationend', () => {
    tagEl.remove();
    if (excludedDomains.length === 0) els.emptyNotice.hidden = false;
  }, { once: true });

  scheduleSave({ excludedDomains: [...excludedDomains] });
}

// ─── Reset to Defaults ────────────────────────────────────────────────────────

function openResetDialog() {
  els.resetOverlay.hidden = false;
  els.resetConfirmBtn.focus();
}

function closeResetDialog() {
  els.resetOverlay.hidden = true;
  els.resetBtn.focus();
}

async function applyDefaults() {
  closeResetDialog();
  renderSettings(DEFAULT_SETTINGS);

  setStatus('saving');
  try {
    await persistSettings(DEFAULT_SETTINGS);
    setStatus('saved');
  } catch {
    setStatus('error', 'Failed to reset');
  }
}

// ─── Event Wiring ─────────────────────────────────────────────────────────────

function attachEventListeners() {

  // ── Toggle: auto-grouping ──────────────────────────────────────────────────
  els.autoGroupEnabled.addEventListener('click', () => {
    const current = els.autoGroupEnabled.getAttribute('aria-checked') === 'true';
    const next = !current;
    els.autoGroupEnabled.setAttribute('aria-checked', String(next));
    scheduleSave({ autoGroupEnabled: next });
  });

  // Allow keyboard activation of the toggle (Space / Enter)
  els.autoGroupEnabled.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      els.autoGroupEnabled.click();
    }
  });

  // ── Toggle: auto-collapse inactive groups (Phase 3) ───────────────────────
  els.autoCollapseInactive.addEventListener('click', () => {
    const current = els.autoCollapseInactive.getAttribute('aria-checked') === 'true';
    const next = !current;
    els.autoCollapseInactive.setAttribute('aria-checked', String(next));
    scheduleSave({ autoCollapseInactive: next });
  });

  els.autoCollapseInactive.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      els.autoCollapseInactive.click();
    }
  });

  // ── Slider: min tab threshold ──────────────────────────────────────────────
  els.minTabThreshold.addEventListener('input', () => {
    const value = Number(els.minTabThreshold.value);
    updateSliderDisplay(value);
    scheduleSave({ minTabThreshold: value });
  });

  // ── Domain input: add on Enter key ────────────────────────────────────────
  els.domainInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addDomain();
    }
    // Clear error as user types
    if (els.domainInput.classList.contains('has-error')) {
      clearFieldError();
    }
  });

  els.domainInput.addEventListener('input', () => {
    if (els.domainInput.classList.contains('has-error')) {
      clearFieldError();
    }
  });

  // ── Add domain button ──────────────────────────────────────────────────────
  els.addDomainBtn.addEventListener('click', addDomain);

  // ── Reset button / dialog ─────────────────────────────────────────────────
  els.resetBtn.addEventListener('click', openResetDialog);
  els.resetCancelBtn.addEventListener('click', closeResetDialog);
  els.resetConfirmBtn.addEventListener('click', applyDefaults);

  // Close dialog on overlay backdrop click
  els.resetOverlay.addEventListener('click', (e) => {
    if (e.target === els.resetOverlay) closeResetDialog();
  });

  // Close dialog on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.resetOverlay.hidden) closeResetDialog();
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

/**
 * Entry point — loads settings then renders the UI.
 */
async function init() {
  try {
    const settings = await loadSettings();
    renderSettings(settings);
    setStatus('saved');
  } catch (err) {
    console.error('[TabGrouper Options] Failed to initialize:', err);
    // Render with defaults so the page is still functional
    renderSettings(DEFAULT_SETTINGS);
    setStatus('error', 'Could not load settings');
  }

  attachEventListeners();
}

// Run when the DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// ─── Phase 5: First-Run Onboarding Banner ────────────────────────────────────

/**
 * Shows the welcome banner when the page is opened with ?welcome=true.
 * The banner is hidden in HTML by default (`hidden` attribute) so users who
 * open Options normally never see it.
 *
 * "Got It" — hides the banner and cleans the URL with history.replaceState
 *            so reloading the page won't re-show the banner.
 * "Explore Settings" — smooth-scrolls to the General Settings card.
 */
function initWelcomeBanner() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('welcome') !== 'true') return;

  // Show the banner
  if (els.welcomeBanner) els.welcomeBanner.hidden = false;

  // "Got It" — dismiss and clean the URL
  if (els.welcomeDismissBtn) {
    els.welcomeDismissBtn.addEventListener('click', () => {
      if (els.welcomeBanner) {
        els.welcomeBanner.hidden = true;
      }
      // Remove ?welcome=true from the address bar without a page reload
      window.history.replaceState({}, document.title, window.location.pathname);
    });
  }

  // "Explore Settings" — smooth scroll to the General card
  if (els.welcomeScrollBtn) {
    els.welcomeScrollBtn.addEventListener('click', () => {
      const target = els.generalCard ?? document.querySelector('.card');
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Move focus into the card for keyboard users
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
    });
  }
}

// Initialise banner after DOM is ready (same timing gate as init())
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initWelcomeBanner);
} else {
  initWelcomeBanner();
}
