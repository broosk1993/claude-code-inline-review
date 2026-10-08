#!/usr/bin/env node
// Installer for Inline Review for Claude Code.
//
//   node install.js                 hook + settings + extension (asks about acceptEdits)
//   node install.js --accept-edits  also set permissions.defaultMode = acceptEdits
//   node install.js --keep-mode     leave permissions.defaultMode alone
//   node install.js --no-extension  only the Claude Code side
//   node install.js --no-hook       only the editor extension
//   node install.js --uninstall     remove the hook from settings, the hook script and the extension
//
// 1) Copies the hook to ~/.claude/hooks/review-snapshot.js
// 2) Adds it to ~/.claude/settings.json (backup first; an unreadable file is never touched)
// 3) Installs the extension into every editor it finds: through the editor's
//    CLI when it is on PATH (cursor, code, code-insiders, codium, windsurf),
//    else by copying into ~/.cursor/extensions, ~/.vscode/extensions, ...

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const here = __dirname;
const firstExisting = (...candidates) => candidates.find((p) => fs.existsSync(p));
const setup = require(firstExisting(path.join(here, 'setup.js'), path.join(here, '../src/setup.js')));
const HOOK = firstExisting(path.join(here, 'review-snapshot.js'), path.join(here, '../hook/review-snapshot.js'));
const EXTENSION_ID = 'broosk1993.claude-code-inline-review';
// Builds before 0.4.0 were installed by hand under this ID; replaced on install.
const LEGACY_IDS = ['local.claude-inline-review'];
const isOurId = (id) => [EXTENSION_ID, ...LEGACY_IDS].includes(String(id).toLowerCase());

const args = new Set(process.argv.slice(2));
const ok = (msg) => console.log('✔ ' + msg);
const warn = (msg) => console.log('! ' + msg);

// dir: where extensions live (~/<dir>/extensions); app: the editor's data
// folder name (~/.config/<app> on Linux), which holds its extension caches.
const EDITORS = [
  { label: 'Cursor', cli: 'cursor', dir: '.cursor', app: 'Cursor' },
  { label: 'VS Code', cli: 'code', dir: '.vscode', app: 'Code' },
  { label: 'VS Code Insiders', cli: 'code-insiders', dir: '.vscode-insiders', app: 'Code - Insiders' },
  { label: 'VSCodium', cli: 'codium', dir: '.vscode-oss', app: 'VSCodium' },
  { label: 'Windsurf', cli: 'windsurf', dir: '.windsurf', app: 'Windsurf' },
];

function appDataDir(app) {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), app);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', app);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), app);
}

function findVsix() {
  for (const dir of [here, path.join(here, '../dist')]) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((f) => /^claude-code-inline-review-.*\.vsix$/.test(f));
    } catch {
      continue;
    }
    names.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
    if (names.length) return path.join(dir, names[0]);
  }
  return null;
}

/** The extension as a folder, for editors without a CLI on PATH. */
function findUnpacked() {
  return firstExisting(path.join(here, 'extension', 'package.json'), path.join(here, '../package.json'));
}

function onPath(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

/**
 * An editor's CLI launcher is a script (or .cmd). Inside an AppImage the
 * name can resolve to the app binary itself, which does not install anything:
 * it hands the arguments to the running editor, which opens a window.
 */
function isCliLauncher(file) {
  if (process.platform === 'win32') return true;
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    return head.toString('latin1', 0, 2) === '#!';
  } catch {
    return false;
  }
}

/** A CLI run from inside an editor terminal must not hand the job to that editor. */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'VSCODE_IPC_HOOK_CLI' || k === 'ELECTRON_RUN_AS_NODE') delete env[k];
  return env;
}

/** Removes this extension's folders, except the version given. */
function removeOldCopies(extDir, keepVersion) {
  let removed = 0;
  for (const name of fs.readdirSync(extDir)) {
    const ours = [EXTENSION_ID, ...LEGACY_IDS].some((id) => name.toLowerCase().startsWith(id + '-'));
    if (ours && name !== `${EXTENSION_ID}-${keepVersion}`) {
      fs.rmSync(path.join(extDir, name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

/**
 * Points the editor's extension registry (extensions/extensions.json) at the
 * copied folder. Without this an editor that already registered an older
 * copy keeps looking for that folder. An unreadable registry is left alone.
 * @param {string | null} version null to remove the entry
 */
function register(extDir, version) {
  updateRegistry(path.join(extDir, 'extensions.json'), extDir, version, { add: true });
}

/**
 * Each editor profile other than the default keeps its own registry
 * (<app data>/User/profiles/<id>/extensions.json). A profile that lists this
 * extension must follow the copy too, or that profile keeps looking for the
 * old folder. Profiles that never had it are left as they are.
 */
function registerInProfiles(app, extDir, version) {
  const root = path.join(appDataDir(app), 'User', 'profiles');
  let profiles = [];
  try {
    profiles = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const profile of profiles) {
    updateRegistry(path.join(root, profile, 'extensions.json'), extDir, version, { add: false });
  }
}

function updateRegistry(file, extDir, version, { add }) {
  if (!fs.existsSync(file)) return; // the editor scans the folder itself
  let list;
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    warn(`${file} is not valid JSON; not touched`);
    return;
  }
  if (!Array.isArray(list)) return;
  const ours = (e) => e && e.identifier && isOurId(e.identifier.id);
  const had = list.some(ours);
  if (!had && !add) return;
  list = list.filter((e) => !ours(e));
  if (version) {
    const folder = `${EXTENSION_ID}-${version}`;
    const location = path.join(extDir, folder);
    const url = pathToFileURL(location);
    list.push({
      identifier: { id: EXTENSION_ID },
      version,
      location: { $mid: 1, fsPath: location, external: url.href, path: url.pathname, scheme: 'file' },
      relativeLocation: folder,
      metadata: { installedTimestamp: Date.now(), pinned: true, source: 'vsix' },
    });
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list));
  fs.renameSync(tmp, file);
}

/** Removes registry entries left by builds before 0.4.0, in the default registry and every profile. */
function dropLegacyEntries(app, extDir) {
  const files = [path.join(extDir, 'extensions.json')];
  const root = path.join(appDataDir(app), 'User', 'profiles');
  try {
    for (const profile of fs.readdirSync(root)) files.push(path.join(root, profile, 'extensions.json'));
  } catch {
    /* no profiles */
  }
  for (const file of files) {
    let list;
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    const kept = list.filter((e) => !(e && e.identifier && LEGACY_IDS.includes(String(e.identifier.id).toLowerCase())));
    if (kept.length === list.length) continue;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(kept));
    fs.renameSync(tmp, file);
  }
}

/**
 * Drops the editor's cached scan of installed extensions. It is rebuilt on
 * the next start; left in place it can describe a folder that no longer
 * exists, and the editor then loads no version at all.
 */
function dropScanCache(app) {
  const root = path.join(appDataDir(app), 'CachedProfilesData');
  let dropped = 0;
  let profiles = [];
  try {
    profiles = fs.readdirSync(root);
  } catch {
    return 0;
  }
  for (const profile of profiles) {
    const cache = path.join(root, profile, 'extensions.user.cache');
    try {
      fs.unlinkSync(cache);
      dropped++;
    } catch {
      /* none for this profile */
    }
  }
  return dropped;
}

function copyExtension(extDir, version) {
  const src = path.dirname(findUnpacked());
  const dest = path.join(extDir, `${EXTENSION_ID}-${version}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const item of ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'src', 'hook', 'media']) {
    const from = path.join(src, item);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, item), { recursive: true });
  }
  return dest;
}

function installExtension() {
  const vsix = findVsix();
  const unpacked = findUnpacked();
  const version = JSON.parse(fs.readFileSync(unpacked, 'utf8')).version;
  const done = [];
  for (const ed of EDITORS) {
    const extDir = path.join(os.homedir(), ed.dir, 'extensions');
    const found = onPath(ed.cli);
    const cli = found && isCliLauncher(found) ? found : null;
    if (!cli && !fs.existsSync(extDir)) continue;
    // An editor that is really in use has extensions installed; a leftover
    // config folder with an empty registry is not worth installing into.
    const hasDir = fs.existsSync(extDir) && fs.readdirSync(extDir).some((n) => n !== 'extensions.json' && !n.startsWith('.') && ![EXTENSION_ID, ...LEGACY_IDS].some((id) => n.toLowerCase().startsWith(id)));
    if (!cli && !hasDir) continue;
    if (cli && vsix) {
      // Let the editor replace its own registered copy; only then clear out
      // older folders (removing a registered one first makes the CLI fail).
      const r = spawnSync(cli, ['--install-extension', vsix, '--force'], { encoding: 'utf8', env: cleanEnv(), timeout: 120_000 });
      if (r.status === 0) {
        if (fs.existsSync(extDir)) {
          removeOldCopies(extDir, version);
          dropLegacyEntries(ed.app, extDir);
          dropScanCache(ed.app);
        }
        done.push(`${ed.label} (via ${ed.cli})`);
        continue;
      }
      warn(`${ed.cli} --install-extension failed (${(r.stderr || r.stdout || '').trim().split('\n').pop()}); copying instead`);
    }
    if (hasDir) {
      removeOldCopies(extDir, null);
      copyExtension(extDir, version);
      register(extDir, version);
      registerInProfiles(ed.app, extDir, version);
      dropScanCache(ed.app);
      done.push(`${ed.label} (copied into ~/${ed.dir}/extensions)`);
      restartNeeded.push(ed.label);
    }
  }
  if (done.length) ok('Extension installed for: ' + done.join(', '));
  else warn('No Cursor or VS Code found. Install the .vsix from the editor: Extensions: Install from VSIX…');
  return done;
}

/** Editors installed by copying: they only pick the copy up after a full restart (Reload Window reuses the old scan). */
const restartNeeded = [];

function uninstallExtension() {
  for (const ed of EDITORS) {
    const found = onPath(ed.cli);
    if (found && isCliLauncher(found)) {
      for (const id of [EXTENSION_ID, ...LEGACY_IDS]) spawnSync(found, ['--uninstall-extension', id], { encoding: 'utf8', env: cleanEnv(), timeout: 120_000 });
    }
    const extDir = path.join(os.homedir(), ed.dir, 'extensions');
    if (fs.existsSync(extDir) && removeOldCopies(extDir, null)) {
      register(extDir, null);
      registerInProfiles(ed.app, extDir, null);
      dropScanCache(ed.app);
      ok(`Extension removed from ${ed.label}`);
    }
  }
}

async function askAcceptEdits(currentMode) {
  if (args.has('--accept-edits')) return true;
  if (args.has('--keep-mode') || currentMode === 'acceptEdits') return false;
  if (!process.stdin.isTTY) {
    warn('permissions.defaultMode left as is. Run with --accept-edits to let Claude edit without asking (recommended for inline review).');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) =>
    rl.question('Let Claude Code apply edits without asking (acceptEdits), so you review them in the editor instead? [Y/n] ', r)
  );
  rl.close();
  return !/^n/i.test(answer.trim());
}

async function main() {
  if (args.has('--help') || args.has('-h')) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 16).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  if (args.has('--uninstall')) {
    for (const line of setup.uninstall({ removeBaselines: args.has('--purge'), baselinesDir: path.join(os.homedir(), '.claude', 'review', 'baselines') })) ok(line);
    if (!args.has('--no-extension')) uninstallExtension();
    console.log('\nDone. Restart Claude Code sessions and reload editor windows.');
    return;
  }
  if (!args.has('--no-hook')) {
    const st = setup.status(HOOK);
    if (st.settingsError) {
      console.error(`✘ ${setup.settingsPath()} is not valid JSON, so it was not touched (${st.settingsError}).`);
      console.error('  Fix it, then run this again.');
      process.exit(1);
    }
    const acceptEdits = await askAcceptEdits(st.defaultMode);
    for (const line of setup.install({ bundledHook: HOOK, acceptEdits })) ok(line);
  }
  if (!args.has('--no-extension')) installExtension();
  const restart = restartNeeded.length ? `Fully quit and reopen ${restartNeeded.join(', ')} (Reload Window is not enough there); reload other editor windows` : 'Reload editor windows (Developer: Reload Window)';
  console.log(`\nDone. ${restart}, and restart Claude Code sessions.`);
}

main().catch((e) => {
  console.error('✘ ' + (e.message || e));
  process.exit(1);
});
