#!/usr/bin/env node
// Claude Inline Review installer.
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

const here = __dirname;
const firstExisting = (...candidates) => candidates.find((p) => fs.existsSync(p));
const setup = require(firstExisting(path.join(here, 'setup.js'), path.join(here, '../src/setup.js')));
const HOOK = firstExisting(path.join(here, 'review-snapshot.js'), path.join(here, '../hook/review-snapshot.js'));
const EXTENSION_ID = 'local.claude-inline-review';

const args = new Set(process.argv.slice(2));
const ok = (msg) => console.log('✔ ' + msg);
const warn = (msg) => console.log('! ' + msg);

const EDITORS = [
  { label: 'Cursor', cli: 'cursor', dir: '.cursor' },
  { label: 'VS Code', cli: 'code', dir: '.vscode' },
  { label: 'VS Code Insiders', cli: 'code-insiders', dir: '.vscode-insiders' },
  { label: 'VSCodium', cli: 'codium', dir: '.vscode-oss' },
  { label: 'Windsurf', cli: 'windsurf', dir: '.windsurf' },
];

function findVsix() {
  for (const dir of [here, path.join(here, '../dist')]) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((f) => /^claude-inline-review-.*\.vsix$/.test(f));
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

/** A CLI run from inside an editor terminal must not hand the job to that editor. */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'VSCODE_IPC_HOOK_CLI' || k === 'ELECTRON_RUN_AS_NODE') delete env[k];
  return env;
}

function removeOldCopies(extDir) {
  let removed = 0;
  for (const name of fs.readdirSync(extDir)) {
    if (name.startsWith(EXTENSION_ID + '-')) {
      fs.rmSync(path.join(extDir, name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

function copyExtension(extDir, version) {
  const src = path.dirname(findUnpacked());
  const dest = path.join(extDir, `${EXTENSION_ID}-${version}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const item of ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'src', 'hook']) {
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
    const cli = onPath(ed.cli);
    const hasDir = fs.existsSync(path.join(os.homedir(), ed.dir));
    if (!cli && !hasDir) continue;
    if (fs.existsSync(extDir)) removeOldCopies(extDir);
    if (cli && vsix) {
      const r = spawnSync(cli, ['--install-extension', vsix, '--force'], { encoding: 'utf8', env: cleanEnv(), timeout: 120_000 });
      if (r.status === 0) {
        done.push(`${ed.label} (via ${ed.cli})`);
        continue;
      }
      warn(`${ed.cli} --install-extension failed (${(r.stderr || r.stdout || '').trim().split('\n').pop()}); copying instead`);
    }
    if (hasDir) {
      fs.mkdirSync(extDir, { recursive: true });
      copyExtension(extDir, version);
      done.push(`${ed.label} (copied into ~/${ed.dir}/extensions)`);
    }
  }
  if (done.length) ok('Extension installed for: ' + done.join(', '));
  else warn('No Cursor or VS Code found. Install the .vsix from the editor: Extensions: Install from VSIX…');
}

function uninstallExtension() {
  for (const ed of EDITORS) {
    const cli = onPath(ed.cli);
    if (cli) spawnSync(cli, ['--uninstall-extension', EXTENSION_ID], { encoding: 'utf8', env: cleanEnv(), timeout: 120_000 });
    const extDir = path.join(os.homedir(), ed.dir, 'extensions');
    if (fs.existsSync(extDir) && removeOldCopies(extDir)) ok(`Extension removed from ${ed.label}`);
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
  console.log('\nDone. Reload editor windows (Developer: Reload Window) and restart Claude Code sessions.');
}

main().catch((e) => {
  console.error('✘ ' + (e.message || e));
  process.exit(1);
});
