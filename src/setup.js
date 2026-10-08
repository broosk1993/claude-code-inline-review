'use strict';

// Connecting Claude Code to the extension: the hook script in ~/.claude/hooks
// and its entry in ~/.claude/settings.json. Shared by the installer and the
// extension's "Set up Claude Code hook" command; no editor dependency.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_FILE = 'review-snapshot.js';
const MATCHER = 'Edit|MultiEdit|Write';
const DEFAULT_COMMAND = `node "$HOME/.claude/hooks/${HOOK_FILE}"`;

function claudeDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function hookPath(dir = claudeDir()) {
  return path.join(dir, 'hooks', HOOK_FILE);
}

function settingsPath(dir = claudeDir()) {
  return path.join(dir, 'settings.json');
}

/**
 * The settings command: the portable $HOME form, unless Claude's config lives
 * elsewhere or the hook runs on Windows, where $HOME is not expanded.
 */
function hookCommand(dir = claudeDir(), platform = process.platform) {
  const portable = platform !== 'win32' && path.resolve(dir) === path.join(os.homedir(), '.claude');
  return portable ? DEFAULT_COMMAND : `node "${hookPath(dir)}"`;
}

const isOurCommand = (cmd) => typeof cmd === 'string' && cmd.includes(HOOK_FILE);

/** "0.3.0" from the hook's header, "legacy" for the unversioned v0.2 hook, null if it is not ours. */
function hookVersion(text) {
  const m = /claude-inline-review hook v(\d+\.\d+\.\d+)/.exec(text);
  if (m) return m[1];
  // v0.2 had no version marker; it named the extension in its header.
  return /Claude Inline Review/.test(text) && /baseline/.test(text) ? 'legacy' : null;
}

/** @param {string} file */
function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw); // throws on invalid JSON: never overwrite a file we cannot read
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings.json is not a JSON object');
  return parsed;
}

/**
 * Adds the hook to settings (or repairs its matcher), and optionally sets
 * permissions.defaultMode to acceptEdits. Returns what changed.
 * @param {any} settings mutated in place
 * @param {{ command: string, acceptEdits?: boolean }} opts
 */
const EVENTS = ['PreToolUse', 'PostToolUse'];

function hasOurHook(settings, event) {
  const groups = settings && settings.hooks && Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  return groups.some((g) => Array.isArray(g && g.hooks) && g.hooks.some((h) => isOurCommand(h && h.command)));
}

function mergeSettings(settings, { command, acceptEdits = false }) {
  const notes = [];
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const event of EVENTS) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    settings.hooks[event] = groups;
    const ours = groups.find((g) => Array.isArray(g && g.hooks) && g.hooks.some((h) => isOurCommand(h && h.command)));
    if (!ours) {
      groups.push({ matcher: MATCHER, hooks: [{ type: 'command', command }] });
      notes.push(`added the review hook (${event})`);
    } else if (ours.matcher !== MATCHER) {
      if (ours.hooks.length === 1) {
        ours.matcher = MATCHER;
      } else {
        ours.hooks = ours.hooks.filter((h) => !isOurCommand(h && h.command));
        groups.push({ matcher: MATCHER, hooks: [{ type: 'command', command }] });
      }
      notes.push(`set the ${event} hook matcher to ${MATCHER}`);
    }
  }
  if (acceptEdits) {
    settings.permissions = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};
    if (settings.permissions.defaultMode !== 'acceptEdits') {
      notes.push(`permissions.defaultMode: ${settings.permissions.defaultMode || '(unset)'} -> acceptEdits`);
      settings.permissions.defaultMode = 'acceptEdits';
    }
  }
  return notes;
}

/** Removes every hook entry that runs this hook script. */
function unmergeSettings(settings) {
  if (!settings || !settings.hooks || typeof settings.hooks !== 'object') return false;
  let removed = false;
  for (const event of EVENTS) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : null;
    if (!groups) continue;
    for (const g of groups) {
      if (!Array.isArray(g && g.hooks)) continue;
      const kept = g.hooks.filter((h) => !isOurCommand(h && h.command));
      if (kept.length !== g.hooks.length) removed = true;
      g.hooks = kept;
    }
    settings.hooks[event] = groups.filter((g) => !Array.isArray(g && g.hooks) || g.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

function writeSettings(file, settings, { backup = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backupPath = null;
  // Write through a symlink (dotfiles repos), and keep the file's permissions:
  // settings.json can hold secrets in "env".
  let target = file;
  let mode = 0o600;
  if (fs.existsSync(file)) {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o777;
    if (backup) {
      backupPath = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(target, backupPath);
      fs.chmodSync(backupPath, mode);
    }
  }
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
  return backupPath;
}

/** Copies the bundled hook into place, atomically: a hook starting right now reads the old or the new file, never half of one. */
function installHookScript(bundledHook, dir = claudeDir()) {
  const dest = hookPath(dir);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.copyFileSync(bundledHook, tmp);
  try {
    fs.chmodSync(tmp, 0o755);
  } catch {
    /* not supported */
  }
  fs.renameSync(tmp, dest);
  return dest;
}

/** -1, 0, 1 for dotted versions; "legacy" (v0.2) is older than any. */
function compareVersions(a, b) {
  const parts = (v) => (v === 'legacy' ? [0] : String(v).split('.').map(Number));
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/**
 * Where things stand: is the hook script installed, ours, current, and wired in settings?
 * @param {string} bundledHook
 */
function status(bundledHook, dir = claudeDir()) {
  const dest = hookPath(dir);
  const bundledVersion = hookVersion(fs.readFileSync(bundledHook, 'utf8'));
  let installedVersion = null;
  try {
    installedVersion = hookVersion(fs.readFileSync(dest, 'utf8'));
  } catch {
    /* not installed */
  }
  let configured = false;
  let complete = false;
  let mode;
  let settingsError = null;
  try {
    const s = readSettings(settingsPath(dir));
    configured = hasOurHook(s, 'PreToolUse');
    complete = configured && hasOurHook(s, 'PostToolUse');
    mode = s.permissions && s.permissions.defaultMode;
  } catch (e) {
    settingsError = e.message;
  }
  return {
    hookPath: dest,
    installedVersion,
    bundledVersion,
    upToDate: installedVersion === bundledVersion,
    /** The installed hook is ours and older than the bundled one. */
    outdated: !!installedVersion && compareVersions(installedVersion, bundledVersion) < 0,
    configured,
    /** Both PreToolUse and PostToolUse are wired. */
    complete,
    defaultMode: mode,
    settingsError,
  };
}

/**
 * Full setup: hook script + settings. Returns a list of what was done.
 * @param {{ bundledHook: string, dir?: string, acceptEdits?: boolean }} opts
 */
function install({ bundledHook, dir = claudeDir(), acceptEdits = false }) {
  const done = [];
  done.push('hook copied to ' + installHookScript(bundledHook, dir));
  const file = settingsPath(dir);
  const settings = readSettings(file);
  const notes = mergeSettings(settings, { command: hookCommand(dir), acceptEdits });
  if (notes.length) {
    const backup = writeSettings(file, settings);
    if (backup) done.push('settings backed up to ' + backup);
    done.push(...notes.map((n) => 'settings: ' + n));
  } else {
    done.push('settings already had the hook');
  }
  return done;
}

/**
 * Removes the hook from settings and deletes the script. Baselines are left alone unless asked.
 * @param {{ dir?: string, removeBaselines?: boolean, baselinesDir?: string }} [opts]
 */
function uninstall({ dir = claudeDir(), removeBaselines = false, baselinesDir } = {}) {
  const done = [];
  const file = settingsPath(dir);
  const settings = readSettings(file);
  if (unmergeSettings(settings)) {
    const backup = writeSettings(file, settings);
    done.push('hook removed from settings' + (backup ? ` (backup: ${backup})` : ''));
  }
  try {
    const dest = hookPath(dir);
    if (hookVersion(fs.readFileSync(dest, 'utf8'))) {
      fs.unlinkSync(dest);
      done.push('deleted ' + dest);
    }
  } catch {
    /* not installed */
  }
  if (removeBaselines && baselinesDir && fs.existsSync(baselinesDir)) {
    fs.rmSync(baselinesDir, { recursive: true, force: true });
    done.push('deleted pending reviews in ' + baselinesDir);
  }
  return done;
}

module.exports = {
  HOOK_FILE,
  MATCHER,
  DEFAULT_COMMAND,
  claudeDir,
  hookPath,
  settingsPath,
  hookCommand,
  hookVersion,
  compareVersions,
  readSettings,
  mergeSettings,
  unmergeSettings,
  writeSettings,
  installHookScript,
  status,
  install,
  uninstall,
};
