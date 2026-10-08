'use strict';

// Baselines on disk: one JSON file per file under review, written by the Claude
// Code hook and read here. Format (v0.2 files lack the optional fields):
//   { path, existed, content, createdAt, version?, tool?, sessionId? }

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * @typedef {{
 *   path: string, existed: boolean, content: string, createdAt: number,
 *   version?: number, tool?: string, sessionId?: string,
 *   jsonPath: string, key: string
 * }} Entry
 */

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function baselineDir() {
  return process.env.CLAUDE_REVIEW_DIR || path.join(os.homedir(), '.claude', 'review', 'baselines');
}

/** Must match the hook: base64url of the path, or a hash when that would be too long a filename. */
function fileNameFor(absPath) {
  const b64 = Buffer.from(absPath).toString('base64url');
  return (b64.length <= 200 ? b64 : 'h-' + crypto.createHash('sha256').update(absPath).digest('hex')) + '.json';
}

const realCache = new Map();

/** Resolves symlinks so a file reached through two paths is one review. */
function realPath(p) {
  const cached = realCache.get(p);
  if (cached) return cached;
  let real = p;
  try {
    real = fs.realpathSync.native(p);
  } catch {
    try {
      real = path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p));
    } catch {
      /* neither exists */
    }
  }
  if (realCache.size > 5000) realCache.clear();
  realCache.set(p, real);
  return real;
}

/** Identity of a file path. */
function keyOf(p) {
  const k = path.normalize(realPath(p));
  return CASE_INSENSITIVE ? k.toLowerCase() : k;
}

function forgetPath(p) {
  realCache.delete(p);
}

/**
 * Reads every baseline. If two baselines resolve to the same file (a v0.2
 * baseline under a symlinked path beside a newer one), the older wins: it is
 * the true "before".
 * @returns {Map<string, Entry>}
 */
function loadEntries(dir = baselineDir()) {
  /** @type {Map<string, Entry>} */
  const out = new Map();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const name of names) {
    const jsonPath = path.join(dir, name);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch {
      continue; // half-written by another process; the next refresh sees it whole
    }
    if (!raw || typeof raw.path !== 'string' || typeof raw.content !== 'string') continue;
    const entry = {
      ...raw,
      existed: raw.existed !== false,
      createdAt: Number(raw.createdAt) || 0,
      content: raw.content.replace(/^\uFEFF/, ''),
      jsonPath,
      key: keyOf(raw.path),
    };
    const prev = out.get(entry.key);
    if (!prev || entry.createdAt < prev.createdAt) out.set(entry.key, entry);
  }
  return out;
}

/** The persisted fields of an entry. */
function serialize(entry) {
  const { jsonPath, key, ...rest } = entry;
  return rest;
}

/** Writes an entry atomically (temp file + rename), creating the directory if needed. */
function writeEntry(entry) {
  fs.mkdirSync(path.dirname(entry.jsonPath), { recursive: true });
  const tmp = `${entry.jsonPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(serialize(entry)));
  fs.renameSync(tmp, entry.jsonPath);
}

function removeEntry(entry) {
  try {
    fs.unlinkSync(entry.jsonPath);
  } catch {
    /* already gone */
  }
}

/** A detached copy, for undo. */
function snapshot(entry) {
  return entry ? { ...entry } : null;
}

module.exports = {
  baselineDir,
  fileNameFor,
  realPath,
  keyOf,
  forgetPath,
  loadEntries,
  writeEntry,
  removeEntry,
  snapshot,
  serialize,
};
