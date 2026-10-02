// JSON-on-disk storage under DATA_DIR. Same approach as hfl-draft: one
// process, plain files, atomic writes, a .bak beside every file, and gzip for
// the large archives. On Railway DATA_DIR must be a mounted volume (/data) or
// everything resets on redeploy.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Priority: DATA_DIR env var → a writable /data volume (auto-detected) → ./data
function resolveDataDir(env = process.env, appDir = path.join(__dirname, '..')) {
  if (env.DATA_DIR) return path.resolve(env.DATA_DIR);
  try {
    if (fs.existsSync('/data')) {
      fs.accessSync('/data', fs.constants.W_OK);
      return '/data';
    }
  } catch { /* /data not writable — fall through */ }
  return path.join(appDir, 'data');
}

// Write via temp file + rename so a crash mid-write never leaves a half-written
// file; the previous good copy is kept as .bak.
function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); } catch { /* best effort */ }
  fs.renameSync(tmp, file);
}

function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const abs = rel => {
    const p = path.resolve(dir, rel);
    // Every caller passes a relative path built from ids we generated, but an
    // id that came from a URL must never walk out of the data directory.
    if (p !== dir && !p.startsWith(dir + path.sep)) throw new Error(`path escapes data dir: ${rel}`);
    return p;
  };

  function readJSON(rel, fallback = null) {
    for (const f of [abs(rel), abs(rel) + '.bak']) {
      try {
        if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch (e) {
        console.warn(`[store] could not parse ${f}: ${e.message}`);
      }
    }
    return fallback;
  }

  function writeJSON(rel, obj) {
    writeFileAtomic(abs(rel), JSON.stringify(obj, null, 1));
  }

  function writeGz(rel, obj) {
    writeFileAtomic(abs(rel), zlib.gzipSync(Buffer.from(JSON.stringify(obj))));
  }

  function readGz(rel, fallback = null) {
    try {
      const f = abs(rel);
      if (!fs.existsSync(f)) return fallback;
      return JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
    } catch (e) {
      console.warn(`[store] could not read ${rel}: ${e.message}`);
      return fallback;
    }
  }

  function writeBuffer(rel, buf) { writeFileAtomic(abs(rel), buf); }

  function list(relDir) {
    try { return fs.readdirSync(abs(relDir)).sort(); } catch { return []; }
  }

  function exists(rel) { return fs.existsSync(abs(rel)); }

  function remove(rel) {
    fs.rmSync(abs(rel), { recursive: true, force: true });
  }

  function ensureDir(rel) {
    const p = abs(rel);
    fs.mkdirSync(p, { recursive: true });
    return p;
  }

  // Keep only the newest `keep` entries of a directory (names sort by time).
  function prune(relDir, keep) {
    const names = list(relDir);
    for (const n of names.slice(0, Math.max(0, names.length - keep))) remove(path.join(relDir, n));
  }

  return { dir, path: abs, readJSON, writeJSON, writeGz, readGz, writeBuffer, list, exists, remove, ensureDir, prune };
}

module.exports = { resolveDataDir, writeFileAtomic, createStore };
