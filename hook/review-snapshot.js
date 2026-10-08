#!/usr/bin/env node
// claude-inline-review hook v0.3.0
//
// Claude Code PreToolUse hook for Edit, MultiEdit and Write. Before Claude
// changes a file, saves the file as it is now as the "review baseline". Only
// the first edit since the last review makes one, so later edits pile up into
// the same pending review, as in Cursor. The editor extension "Claude Inline
// Review" diffs each file against its baseline and shows the change inline
// with Accept / Reject.
//
// Baselines live in ~/.claude/review/baselines (or $CLAUDE_REVIEW_DIR),
// outside your project: nothing to gitignore. This hook never blocks a tool
// call and never prints anything.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);
const MAX_BYTES = 8 * 1024 * 1024;

function baselineDir() {
  return process.env.CLAUDE_REVIEW_DIR || path.join(os.homedir(), '.claude', 'review', 'baselines');
}

// Must match src/store.js in the extension.
function fileNameFor(absPath) {
  const b64 = Buffer.from(absPath).toString('base64url');
  return (b64.length <= 200 ? b64 : 'h-' + crypto.createHash('sha256').update(absPath).digest('hex')) + '.json';
}

function realPath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
}

function snapshot(data) {
  if (data.tool_name && !TOOLS.has(data.tool_name)) return;
  const input = data.tool_input || {};
  const filePath = input.file_path;
  if (typeof filePath !== 'string' || !filePath) return;

  const given = path.resolve(data.cwd || process.cwd(), filePath);
  const abs = realPath(given);
  const dir = baselineDir();
  const target = path.join(dir, fileNameFor(abs));
  // A review is already pending for this file (v0.2 keyed it by the unresolved path).
  if (fs.existsSync(target) || (given !== abs && fs.existsSync(path.join(dir, fileNameFor(given))))) return;

  let existed = false;
  let content = '';
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_BYTES) return;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return; // binary
    existed = true;
    content = buf.toString('utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    if (e.code !== 'ENOENT') return;
  }

  fs.mkdirSync(dir, { recursive: true });
  const entry = {
    version: 2,
    path: abs,
    existed,
    content,
    createdAt: Date.now(),
    tool: data.tool_name,
    sessionId: data.session_id,
  };
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry));
  try {
    fs.linkSync(tmp, target); // fails if a parallel call already made the baseline
  } catch (e) {
    if (e.code !== 'EEXIST' && !fs.existsSync(target)) fs.renameSync(tmp, target);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* renamed */
    }
  }
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    try {
      snapshot(JSON.parse(input));
    } catch {
      // Never block Claude because of the review tool.
    }
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}

if (require.main === module) main();

module.exports = { snapshot, fileNameFor, baselineDir };
