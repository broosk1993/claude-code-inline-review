#!/usr/bin/env node
// claude-inline-review hook v0.3.0
//
// Claude Code hook for Edit, MultiEdit and Write.
//
// PreToolUse: before Claude changes a file, saves the file as it is now as
// the "review baseline". Only the first edit since the last review makes one,
// so later edits pile up into the same pending review, as in Cursor. The
// editor extension "Claude Inline Review" diffs each file against its
// baseline and shows the change inline with Accept / Reject.
//
// PostToolUse: touches a "<baseline>.landed" marker, so the extension knows
// Claude's write happened. Until then a baseline with no difference is a
// write still waiting (on a permission prompt, say), not an abandoned one.
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

/** The baseline file for this tool call, and whether one (under either name) exists. */
function locate(data) {
  if (data.tool_name && !TOOLS.has(data.tool_name)) return null;
  const input = data.tool_input || {};
  const filePath = input.file_path;
  if (typeof filePath !== 'string' || !filePath) return null;
  const given = path.resolve(data.cwd || process.cwd(), filePath);
  const abs = realPath(given);
  const dir = baselineDir();
  const target = path.join(dir, fileNameFor(abs));
  // v0.2 keyed baselines by the unresolved path.
  const legacy = given !== abs ? path.join(dir, fileNameFor(given)) : null;
  const existing = fs.existsSync(target) ? target : legacy && fs.existsSync(legacy) ? legacy : null;
  return { abs, dir, target, existing };
}

/** PostToolUse: mark the baseline's write as landed. */
function landed(data) {
  const loc = locate(data);
  if (!loc || !loc.existing) return;
  fs.writeFileSync(loc.existing.replace(/\.json$/, '.landed'), String(Date.now()));
}

function snapshot(data) {
  const loc = locate(data);
  if (!loc || loc.existing) return; // nothing to track, or a review is already pending
  const { abs, dir, target } = loc;

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
      const data = JSON.parse(input);
      if (data.hook_event_name === 'PostToolUse') landed(data);
      else snapshot(data);
    } catch {
      // Never block Claude because of the review tool.
    }
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}

if (require.main === module) main();

module.exports = { snapshot, landed, fileNameFor, baselineDir };
