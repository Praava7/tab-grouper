#!/usr/bin/env node
/**
 * package-zip.js — Tab Grouper release packager
 *
 * 1. Reads the version from package.json.
 * 2. Packages dist/chrome/ → release/tab-grouper-chrome-v{version}.zip
 * 3. Packages dist/firefox/ → release/tab-grouper-firefox-v{version}.zip
 * 4. Excludes OS artifacts: .DS_Store, Thumbs.db, desktop.ini
 *
 * Zero external dependencies — uses only Node.js built-ins (zlib + fs streams).
 * Requires Node.js 18+ for the stable fs/promises + stream/promises APIs.
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const zlib    = require('zlib');
const { pipeline } = require('stream/promises');

// ─── Config ───────────────────────────────────────────────────────────────────

const ROOT     = __dirname;
const DIST     = path.join(ROOT, 'dist');
const RELEASE  = path.join(ROOT, 'release');
const PKG      = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION  = PKG.version;

const EXCLUDE  = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.gitkeep']);

const ANSI = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m',
};
const ok    = (m) => console.log(`${ANSI.green}✔${ANSI.reset} ${m}`);
const info  = (m) => console.log(`${ANSI.cyan}ℹ${ANSI.reset} ${m}`);
const err   = (m) => console.error(`${ANSI.red}✖${ANSI.reset} ${m}`);

// ─── Minimal ZIP writer ───────────────────────────────────────────────────────
// We implement a minimal ZIP64-safe writer so we have zero npm dependencies.

function uint16LE(n)  { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function uint32LE(n)  { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })());
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Walks a directory recursively and returns { arcName, fullPath }[] for all
 * non-excluded files.
 */
function collectFiles(dir, baseDir = dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, baseDir));
    } else {
      // Use forward slashes for ZIP archive names (spec requirement)
      const arcName = path.relative(baseDir, full).split(path.sep).join('/');
      results.push({ arcName, fullPath: full });
    }
  }
  return results;
}

/**
 * Builds a ZIP file in memory and writes it to `outPath`.
 * Uses DEFLATE compression (method 8) for all entries.
 */
async function createZip(srcDir, outPath) {
  const files   = collectFiles(srcDir);
  const entries = []; // central directory records

  // We collect everything into a single Buffer via an array of chunks.
  const chunks  = [];
  let   offset  = 0;

  for (const { arcName, fullPath } of files) {
    const raw        = fs.readFileSync(fullPath);
    const compressed = zlib.deflateRawSync(raw, { level: 9 });
    const crc        = crc32(raw);
    const nameBytes  = Buffer.from(arcName, 'utf8');

    // Local file header
    const localHeader = Buffer.concat([
      Buffer.from([0x50, 0x4B, 0x03, 0x04]), // signature
      uint16LE(20),            // version needed: 2.0
      uint16LE(0x0800),        // flags: UTF-8
      uint16LE(8),             // compression: DEFLATE
      uint16LE(0), uint16LE(0),// last mod time/date (zeroed for reproducibility)
      uint32LE(crc),
      uint32LE(compressed.length),
      uint32LE(raw.length),
      uint16LE(nameBytes.length),
      uint16LE(0),             // extra field length
      nameBytes,
    ]);

    entries.push({
      arcName, nameBytes, crc,
      compressedSize: compressed.length,
      uncompressedSize: raw.length,
      localHeaderOffset: offset,
    });

    chunks.push(localHeader, compressed);
    offset += localHeader.length + compressed.length;
  }

  // Central directory
  const cdOffset = offset;
  for (const e of entries) {
    const cdEntry = Buffer.concat([
      Buffer.from([0x50, 0x4B, 0x01, 0x02]), // signature
      uint16LE(20),  uint16LE(20),            // version made/needed
      uint16LE(0x0800),                       // flags: UTF-8
      uint16LE(8),                            // DEFLATE
      uint16LE(0), uint16LE(0),               // last mod time/date
      uint32LE(e.crc),
      uint32LE(e.compressedSize),
      uint32LE(e.uncompressedSize),
      uint16LE(e.nameBytes.length),
      uint16LE(0), uint16LE(0),               // extra, comment
      uint16LE(0), uint16LE(0),               // disk number start, int attrs
      uint32LE(0),                            // ext attrs
      uint32LE(e.localHeaderOffset),
      e.nameBytes,
    ]);
    chunks.push(cdEntry);
    offset += cdEntry.length;
  }

  const cdSize = offset - cdOffset;

  // End of central directory record
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4B, 0x05, 0x06]), // signature
    uint16LE(0), uint16LE(0),              // disk numbers
    uint16LE(entries.length), uint16LE(entries.length),
    uint32LE(cdSize),
    uint32LE(cdOffset),
    uint16LE(0),                           // comment length
  ]);
  chunks.push(eocd);

  fs.writeFileSync(outPath, Buffer.concat(chunks));
}

// ─── Entry point ─────────────────────────────────────────────────────────────

(async () => {
  console.log(`\n${ANSI.bold}Tab Grouper — Release Packager v${VERSION}${ANSI.reset}`);
  console.log(`${ANSI.dim}${'─'.repeat(52)}${ANSI.reset}\n`);

  fs.mkdirSync(RELEASE, { recursive: true });

  for (const target of ['chrome', 'firefox']) {
    const srcDir  = path.join(DIST, target);
    const zipName = `tab-grouper-${target}-v${VERSION}.zip`;
    const zipPath = path.join(RELEASE, zipName);

    if (!fs.existsSync(srcDir)) {
      err(`dist/${target}/ not found — run npm run build first`);
      process.exit(1);
    }

    info(`Packaging dist/${target}/ → release/${zipName}`);
    await createZip(srcDir, zipPath);
    const size = (fs.statSync(zipPath).size / 1024).toFixed(1);
    ok(`${zipName}  (${size} kB)`);
  }

  console.log(`\n${ANSI.green}${ANSI.bold}All packages ready in release/${ANSI.reset}\n`);
})();
