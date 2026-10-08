'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '../../hook/review-snapshot.js');
const store = require('../../src/store');
const setup = require('../../src/setup');

// Symlinks need extra privileges on Windows, and POSIX file modes do not exist there.
const posixOnly = { skip: process.platform === 'win32' && 'needs POSIX symlinks and file modes' };

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cir-test-'));
}

function runHook(input, env) {
  const r = spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, 'the hook always exits 0');
  assert.equal(r.stdout, '', 'the hook prints nothing');
  return r;
}

test('hook snapshots a file before its first edit only', () => {
  const root = tmpdir();
  const dir = path.join(root, 'baselines');
  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, 'original\n');
  runHook({ tool_name: 'Edit', tool_input: { file_path: file }, cwd: root, session_id: 's1' }, { CLAUDE_REVIEW_DIR: dir });
  fs.writeFileSync(file, 'changed\n');
  runHook({ tool_name: 'Edit', tool_input: { file_path: file }, cwd: root }, { CLAUDE_REVIEW_DIR: dir });

  const entries = store.loadEntries(dir);
  assert.equal(entries.size, 1);
  const [entry] = entries.values();
  assert.equal(entry.content, 'original\n');
  assert.equal(entry.existed, true);
  assert.equal(entry.sessionId, 's1');
  assert.equal(entry.version, 2);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp files left');
});

test('hook resolves relative paths against cwd and records new files', () => {
  const root = tmpdir();
  const dir = path.join(root, 'b');
  runHook({ tool_name: 'Write', tool_input: { file_path: 'new.txt' }, cwd: root }, { CLAUDE_REVIEW_DIR: dir });
  const [entry] = store.loadEntries(dir).values();
  assert.equal(entry.path, path.join(fs.realpathSync.native(root), 'new.txt'));
  assert.equal(entry.existed, false);
  assert.equal(entry.content, '');
});

test('hook skips binary files, other tools and bad input without failing', () => {
  const root = tmpdir();
  const dir = path.join(root, 'b');
  const bin = path.join(root, 'x.bin');
  fs.writeFileSync(bin, Buffer.from([1, 0, 2]));
  runHook({ tool_name: 'Edit', tool_input: { file_path: bin }, cwd: root }, { CLAUDE_REVIEW_DIR: dir });
  runHook({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: root }, { CLAUDE_REVIEW_DIR: dir });
  runHook('not json', { CLAUDE_REVIEW_DIR: dir });
  runHook('', { CLAUDE_REVIEW_DIR: dir });
  assert.equal(store.loadEntries(dir).size, 0);
});

test('hook strips a UTF-8 BOM so the first line does not diff', () => {
  const root = tmpdir();
  const dir = path.join(root, 'b');
  const file = path.join(root, 'bom.txt');
  fs.writeFileSync(file, '\uFEFFhello\n');
  runHook({ tool_name: 'Edit', tool_input: { file_path: file }, cwd: root }, { CLAUDE_REVIEW_DIR: dir });
  assert.equal([...store.loadEntries(dir).values()][0].content, 'hello\n');
});

test('a symlinked path and its target are one review', posixOnly, () => {
  const root = tmpdir();
  const dir = path.join(root, 'b');
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'f.txt'), 'x\n');
  fs.symlinkSync(real, path.join(root, 'link'));
  runHook({ tool_name: 'Edit', tool_input: { file_path: path.join(root, 'link', 'f.txt') }, cwd: root }, { CLAUDE_REVIEW_DIR: dir });
  runHook({ tool_name: 'Edit', tool_input: { file_path: path.join(real, 'f.txt') }, cwd: root }, { CLAUDE_REVIEW_DIR: dir });
  assert.equal(fs.readdirSync(dir).length, 1);
  const [entry] = store.loadEntries(dir).values();
  assert.equal(entry.key, store.keyOf(path.join(root, 'link', 'f.txt')));
});

test('a v0.2 baseline under a symlinked path still blocks a second snapshot', posixOnly, () => {
  const root = tmpdir();
  const dir = path.join(root, 'b');
  fs.mkdirSync(dir);
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'f.txt'), 'now\n');
  fs.symlinkSync(real, path.join(root, 'link'));
  const given = path.join(root, 'link', 'f.txt');
  fs.writeFileSync(path.join(dir, store.fileNameFor(given)), JSON.stringify({ path: given, existed: true, content: 'v02 baseline\n', createdAt: 1 }));
  runHook({ tool_name: 'Edit', tool_input: { file_path: given }, cwd: root }, { CLAUDE_REVIEW_DIR: dir });
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.equal([...store.loadEntries(dir).values()][0].content, 'v02 baseline\n');
});

test('very long paths get a hashed baseline name', posixOnly, () => {
  const root = tmpdir();
  const dir = path.join(root, 'b');
  let deep = root;
  for (let i = 0; i < 6; i++) deep = path.join(deep, 'a-rather-long-directory-name-' + i);
  fs.mkdirSync(deep, { recursive: true });
  const file = path.join(deep, 'file-with-a-long-name.txt');
  fs.writeFileSync(file, 'x\n');
  runHook({ tool_name: 'Edit', tool_input: { file_path: file }, cwd: root }, { CLAUDE_REVIEW_DIR: dir });
  const names = fs.readdirSync(dir);
  assert.equal(names.length, 1);
  assert.match(names[0], /^h-[0-9a-f]{64}\.json$/);
  assert.equal(store.fileNameFor(fs.realpathSync(file)), names[0]);
});

test('hook and store agree on file names', () => {
  const hook = require(HOOK);
  for (const p of ['/a/b.txt', '/x'.repeat(300), 'C:\\Users\\me\\f.js']) assert.equal(hook.fileNameFor(p), store.fileNameFor(p));
});

test('store: older baseline wins on duplicates, junk is ignored, writes are atomic', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ path: '/same/file', existed: true, content: 'newer', createdAt: 20 }));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ path: '/same/file', existed: true, content: 'older', createdAt: 10 }));
  fs.writeFileSync(path.join(dir, 'c.json'), '{ half-written');
  fs.writeFileSync(path.join(dir, 'd.json'), JSON.stringify({ nope: true }));
  const entries = store.loadEntries(dir);
  assert.equal(entries.size, 1);
  const entry = [...entries.values()][0];
  assert.equal(entry.content, 'older');
  entry.content = 'edited';
  store.writeEntry(entry);
  const raw = JSON.parse(fs.readFileSync(entry.jsonPath, 'utf8'));
  assert.equal(raw.content, 'edited');
  assert.equal(raw.jsonPath, undefined, 'runtime fields are not persisted');
  assert.equal(raw.key, undefined);
});

test('setup: install merges into settings, is idempotent, and only sets acceptEdits when asked', () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }] }, permissions: { allow: ['x'] } })
  );
  const done = setup.install({ bundledHook: HOOK, dir });
  assert.ok(done.some((d) => d.includes('added the review hook')));
  let s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(s.model, 'opus');
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.equal(s.permissions.defaultMode, undefined);
  assert.equal(s.hooks.PreToolUse[1].matcher, 'Edit|MultiEdit|Write');
  assert.equal(s.hooks.PostToolUse.length, 1, 'PostToolUse reports landed writes');
  assert.ok(fs.existsSync(path.join(dir, 'hooks', 'review-snapshot.js')));
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('settings.json.backup-')));

  const again = setup.install({ bundledHook: HOOK, dir, acceptEdits: true });
  s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(s.hooks.PreToolUse.length, 2, 'not added twice');
  assert.equal(s.permissions.defaultMode, 'acceptEdits');
  assert.deepEqual(s.permissions.allow, ['x']);
  assert.ok(again.some((d) => d.includes('acceptEdits')));

  const st = setup.status(HOOK, dir);
  assert.equal(st.configured, true);
  assert.equal(st.complete, true);
  assert.equal(st.upToDate, true);
  assert.equal(st.outdated, false);
});

test('setup: repairs an old matcher, refuses invalid JSON, uninstalls cleanly', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: setup.DEFAULT_COMMAND }] }] } }));
  setup.install({ bundledHook: HOOK, dir });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse[0].matcher, 'Edit|MultiEdit|Write');

  const done = setup.uninstall({ dir });
  assert.ok(done.length >= 1);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.hooks, undefined);
  assert.ok(!fs.existsSync(path.join(dir, 'hooks', 'review-snapshot.js')));

  fs.writeFileSync(file, '{ broken');
  assert.throws(() => setup.install({ bundledHook: HOOK, dir }));
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken', 'an unreadable settings file is never overwritten');
  assert.ok(setup.status(HOOK, dir).settingsError);
});

test('setup: recognises the v0.2 hook as ours and out of date', () => {
  // The header of the v0.2 hook, which carried no version marker.
  const legacy = `// Claude Code PreToolUse hook.
// Before Claude edits a file, save the file's current content as the "review baseline".
// Only the FIRST edit since your last review creates a baseline, so later edits pile up
// into the same pending review (like Cursor). The VS Code extension "Claude Inline Review"
// reads these baselines and shows the differences inline with Accept / Reject.`;
  assert.equal(setup.hookVersion(legacy), 'legacy');
  assert.equal(setup.hookVersion(fs.readFileSync(HOOK, 'utf8')), require('../../package.json').version);
  assert.equal(setup.hookVersion('console.log(1)'), null);
});

test('hook PostToolUse marks a pending baseline as landed, and nothing else', () => {
  const root = tmpdir();
  const dir = path.join(root, 'b');
  const file = path.join(root, 'f.txt');
  fs.writeFileSync(file, 'x\n');
  runHook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file }, cwd: root }, { CLAUDE_REVIEW_DIR: dir });
  assert.ok(!fs.existsSync(dir), 'no baseline, so no marker');
  runHook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file }, cwd: root }, { CLAUDE_REVIEW_DIR: dir });
  let [entry] = store.loadEntries(dir).values();
  assert.equal(entry.landedAt, 0);
  runHook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file }, cwd: root }, { CLAUDE_REVIEW_DIR: dir });
  [entry] = store.loadEntries(dir).values();
  assert.ok(entry.landedAt > 0);
  store.writeEntry(entry);
  assert.equal(JSON.parse(fs.readFileSync(entry.jsonPath, 'utf8')).landedAt, undefined, 'not persisted into the baseline');
  store.removeEntry(entry);
  assert.deepEqual(fs.readdirSync(dir), [], 'removing a review removes its marker');
});

test('setup writes through a symlinked settings.json and keeps its permissions', posixOnly, () => {
  const dir = tmpdir();
  const dotfiles = tmpdir();
  const real = path.join(dotfiles, 'claude-settings.json');
  fs.writeFileSync(real, JSON.stringify({ env: { SECRET: 'x' } }));
  fs.chmodSync(real, 0o600);
  fs.symlinkSync(real, path.join(dir, 'settings.json'));
  setup.install({ bundledHook: HOOK, dir });
  assert.ok(fs.lstatSync(path.join(dir, 'settings.json')).isSymbolicLink(), 'still a symlink');
  assert.equal(fs.statSync(real).mode & 0o777, 0o600);
  assert.ok(JSON.parse(fs.readFileSync(real, 'utf8')).hooks.PreToolUse);
  const backup = fs.readdirSync(dir).find((f) => f.startsWith('settings.json.backup-'));
  assert.equal(fs.statSync(path.join(dir, backup)).mode & 0o777, 0o600);
});

test('setup only ever upgrades the hook', () => {
  assert.equal(setup.compareVersions('legacy', '0.3.0'), -1);
  assert.equal(setup.compareVersions('0.3.0', '0.3.0'), 0);
  assert.equal(setup.compareVersions('0.10.0', '0.9.1'), 1);
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'hooks'));
  fs.writeFileSync(path.join(dir, 'hooks', 'review-snapshot.js'), '// claude-inline-review hook v9.0.0\n');
  const st = setup.status(HOOK, dir);
  assert.equal(st.outdated, false, 'a newer hook from another editor is left alone');
});

test('the hook command is portable on POSIX and absolute on Windows', () => {
  const home = path.join(os.homedir(), '.claude');
  assert.equal(setup.hookCommand(home, 'linux'), setup.DEFAULT_COMMAND);
  assert.equal(setup.hookCommand(home, 'win32'), `node "${path.join(home, 'hooks', 'review-snapshot.js')}"`);
  assert.equal(setup.hookCommand('/elsewhere', 'linux'), `node "${path.join('/elsewhere', 'hooks', 'review-snapshot.js')}"`);
});
