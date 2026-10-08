'use strict';

// Runs inside the editor's extension host. Simulates Claude Code the way it
// really works: the hook snapshots the file, then the file changes on disk.

const vscode = require('vscode');
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const hook = require('../../hook/review-snapshot.js');

const WS = process.env.CIR_E2E_WORKSPACE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, cond, timeout = 8000) {
  const started = Date.now();
  for (;;) {
    let value;
    try {
      value = await cond();
    } catch {
      value = false;
    }
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

let api;
const file = (name) => path.join(WS, name);
const uriOf = (name) => vscode.Uri.file(file(name));

/** What Claude Code does: hook first, then the write. */
function claudeWrites(name, content, tool = 'Edit') {
  hook.snapshot({ tool_name: tool, tool_input: { file_path: file(name) }, cwd: WS, session_id: 'e2e' });
  fs.writeFileSync(file(name), content);
}

function pendingFor(name) {
  api.refreshNow();
  return api.pendingFiles().find((p) => p.path === fs.realpathSync(file(name)) || p.path === file(name));
}

async function waitForHunks(name, n) {
  return waitFor(`${name} to have ${n} change(s)`, () => {
    const p = pendingFor(name);
    return n === 0 ? !p : p && p.hunks.length === n && p;
  });
}

async function openEditor(name) {
  const doc = await vscode.workspace.openTextDocument(uriOf(name));
  return vscode.window.showTextDocument(doc, { preview: false });
}

async function waitForDocText(doc, text) {
  await waitFor(`document text of ${path.basename(doc.uri.fsPath)}`, () => doc.getText() === text);
}

const tests = [];
const it = (name, fn) => tests.push({ name, fn });

it('a Claude edit to an open file shows up as changes, and the reload leaves the document clean', async () => {
  fs.writeFileSync(file('a.txt'), 'one\ntwo\nthree\n');
  const ed = await openEditor('a.txt');
  claudeWrites('a.txt', 'one\nTWO\nthree\nfour\n');
  await waitForDocText(ed.document, 'one\nTWO\nthree\nfour\n');
  assert.equal(ed.document.isDirty, false, 'a reload from disk is not dirty: this is how Claude edits are told apart from typing');
  const p = await waitForHunks('a.txt', 2);
  assert.deepEqual(p.hunks[0].aLines, ['two']);
  assert.deepEqual(p.hunks[0].bLines, ['TWO']);
  assert.deepEqual(p.hunks[1].bLines, ['four']);
  await waitFor('activeFileHasChanges context', () => api.context('claudeReview.activeFileHasChanges') === true);
});

it('typing outside Claude\'s changes is not reported as a Claude change', async () => {
  const ed = vscode.window.activeTextEditor;
  await ed.edit((b) => b.insert(new vscode.Position(0, 0), '// '));
  await sleep(300);
  const p = await waitForHunks('a.txt', 2);
  assert.ok(api.entry(file('a.txt')).content.startsWith('// one\n'), 'the baseline took the edit');
  assert.deepEqual(p.hunks[0].aLines, ['two']);
});

it('typing inside a change makes it part of the change', async () => {
  const ed = vscode.window.activeTextEditor;
  await ed.edit((b) => b.insert(new vscode.Position(1, 3), '!'));
  await sleep(300);
  const p = await waitForHunks('a.txt', 2);
  assert.deepEqual(p.hunks[0].bLines, ['TWO!']);
  assert.ok(!api.entry(file('a.txt')).content.includes('TWO'));
});

it('CodeLens offers Accept / Reject on each change', async () => {
  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uriOf('a.txt'));
  const titles = lenses.map((l) => l.command && l.command.title).filter(Boolean);
  assert.ok(titles.some((t) => t.includes('Accept file')));
  assert.equal(titles.filter((t) => /\$\(check\) Accept /.test(t)).length, 2, titles.join(' | '));
});

it('accept at the cursor keeps the change and moves to the next one', async () => {
  const ed = vscode.window.activeTextEditor;
  ed.selection = new vscode.Selection(1, 0, 1, 0);
  await waitFor('cursorInChange', () => api.context('claudeReview.cursorInChange') === true);
  await vscode.commands.executeCommand('claudeReview.acceptHunk');
  const p = await waitForHunks('a.txt', 1);
  assert.deepEqual(p.hunks[0].bLines, ['four']);
  assert.equal(ed.selection.active.line, 3, 'cursor jumped to the next change');
  assert.ok(api.entry(file('a.txt')).content.includes('TWO!'));
});

it('reject removes the change from the file and saves it', async () => {
  const ed = vscode.window.activeTextEditor;
  await vscode.commands.executeCommand('claudeReview.rejectHunk', ed.document.uri.toString(), 3);
  await waitForDocText(ed.document, '// one\nTWO!\nthree\n');
  await waitForHunks('a.txt', 0);
  assert.equal(fs.readFileSync(file('a.txt'), 'utf8'), '// one\nTWO!\nthree\n');
  assert.equal(api.entry(file('a.txt')), null, 'nothing left to review, so the baseline is gone');
});

it('Ctrl+Z after a reject brings the change back for review', async () => {
  const ed = vscode.window.activeTextEditor;
  // "undo" goes to the editor with keyboard focus, and a window the OS has
  // not focused has none. Run the suite with the test window in front to cover this.
  if (!vscode.window.state.focused) return 'skipped: the test window does not have OS focus';
  await vscode.window.showTextDocument(ed.document, { preview: false, preserveFocus: false });
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  await vscode.commands.executeCommand('undo');
  await waitForDocText(ed.document, '// one\nTWO!\nthree\nfour\n');
  const p = await waitForHunks('a.txt', 1);
  assert.deepEqual(p.hunks[0].bLines, ['four']);
});

it('accept file, then "Undo last review action" restores the review', async () => {
  await vscode.commands.executeCommand('claudeReview.acceptFile', uriOf('a.txt'));
  await waitForHunks('a.txt', 0);
  await vscode.commands.executeCommand('claudeReview.undo');
  await waitForHunks('a.txt', 1);
  await vscode.commands.executeCommand('claudeReview.acceptFile', uriOf('a.txt'));
  await waitForHunks('a.txt', 0);
});

it('two quick Claude writes in a row both stay Claude changes', async () => {
  fs.writeFileSync(file('b.txt'), 'alpha\nbeta\ngamma\n');
  const ed = await openEditor('b.txt');
  claudeWrites('b.txt', 'ALPHA\nbeta\ngamma\n');
  fs.writeFileSync(file('b.txt'), 'ALPHA\nbeta\nGAMMA\n');
  await waitForDocText(ed.document, 'ALPHA\nbeta\nGAMMA\n');
  await waitForHunks('b.txt', 2);
  assert.equal(api.entry(file('b.txt')).content, 'alpha\nbeta\ngamma\n', 'nothing was absorbed into the baseline');
});

it('word-level changes are computed and the removed code is drawn', async () => {
  await vscode.commands.executeCommand('claudeReview.showDiff', uriOf('b.txt'));
  await waitFor('diff editor', () => vscode.window.visibleTextEditors.some((e) => e.document.uri.scheme === 'claude-review-base'));
  const base = vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'claude-review-base');
  assert.equal(base.document.getText(), 'alpha\nbeta\ngamma\n');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
});

it('a file Claude changed but you never opened can be reviewed without opening it', async () => {
  fs.writeFileSync(file('closed.txt'), 'x\ny\nz\n');
  claudeWrites('closed.txt', 'x\nY\nz\n');
  const p = await waitForHunks('closed.txt', 1);
  const open = vscode.workspace.textDocuments.some((d) => d.uri.fsPath === file('closed.txt'));
  assert.equal(open, false);
  await vscode.commands.executeCommand('claudeReview.rejectHunk', uriOf('closed.txt').toString(), p.hunks[0].bStart);
  await waitForHunks('closed.txt', 0);
  assert.equal(fs.readFileSync(file('closed.txt'), 'utf8'), 'x\ny\nz\n');
});

it('the Claude Changes view lists files and their changes', async () => {
  const roots = await api.tree.getChildren();
  const fileNode = roots.find((n) => n.key.endsWith('b.txt'));
  assert.ok(fileNode, 'b.txt is listed');
  const item = api.tree.getTreeItem(fileNode);
  assert.match(String(item.description), /−2 \+2/);
  const hunks = await api.tree.getChildren(fileNode);
  assert.equal(hunks.length, 2);
  assert.match(String(api.tree.getTreeItem(hunks[0]).label), /Line 1/);
  await vscode.commands.executeCommand('claudeReview.acceptHunk', hunks[0]);
  await waitForHunks('b.txt', 1);
});

it('changing a setting redraws without errors', async () => {
  const conf = vscode.workspace.getConfiguration('claudeReview');
  await conf.update('highlightWordChanges', false, vscode.ConfigurationTarget.Global);
  await conf.update('showRemovedInline', false, vscode.ConfigurationTarget.Global);
  await waitForHunks('b.txt', 1);
  await conf.update('highlightWordChanges', undefined, vscode.ConfigurationTarget.Global);
  await conf.update('showRemovedInline', undefined, vscode.ConfigurationTarget.Global);
  await waitForHunks('b.txt', 1);
});

it('reject all deletes files Claude created and restores the rest; undo brings everything back', async () => {
  await vscode.workspace.getConfiguration('claudeReview').update('confirmRejectAll', false, vscode.ConfigurationTarget.Global);
  claudeWrites('created.txt', 'brand new\n', 'Write');
  await waitForHunks('created.txt', 1);
  await openEditor('created.txt');
  await vscode.commands.executeCommand('claudeReview.rejectAll');
  await waitFor('created.txt deleted', () => !fs.existsSync(file('created.txt')));
  await waitFor('its tab closed', () =>
    !vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputText && t.input.uri.fsPath === file('created.txt'))
  );
  await waitForHunks('b.txt', 0);
  assert.equal(fs.readFileSync(file('b.txt'), 'utf8'), 'ALPHA\nbeta\ngamma\n', 'accepted change kept, the rest rejected');
  await vscode.commands.executeCommand('claudeReview.undo');
  await waitFor('created.txt back', () => fs.existsSync(file('created.txt')));
  assert.equal(fs.readFileSync(file('created.txt'), 'utf8'), 'brand new\n');
  await waitForHunks('created.txt', 1);
  await waitForHunks('b.txt', 1);
  await vscode.commands.executeCommand('claudeReview.acceptAll');
  await waitForHunks('b.txt', 0);
  await waitForHunks('created.txt', 0);
});

it('a v0.2 baseline file is picked up', async () => {
  fs.writeFileSync(file('legacy.txt'), 'new content\n');
  const name = Buffer.from(file('legacy.txt')).toString('base64url') + '.json';
  fs.writeFileSync(path.join(api.baselineDir, name), JSON.stringify({ path: file('legacy.txt'), existed: true, content: 'old content\n', createdAt: Date.now() }));
  await waitForHunks('legacy.txt', 1);
  await vscode.commands.executeCommand('claudeReview.acceptFile', uriOf('legacy.txt'));
  await waitForHunks('legacy.txt', 0);
});

it('navigation commands walk across files', async () => {
  fs.writeFileSync(file('n1.txt'), 'a\nb\nc\nd\ne\n');
  fs.writeFileSync(file('n2.txt'), 'a\nb\n');
  claudeWrites('n1.txt', 'A\nb\nc\nd\nE\n');
  claudeWrites('n2.txt', 'a\nB\n');
  await waitForHunks('n1.txt', 2);
  await waitForHunks('n2.txt', 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('claudeReview.nextHunk');
  await waitFor('n1 open', () => vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.fsPath.endsWith('n1.txt'));
  assert.equal(vscode.window.activeTextEditor.selection.active.line, 0);
  await vscode.commands.executeCommand('claudeReview.nextHunk');
  assert.equal(vscode.window.activeTextEditor.selection.active.line, 4);
  await vscode.commands.executeCommand('claudeReview.nextHunk');
  await waitFor('n2 open', () => vscode.window.activeTextEditor.document.uri.fsPath.endsWith('n2.txt'));
  assert.equal(vscode.window.activeTextEditor.selection.active.line, 1);
  await vscode.commands.executeCommand('claudeReview.openChanges');
  await vscode.commands.executeCommand('claudeReview.acceptAll');
  await waitForHunks('n1.txt', 0);
});

/** Puts the state a skipped test would have left behind, so later tests see what they expect. */
async function restoreAfterSkip(name) {
  if (name.startsWith('Ctrl+Z')) {
    const ed = vscode.window.activeTextEditor;
    claudeWrites('a.txt', '// one\nTWO!\nthree\nfour\n');
    await waitForDocText(ed.document, '// one\nTWO!\nthree\nfour\n');
    await waitForHunks('a.txt', 1);
  }
}

async function run() {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'claude-inline-review');
  assert.ok(ext, 'extension is loaded');
  api = await ext.activate();
  // A freshly started editor takes a moment before its file watcher reports
  // changes on disk; until then an external write never reaches an open document.
  fs.writeFileSync(file('warmup.txt'), 'a\n');
  const warm = (await openEditor('warmup.txt')).document;
  const warmStart = Date.now();
  await waitFor('the file watcher to start', async () => {
    fs.writeFileSync(file('warmup.txt'), `tick ${Date.now()}\n`);
    await sleep(500);
    return warm.getText().startsWith('tick');
  }, 120000);
  console.log(`  (file watcher ready after ${Date.now() - warmStart} ms)`);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const failures = [];
  const skipped = [];
  for (const t of tests) {
    const started = Date.now();
    try {
      const result = await t.fn();
      if (typeof result === 'string' && result.startsWith('skipped')) {
        skipped.push(t.name);
        console.log(`  - ${t.name} (${result})`);
        await restoreAfterSkip(t.name);
        continue;
      }
      console.log(`  ✔ ${t.name} (${Date.now() - started} ms)`);
    } catch (e) {
      failures.push(t.name);
      console.log(`  ✖ ${t.name}\n      ${(e && e.stack) || e}`);
    }
  }
  console.log(`\n  ${tests.length - failures.length - skipped.length} passed, ${failures.length} failed, ${skipped.length} skipped`);
  if (failures.length) throw new Error(`${failures.length} end-to-end test(s) failed`);
}

module.exports = { run };
