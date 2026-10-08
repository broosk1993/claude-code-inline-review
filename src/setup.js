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

/** The settings command; the portable $HOME form unless Claude's config lives elsewhere. */
function hookCommand(dir = claudeDir()) {
  return path.resolve(dir) === path.join(os.homedir(), '.claude') ? DEFAULT_COMMAND : `node "${hookPath(dir)}"`;
}

const isOurCommand = (cmd) => typeof cmd === 'string' && cmd.includes(HOOK_FILE);

/** "0.3.0" from the hook's header, "legacy" for the unversioned v0.2 hook, null if it is not ours. */
function hookVersion(text) {
  const m = /claude-inline-review hook v(\d+\.\d+\.\d+)/.exec(text);
  if (m) return m[1];
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
function mergeSettings(settings, { command, acceptEdits = false }) {
  const notes = [];
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const groups = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  settings.hooks.PreToolUse = groups;
  const ours = groups.find((g) => Array.isArray(g && g.hooks) && g.hooks.some((h) => isOurCommand(h && h.command)));
  if (!ours) {
    groups.push({ matcher: MATCHER, hooks: [{ type: 'command', command }] });
    notes.push('added the review hook');
  } else if (ours.matcher !== MATCHER) {
    if (ours.hooks.length === 1) {
      ours.matcher = MATCHER;
    } else {
      ours.hooks = ours.hooks.filter((h) => !isOurCommand(h && h.command));
      groups.push({ matcher: MATCHER, hooks: [{ type: 'command', command }] });
    }
    notes.push(`set the hook matcher to ${MATCHER}`);
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
  const groups = settings && settings.hooks && Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : null;
  if (!groups) return false;
  let removed = false;
  for (const g of groups) {
    if (!Array.isArray(g && g.hooks)) continue;
    const kept = g.hooks.filter((h) => !isOurCommand(h && h.command));
    if (kept.length !== g.hooks.length) removed = true;
    g.hooks = kept;
  }
  settings.hooks.PreToolUse = groups.filter((g) => !Array.isArray(g && g.hooks) || g.hooks.length > 0);
  if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

function writeSettings(file, settings, { backup = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backupPath = null;
  if (backup && fs.existsSync(file)) {
    backupPath = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backupPath);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return backupPath;
}

/** Copies the bundled hook into place. */
function installHookScript(bundledHook, dir = claudeDir()) {
  const dest = hookPath(dir);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(bundledHook, dest);
  try {
    fs.chmodSync(dest, 0o755);
  } catch {
    /* not supported */
  }
  return dest;
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
  let mode;
  let settingsError = null;
  try {
    const s = readSettings(settingsPath(dir));
    const groups = s.hooks && Array.isArray(s.hooks.PreToolUse) ? s.hooks.PreToolUse : [];
    configured = groups.some((g) => Array.isArray(g && g.hooks) && g.hooks.some((h) => isOurCommand(h && h.command)));
    mode = s.permissions && s.permissions.defaultMode;
  } catch (e) {
    settingsError = e.message;
  }
  return {
    hookPath: dest,
    installedVersion,
    bundledVersion,
    upToDate: installedVersion === bundledVersion,
    configured,
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
  readSettings,
  mergeSettings,
  unmergeSettings,
  writeSettings,
  installHookScript,
  status,
  install,
  uninstall,
};
