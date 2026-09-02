#!/usr/bin/env node
/**
 * build.js — Tab Grouper multi-target build script
 *
 * Usage:
 *   node build.js chrome    → outputs to dist/chrome/
 *   node build.js firefox   → outputs to dist/firefox/
 *   node build.js           → builds both targets sequentially
 *
 * Zero external dependencies — uses only Node.js built-ins.
 * Requires Node.js 16.7+ (for fs.cpSync).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Paths ────────────────────────────────────────────────────────────────────

const ROOT = __dirname;
const SRC  = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const TARGETS = {
  chrome: {
    manifest: 'manifest.chrome.json',
    outDir:   path.join(DIST, 'chrome'),
  },
  firefox: {
    manifest: 'manifest.firefox.json',
    outDir:   path.join(DIST, 'firefox'),
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ANSI = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  red:    '\x1b[31m',
};

function log(symbol, color, msg) {
  console.log(`${color}${symbol}${ANSI.reset} ${msg}`);
}

const info  = (msg) => log('ℹ', ANSI.cyan,   msg);
const ok    = (msg) => log('✔', ANSI.green,  msg);
const warn  = (msg) => log('⚠', ANSI.yellow, msg);
const error = (msg) => log('✖', ANSI.red,    msg);

function hr() {
  console.log(ANSI.dim + '─'.repeat(52) + ANSI.reset);
}

/**
 * Recursively copies a directory, skipping files whose names match
 * the optional `excludeRegex`. Mirrors the source tree into `dest`.
 *
 * @param {string} src
 * @param {string} dest
 * @param {RegExp|null} excludeRegex  - filenames (not paths) to skip
 */
function copyDir(src, dest, excludeRegex = null) {
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (excludeRegex && excludeRegex.test(entry.name)) continue;

    const srcPath  = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, excludeRegex);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ─── Build Function ───────────────────────────────────────────────────────────

/**
 * Builds a single target.
 *
 * @param {'chrome'|'firefox'} target
 */
function build(target) {
  const cfg = TARGETS[target];
  if (!cfg) {
    error(`Unknown target "${target}". Valid targets: chrome, firefox`);
    process.exit(1);
  }

  const { manifest, outDir } = cfg;
  const manifestSrc = path.join(SRC, manifest);

  hr();
  console.log(`\n${ANSI.bold}Building → ${target.toUpperCase()}${ANSI.reset}`);

  // 1. Validate that the target manifest exists
  if (!fs.existsSync(manifestSrc)) {
    error(`Missing manifest: src/${manifest}`);
    process.exit(1);
  }

  // 2. Clean previous output directory
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
    info(`Cleaned   dist/${target}/`);
  }

  fs.mkdirSync(outDir, { recursive: true });

  // 3. Copy all src/ files EXCEPT the manifest template files
  //    (manifest.chrome.json and manifest.firefox.json are build-time only)
  const manifestPattern = /^manifest\.(chrome|firefox)\.json$/;
  copyDir(SRC, outDir, manifestPattern);
  info(`Copied    src/ → dist/${target}/`);

  // 4. Copy the target-specific manifest as "manifest.json"
  fs.copyFileSync(manifestSrc, path.join(outDir, 'manifest.json'));
  ok(`Manifest  src/${manifest} → dist/${target}/manifest.json`);

  // 5. Emit a summary of what landed in dist/
  const files = [];
  (function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      } else {
        files.push(`${prefix}${entry.name}`);
      }
    }
  })(outDir);

  console.log(`\n${ANSI.dim}  dist/${target}/${ANSI.reset}`);
  for (const f of files) {
    const size = fs.statSync(path.join(outDir, f)).size;
    const kb   = (size / 1024).toFixed(1).padStart(6);
    console.log(`  ${ANSI.dim}${kb} kB${ANSI.reset}  ${f}`);
  }

  console.log(`\n${ANSI.green}${ANSI.bold}✔ ${target} build complete${ANSI.reset}\n`);
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const targets = args.length > 0 ? args : ['chrome', 'firefox'];

// Validate all requested targets up-front before doing any work
for (const t of targets) {
  if (!TARGETS[t]) {
    error(`Unknown target "${t}". Valid targets: chrome, firefox`);
    process.exit(1);
  }
}

console.log(`\n${ANSI.bold}Tab Grouper — Build System${ANSI.reset}`);
console.log(`${ANSI.dim}Targets: ${targets.join(', ')}${ANSI.reset}`);

for (const t of targets) {
  build(t);
}

hr();
console.log(`\n${ANSI.green}${ANSI.bold}All builds finished.${ANSI.reset}`);
console.log(`${ANSI.dim}Load unpacked:${ANSI.reset}`);
if (targets.includes('chrome')) {
  console.log(`  Chrome   →  chrome://extensions  →  Load unpacked  →  dist/chrome/`);
}
if (targets.includes('firefox')) {
  console.log(`  Firefox  →  about:debugging       →  Load Temp Add-on  →  dist/firefox/manifest.json`);
}
console.log();
