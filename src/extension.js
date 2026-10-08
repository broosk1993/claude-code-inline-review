'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { splitLines, eolOf: eolOfText, diffLines, wordDiff } = require('./diff');
const model = require('./model');
const store = require('./store');
const setup = require('./setup');

/** @typedef {import('./diff').Hunk} Hunk */
/** @typedef {import('./store').Entry} Entry */
/**
 * One file's part in an undoable review action.
 * @typedef {{ key: string, path: string, entry: Entry | null, text: string | null, textAfter: string | null | undefined }} FileUndo
 * @typedef {{ label: string, files: FileUndo[] }} HistoryItem
 */

const BASE_SCHEME = 'claude-review-base';
// The hook writes a baseline before Claude's edit lands, so a baseline with
// no difference is normal for a moment, and for as long as a permission
// prompt waits. Only after this long is it treated as abandoned.
const STALE_MS = 10 * 60_000;
const WAITING_MS = 24 * 60 * 60_000;
// Rejecting a review this old restores a file to how it was back then; warn first.
const OLD_REVIEW_MS = 24 * 60 * 60_000;
const HISTORY_LIMIT = 50;
const IS_MAC = process.platform === 'darwin';
const { plural } = model;

// ---------- state ----------

/** @type {Map<string, Entry>} */
let entries = new Map();
/** Diff cache: key -> { baseline, text, hunks } */
const memo = new Map();
/** Disk reads of files that are not open: key -> { mtimeMs, size, text } */
const diskCache = new Map();
/** Open documents under review: key -> { version, text } as of their latest settled change */
const docState = new Map();
/** Files with something to review in this window: key -> { entry, hunks } */
let pending = new Map();
const announced = new Set();
/** @type {HistoryItem[]} */
const history = [];
/** @type {{ key: string, file: FileUndo, item: HistoryItem, entryAfter: Entry | null } | null} */
let redoCandidate = null;
/** Edits the extension itself is applying, per document key. */
const ownEdits = new Map();
const isOwn = (key) => (ownEdits.get(key) || 0) > 0;
/** Whether the installed hook reports landed writes (PostToolUse); decides how long an empty review waits. */
let hookReportsLanding = false;
let initialized = false;
/** @type {string[]} */
let workspaceRoots = [];
const threads = new Map(); // key -> Map(threadKey -> CommentThread)
const threadInfo = new WeakMap(); // CommentThread -> { key, bStart }
const contextCache = new Map();

/** @type {any} */
const ui = {};
/** @type {vscode.LogOutputChannel} */
let log;

function cfg(name, fallback) {
  return vscode.workspace.getConfiguration('claudeReview').get(name, fallback);
}

function setContext(name, value) {
  const prev = contextCache.get(name);
  const same = Array.isArray(value) ? JSON.stringify(prev) === JSON.stringify(value) : prev === value;
  if (same) return;
  contextCache.set(name, value);
  vscode.commands.executeCommand('setContext', name, value);
}

// ---------- files and texts ----------

/** @param {vscode.Uri} uri */
function keyOfUri(uri) {
  if (uri.scheme === 'file') return store.keyOf(uri.fsPath);
  if (uri.scheme === BASE_SCHEME) return new URLSearchParams(uri.query).get('k') || store.keyOf(uri.path);
  return undefined;
}

function openDoc(key) {
  return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && !d.isClosed && store.keyOf(d.uri.fsPath) === key);
}

function readDisk(key, fsPath) {
  let stat;
  try {
    stat = fs.statSync(fsPath);
  } catch {
    diskCache.delete(key);
    return null;
  }
  const hit = diskCache.get(key);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text;
  let text;
  try {
    text = fs.readFileSync(fsPath, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
  diskCache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, text });
  return text;
}

/** The file as it is now: the open document if there is one, else the disk. '' for a file that was deleted. */
function currentText(entry) {
  const doc = openDoc(entry.key);
  if (doc) return doc.getText();
  const text = readDisk(entry.key, entry.path);
  if (text !== null) return text;
  return entry.existed ? '' : null;
}

/** @returns {Hunk[]} */
function hunksOf(entry) {
  const text = currentText(entry);
  if (text === null) return [];
  const hit = memo.get(entry.key);
  if (hit && hit.baseline === entry.content && hit.text === text) return hit.hunks;
  const hunks = diffLines(splitLines(entry.content), splitLines(text));
  memo.set(entry.key, { baseline: entry.content, text, hunks });
  return hunks;
}

function hunksForKey(key) {
  const entry = entries.get(key);
  return entry ? hunksOf(entry) : [];
}

function eolFor(entry) {
  const doc = openDoc(entry.key);
  if (doc) return doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const text = currentText(entry);
  return eolOfText(text || entry.content);
}

function inWorkspace(key) {
  return workspaceRoots.some((root) => key === root || key.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
}

/** Files this window reviews: inside its folders, or open in it. */
function inScope(key) {
  return inWorkspace(key) || !!openDoc(key);
}

function fileUri(entry) {
  return vscode.Uri.file(entry.path);
}

function baseUri(entry) {
  return vscode.Uri.from({ scheme: BASE_SCHEME, path: fileUri(entry).path, query: 'k=' + encodeURIComponent(entry.key) });
}

function sortedPendingKeys() {
  return [...pending.keys()].sort((a, b) => a.localeCompare(b));
}

// ---------- baselines ----------

function reloadEntries() {
  const next = store.loadEntries();
  // Keep in-memory objects where nothing changed, so caches stay warm.
  for (const [key, entry] of next) {
    const prev = entries.get(key);
    if (prev && prev.content === entry.content && prev.jsonPath === entry.jsonPath) next.set(key, prev);
  }
  entries = next;
}

function saveBaseline(entry, content) {
  entry.content = content;
  store.writeEntry(entry);
  entries.set(entry.key, entry);
}

function dropEntry(entry) {
  store.removeEntry(entry);
  if (entries.get(entry.key) === entry) entries.delete(entry.key);
  memo.delete(entry.key);
}

function restoreEntry(snapshot) {
  const entry = { ...snapshot };
  store.writeEntry(entry);
  entries.set(entry.key, entry);
  return entry;
}

// ---------- your own edits ----------

function rememberDoc(doc) {
  if (doc.uri.scheme !== 'file') return;
  const key = store.keyOf(doc.uri.fsPath);
  if (unsure.has(key)) return; // keep the text from before the undecided changes
  if (!entries.has(key)) {
    docState.delete(key);
    return;
  }
  docState.set(key, { version: doc.version, text: doc.getText() });
}

/** Applies a change event's edits (ranges against the text before) to a text. */
function applyChanges(text, changes) {
  for (const c of [...changes].sort((x, y) => y.rangeOffset - x.rangeOffset)) {
    text = text.slice(0, c.rangeOffset) + c.text + text.slice(c.rangeOffset + c.rangeLength);
  }
  return text;
}

/**
 * Your edits go into the baseline, so they never show as Claude's. Applies
 * the events in order, each against the text it was made on.
 * @param {Entry} entry
 * @param {string} text the document text before the first event
 * @param {{ changes: readonly vscode.TextDocumentContentChangeEvent[], user: boolean }[]} events
 */
function absorbEvents(entry, text, events, eol) {
  let baseline = entry.content;
  for (const ev of events) {
    if (ev.user) {
      const hunks = diffLines(splitLines(baseline), splitLines(text));
      const next = model.absorbUserEdits(baseline, hunks, ev.changes, eol);
      if (next !== null) baseline = next;
    }
    text = applyChanges(text, ev.changes);
  }
  if (baseline !== entry.content) saveBaseline(entry, baseline);
}

// Who made a change? Typing, pasting, undo and redo make the document dirty;
// a reload from disk (Claude, a formatter run from a shell, git) leaves it
// clean. But the first keystroke on a clean document arrives with isDirty
// still false, and the dirty flag follows in an event of its own. So a clean
// change waits briefly: if the dirty event comes, it was you; if not, it was
// a reload.
const UNSURE_MS = 150;
/** key -> { baseVersion, baseText, events, timer } */
const unsure = new Map();

function settleUnsure(key, doc, dirty) {
  const q = unsure.get(key);
  if (!q) return;
  unsure.delete(key);
  clearTimeout(q.timer);
  const entry = entries.get(key);
  if (entry && q.baseVersion === q.firstVersion - 1) {
    const disk = readDisk(key, doc.uri.fsPath);
    let text = q.baseText;
    if (dirty) {
      // A change whose result is exactly the file on disk is the reload, even
      // when your typing right after it made the document dirty.
      for (const ev of q.events) {
        text = applyChanges(text, ev.changes);
        ev.user = !ev.own && text !== disk;
      }
    } else {
      // Still clean: a reload, but only if it really produced the disk
      // content. If the extension host stalled past the timer, a keystroke can
      // get here before its dirty flag does.
      for (const ev of q.events) text = applyChanges(text, ev.changes);
      for (const ev of q.events) ev.user = !ev.own && text !== disk;
    }
    absorbEvents(entry, q.baseText, q.events, eolOfDoc(doc));
  }
  afterDocChange(doc);
}

function eolOfDoc(doc) {
  return doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

/** @param {vscode.TextDocumentChangeEvent} e */
function onDocChange(e) {
  const doc = e.document;
  if (doc.uri.scheme !== 'file') return;
  const key = store.keyOf(doc.uri.fsPath);
  if (e.contentChanges.length === 0) {
    // The dirty flag changed.
    if (unsure.has(key) && doc.isDirty) settleUnsure(key, doc, true);
    return;
  }
  diskCache.delete(key);

  const q = unsure.get(key);
  if (q) {
    q.events.push({ changes: e.contentChanges, own: isOwn(key), user: false });
    if (doc.isDirty && !isOwn(key)) settleUnsure(key, doc, true);
    return;
  }

  const own = isOwn(key);
  if (!own && e.reason === vscode.TextDocumentChangeReason.Undo && undoneInEditor(key, doc)) return afterDocChange(doc);
  if (!own && e.reason === vscode.TextDocumentChangeReason.Redo && redoneInEditor(key, doc)) return afterDocChange(doc);

  const entry = entries.get(key);
  if (!entry) return;
  const prev = docState.get(key);
  log.trace(`change in ${path.basename(doc.uri.fsPath)}: reason=${e.reason} dirty=${doc.isDirty} own=${own} v${doc.version} (settled v${prev && prev.version})`);
  if (own || !prev || prev.version !== doc.version - 1) return afterDocChange(doc);

  if (e.reason !== undefined || doc.isDirty) {
    absorbEvents(entry, prev.text, [{ changes: e.contentChanges, user: true }], eolOfDoc(doc));
    return afterDocChange(doc);
  }
  unsure.set(key, {
    baseVersion: prev.version,
    baseText: prev.text,
    firstVersion: doc.version,
    events: [{ changes: e.contentChanges, own: false, user: false }],
    timer: setTimeout(() => settleUnsure(key, doc, doc.isDirty), UNSURE_MS),
  });
}

function afterDocChange(doc) {
  rememberDoc(doc);
  scheduleRefresh();
}

/**
 * Ctrl+Z right after a reject puts Claude's text back. Bring back the review
 * the reject resolved, instead of taking the restored text as your own edit.
 */
function undoneInEditor(key, doc) {
  const text = doc.getText();
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    const file = item.files.find((f) => f.key === key && f.text !== null);
    if (!file) continue;
    if (file.text !== text) return false;
    redoCandidate = { key, file, item, entryAfter: store.snapshot(entries.get(key) || null) };
    item.files = item.files.filter((f) => f !== file);
    if (item.files.length === 0) history.splice(i, 1);
    if (file.entry) restoreEntry(file.entry);
    log.info(`Undo in editor brought back the review of ${file.path}`);
    return true;
  }
  return false;
}

function redoneInEditor(key, doc) {
  const c = redoCandidate;
  if (!c || c.key !== key || c.file.textAfter !== doc.getText()) return false;
  redoCandidate = null;
  const current = entries.get(key);
  if (c.entryAfter) restoreEntry(c.entryAfter);
  else if (current) dropEntry(current);
  c.item.files.push(c.file);
  if (!history.includes(c.item)) history.push(c.item);
  return true;
}

// ---------- refresh ----------

let refreshTimer = null;
let reloadWanted = false;

function scheduleRefresh(reload = false) {
  if (reload) reloadWanted = true;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshNow, 80);
}

function refreshNow() {
  clearTimeout(refreshTimer);
  if (reloadWanted) {
    reloadWanted = false;
    reloadEntries();
  }
  const now = Date.now();
  const next = new Map();
  for (const [key, entry] of entries) {
    if (!inScope(key)) continue;
    const hunks = hunksOf(entry);
    if (hunks.length === 0) {
      // Before Claude's write lands (a permission prompt can take a while)
      // an empty review is normal; only the hook's landed marker says it is done.
      const limit = entry.landedAt || !hookReportsLanding ? STALE_MS : WAITING_MS;
      if (now - Math.max(entry.createdAt, entry.landedAt || 0) > limit && fullyResolved(entry)) dropEntry(entry);
      continue;
    }
    next.set(key, { entry, hunks });
    if (!announced.has(key)) {
      announced.add(key);
      if (initialized) announce(entry);
    }
  }
  pending = next;
  for (const key of [...announced]) if (!pending.has(key)) announced.delete(key);
  for (const key of [...memo.keys()]) if (!entries.has(key)) memo.delete(key);
  for (const doc of vscode.workspace.textDocuments) rememberDoc(doc);
  initialized = true;
  render();
}

/** Opens a file Claude just started changing, without taking focus. */
function announce(entry) {
  if (!cfg('revealOnEdit', false)) return;
  if (vscode.window.visibleTextEditors.some((ed) => ed.document.uri.scheme === 'file' && store.keyOf(ed.document.uri.fsPath) === entry.key)) return;
  vscode.window.showTextDocument(fileUri(entry), { preview: true, preserveFocus: true }).then(undefined, () => {});
}

function render() {
  for (const ed of vscode.window.visibleTextEditors) decorate(ed);
  syncThreads();
  ui.codeLensChanged.fire();
  ui.fileDecorationsChanged.fire(undefined);
  for (const doc of vscode.workspace.textDocuments) if (doc.uri.scheme === BASE_SCHEME) ui.baseChanged.fire(doc.uri);
  ui.tree.changed.fire(undefined);
  updateStatus();
  updateContext();
}

// ---------- editor decorations ----------

function hoverFor(doc, h) {
  if (!cfg('showHover', true)) return undefined;
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: ['claudeReview.acceptHunk', 'claudeReview.rejectHunk', 'claudeReview.showDiff'] };
  const u = doc.uri.toString();
  const args = encodeURIComponent(JSON.stringify([u, h.bStart]));
  const keys = keyHints();
  md.appendMarkdown(
    `[$(check) Accept](command:claudeReview.acceptHunk?${args} "Keep this change (${keys.accept})") &nbsp;·&nbsp; ` +
      `[$(discard) Reject](command:claudeReview.rejectHunk?${args} "Undo this change (${keys.reject})") &nbsp;·&nbsp; ` +
      `[$(diff) Diff](command:claudeReview.showDiff?${encodeURIComponent(JSON.stringify([u]))} "Open the before/after diff")`
  );
  if (h.aLines.length) {
    md.appendMarkdown(`\n\n**Before Claude** — ${plural(h.aLines.length, 'line')}:\n`);
    md.appendCodeblock(truncateLines(h.aLines).join('\n'), doc.languageId);
  }
  return md;
}

function truncateLines(lines) {
  const max = Math.max(5, cfg('maxRemovedLinesShown', 60));
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `… ${lines.length - max} more lines (open the diff to see them)`];
}

/** Word-level ranges worth highlighting inside a changed block, relative to its first line. */
function wordRanges(h) {
  if (h._words !== undefined) return h._words;
  let out = [];
  const wd = h.aLines.length && h.bLines.length ? wordDiff(h.aLines, h.bLines) : null;
  // When most of the block is new, the line background already says it all.
  if (wd && wd.addedRatio <= 0.7) {
    out = wd.added.filter((r) => {
      const text = h.bLines[r.line];
      const first = text.length - text.trimStart().length;
      const last = text.trimEnd().length;
      return !(r.start <= first && r.end >= last);
    });
  }
  Object.defineProperty(h, '_words', { value: out, enumerable: false });
  return out;
}

/** @param {vscode.TextEditor} editor */
function decorate(editor) {
  const doc = editor.document;
  if (doc.uri.scheme !== 'file') return;
  const key = store.keyOf(doc.uri.fsPath);
  const entry = entries.get(key);
  const hunks = entry && inScope(key) ? hunksOf(entry) : [];
  const added = [];
  const words = [];
  const top = [];
  const bottom = [];
  const last = Math.max(0, doc.lineCount - 1);
  const showWords = cfg('highlightWordChanges', true);
  const hintRemoved = !cfg('showRemovedInline', true);

  for (const h of hunks) {
    const hover = hoverFor(doc, h);
    for (let k = 0; k < h.bLines.length && h.bStart + k <= last; k++) {
      added.push({ range: new vscode.Range(h.bStart + k, 0, h.bStart + k, 0), hoverMessage: hover });
    }
    if (showWords) {
      for (const r of wordRanges(h)) {
        const line = h.bStart + r.line;
        if (line <= last) words.push(new vscode.Range(line, r.start, line, r.end));
      }
    }
    if (h.bLines.length === 0) {
      const opts = { hoverMessage: hover };
      if (hintRemoved) {
        opts.renderOptions = { after: { contentText: `  − ${plural(h.aLines.length, 'line')} removed` } };
      }
      // A red rule where the lines used to be: above the line that now
      // follows them, or below the last line when they were at the end.
      const atEnd = h.bStart > last || (h.bStart === last && last > 0 && doc.lineAt(last).text === '');
      if (!atEnd) top.push({ ...opts, range: new vscode.Range(h.bStart, 0, h.bStart, 0) });
      else bottom.push({ ...opts, range: new vscode.Range(h.bStart > last ? last : last - 1, 0, h.bStart > last ? last : last - 1, 0) });
    }
  }
  editor.setDecorations(ui.addedLine, added);
  editor.setDecorations(ui.addedWord, words);
  editor.setDecorations(ui.removedAbove, top);
  editor.setDecorations(ui.removedBelow, bottom);
}

// ---------- removed code, drawn inline ----------

function removedBody(h) {
  const md = new vscode.MarkdownString();
  const body = truncateLines(h.aLines)
    .map((l) => '- ' + l.replace(/```/g, '``\u200b`'))
    .join('\n');
  md.appendCodeblock(body, 'diff');
  return md;
}

function syncThreads() {
  const wanted = new Map();
  if (cfg('showRemovedInline', true)) {
    for (const [key, { hunks }] of pending) {
      const m = new Map();
      for (const h of hunks) if (h.aLines.length) m.set(`${h.bStart}|${h.bLines.length}|${h.aLines.join('\n')}`, h);
      wanted.set(key, m);
    }
  }
  for (const [key, tmap] of threads) {
    const w = wanted.get(key);
    for (const [k, t] of tmap) {
      if (!w || !w.has(k)) {
        t.dispose();
        tmap.delete(k);
      }
    }
    if (!tmap.size) threads.delete(key);
  }
  for (const [key, w] of wanted) {
    let tmap = threads.get(key);
    if (!tmap) threads.set(key, (tmap = new Map()));
    const entry = entries.get(key);
    for (const [k, h] of w) {
      if (tmap.has(k)) continue;
      // The widget appears below its anchor line, i.e. where the old code was.
      const line = Math.max(0, h.bStart - 1);
      const n = h.aLines.length;
      const t = ui.comments.createCommentThread(fileUri(entry), new vscode.Range(line, 0, line, 0), [
        {
          body: removedBody(h),
          mode: vscode.CommentMode.Preview,
          author: { name: h.bLines.length ? `Replaced by Claude · ${plural(n, 'line')}` : `Removed by Claude · ${plural(n, 'line')}` },
          contextValue: 'claudeRemoved',
        },
      ]);
      t.canReply = false;
      t.label = 'Before Claude';
      t.contextValue = 'claudeHunk';
      t.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      threadInfo.set(t, { key, bStart: h.bStart });
      tmap.set(k, t);
    }
  }
}

// ---------- CodeLens ----------

function keyHints() {
  if (cfg('cursorStyleKeybindings', true)) return IS_MAC ? { accept: '⌘Y', reject: '⌘N' } : { accept: 'Ctrl+Y', reject: 'Ctrl+N' };
  return IS_MAC ? { accept: '⌘⌥↵', reject: '⌘⌥⌫' } : { accept: 'Ctrl+Alt+Enter', reject: 'Ctrl+Alt+Backspace' };
}

const codeLensProvider = {
  /** @param {vscode.TextDocument} doc */
  provideCodeLenses(doc) {
    if (doc.uri.scheme !== 'file' || !cfg('showCodeLens', true)) return [];
    const key = store.keyOf(doc.uri.fsPath);
    const p = pending.get(key);
    if (!p) return [];
    const hunks = hunksOf(p.entry);
    if (!hunks.length) return [];
    const u = doc.uri.toString();
    const last = Math.max(0, doc.lineCount - 1);
    const keys = keyHints();
    const t = model.totals(hunks);
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses = [
      new vscode.CodeLens(top, {
        title: `$(sparkle) Claude: ${plural(hunks.length, 'change')}  −${t.removed} +${t.added}`,
        tooltip: 'Go to the next change',
        command: 'claudeReview.nextHunk',
      }),
      new vscode.CodeLens(top, { title: '$(check-all) Accept file', command: 'claudeReview.acceptFile', arguments: [u] }),
      new vscode.CodeLens(top, { title: '$(close-all) Reject file', command: 'claudeReview.rejectFile', arguments: [u] }),
      new vscode.CodeLens(top, { title: '$(diff) Diff', command: 'claudeReview.showDiff', arguments: [u] }),
    ];
    for (const h of hunks) {
      const r = new vscode.Range(Math.min(h.bStart, last), 0, Math.min(h.bStart, last), 0);
      lenses.push(
        new vscode.CodeLens(r, { title: `$(check) Accept ${keys.accept}`, tooltip: 'Keep this change', command: 'claudeReview.acceptHunk', arguments: [u, h.bStart] }),
        new vscode.CodeLens(r, { title: `$(discard) Reject ${keys.reject}`, tooltip: 'Undo this change', command: 'claudeReview.rejectHunk', arguments: [u, h.bStart] }),
        new vscode.CodeLens(r, { title: model.hunkStat(h), tooltip: 'Open the before/after diff', command: 'claudeReview.showDiff', arguments: [u] })
      );
    }
    return lenses;
  },
};

// ---------- status bar and context keys ----------

function activeFileEditor() {
  const ed = vscode.window.activeTextEditor;
  return ed && ed.document.uri.scheme === 'file' ? ed : undefined;
}

function updateStatus() {
  const keys = sortedPendingKeys();
  const total = keys.reduce((s, k) => s + pending.get(k).hunks.length, 0);
  if (!total) {
    for (const item of ui.status) item.hide();
    ui.treeView.badge = undefined;
    return;
  }
  ui.summary.text = `$(sparkle) ${plural(total, 'change')}` + (keys.length > 1 ? ` · ${keys.length} files` : '');
  ui.summary.tooltip = `Claude changes waiting for review in ${plural(keys.length, 'file')}. Click to list them.`;
  ui.summary.show();
  ui.treeView.badge = { value: total, tooltip: `${plural(total, 'Claude change')} to review` };

  const ed = activeFileEditor();
  const key = ed && store.keyOf(ed.document.uri.fsPath);
  const p = key && pending.get(key);
  if (!p) {
    for (const item of ui.fileStatus) item.hide();
    return;
  }
  const hunks = hunksOf(p.entry);
  const line = ed.selection.active.line;
  const at = model.hunkAtLine(hunks, line);
  const fileIndex = keys.indexOf(key) + 1;
  ui.position.text = at ? `${hunks.indexOf(at) + 1} of ${hunks.length}` : plural(hunks.length, 'change');
  ui.position.tooltip = keys.length > 1 ? `File ${fileIndex} of ${keys.length}` : 'Next change';
  for (const item of ui.fileStatus) item.show();
}

function updateContext() {
  const keys = sortedPendingKeys();
  setContext('claudeReview.hasChanges', keys.length > 0);
  setContext(
    'claudeReview.files',
    keys.map((k) => pending.get(k).entry.path)
  );
  updateCursorContext();
}

function updateCursorContext() {
  const ed = activeFileEditor();
  const key = ed && store.keyOf(ed.document.uri.fsPath);
  const p = key && pending.get(key);
  setContext('claudeReview.activeFileHasChanges', !!p);
  setContext('claudeReview.cursorInChange', !!(p && model.hunkAtLine(hunksOf(p.entry), ed.selection.active.line)));
}

// ---------- the Claude Changes view ----------

const tree = {
  changed: new vscode.EventEmitter(),
  get onDidChangeTreeData() {
    return this.changed.event;
  },
  getChildren(node) {
    if (!node) return sortedPendingKeys().map((key) => ({ kind: 'file', key }));
    if (node.kind === 'file') {
      const p = pending.get(node.key);
      return p ? hunksOf(p.entry).map((h) => ({ kind: 'hunk', key: node.key, bStart: h.bStart, hunk: h })) : [];
    }
    return [];
  },
  getParent(node) {
    return node.kind === 'hunk' ? { kind: 'file', key: node.key } : undefined;
  },
  getTreeItem(node) {
    const p = pending.get(node.key);
    const entry = p ? p.entry : entries.get(node.key);
    if (node.kind === 'file') {
      const hunks = p ? hunksOf(p.entry) : [];
      const item = new vscode.TreeItem(fileUri(entry), vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'file:' + node.key;
      const t = model.totals(hunks);
      const dir = vscode.workspace.asRelativePath(path.dirname(entry.path), false);
      item.description = `${dir && dir !== path.dirname(entry.path) ? dir + '  ' : ''}−${t.removed} +${t.added}`;
      item.tooltip = `${entry.path}\n${plural(hunks.length, 'change')}${entry.existed ? '' : ' · new file'} · review started ${age(Date.now() - entry.createdAt)} ago`;
      item.contextValue = entry.existed ? 'claudeReview.file' : 'claudeReview.newFile';
      item.command = { command: 'claudeReview.openFile', title: 'Open', arguments: [node.key] };
      return item;
    }
    const h = node.hunk;
    const label = h.bLines.length
      ? h.bLines.length === 1
        ? `Line ${h.bStart + 1}`
        : `Lines ${h.bStart + 1}–${h.bStart + h.bLines.length}`
      : `Removed at line ${h.bStart + 1}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    const sample = [...h.bLines, ...h.aLines].find((l) => l.trim()) || '';
    item.description = `${model.hunkStat(h)}  ${sample.trim().slice(0, 80)}`;
    item.iconPath = new vscode.ThemeIcon(h.aLines.length === 0 ? 'diff-added' : h.bLines.length === 0 ? 'diff-removed' : 'diff-modified');
    const md = new vscode.MarkdownString();
    md.appendCodeblock(
      [...truncateLines(h.aLines).map((l) => '- ' + l), ...truncateLines(h.bLines).map((l) => '+ ' + l)].join('\n'),
      'diff'
    );
    item.tooltip = md;
    item.contextValue = 'claudeReview.hunk';
    item.command = { command: 'claudeReview.revealHunk', title: 'Show', arguments: [node.key, h.bStart] };
    return item;
  },
};

// ---------- resolving command arguments ----------

/** File key from: nothing (active editor), a URI string, a Uri, a tree node, or a key. */
function fileKeyFrom(arg) {
  if (arg === undefined || arg === null) {
    const ed = activeFileEditor();
    return ed ? store.keyOf(ed.document.uri.fsPath) : undefined;
  }
  if (typeof arg === 'string') {
    if (entries.has(arg)) return arg;
    return /^[a-z][\w+.-]*:/i.test(arg) && !/^[a-z]:[\\/]/i.test(arg) ? keyOfUri(vscode.Uri.parse(arg)) : store.keyOf(arg);
  }
  if (arg instanceof vscode.Uri) return keyOfUri(arg);
  if (arg.kind && arg.key) return arg.key;
  if (arg.resourceUri instanceof vscode.Uri) return keyOfUri(arg.resourceUri);
  if (arg.uri instanceof vscode.Uri) return keyOfUri(arg.uri);
  return undefined;
}

/** The hunk a command is about: a tree node, a comment thread, (uri, bStart), or the cursor. */
function hunkFrom(arg, bStart) {
  let key;
  let match;
  const thread = arg && arg.thread ? arg.thread : arg;
  if (arg && arg.kind === 'hunk') {
    key = arg.key;
    match = (h) => h.bStart === arg.bStart;
  } else if (thread && typeof thread === 'object' && threadInfo.has(thread)) {
    const info = threadInfo.get(thread);
    key = info.key;
    match = (h) => h.bStart === info.bStart;
  } else if (arg !== undefined && typeof bStart === 'number') {
    key = fileKeyFrom(arg);
    match = (h) => h.bStart === bStart;
  } else {
    const ed = activeFileEditor();
    if (!ed) return null;
    key = store.keyOf(ed.document.uri.fsPath);
    const line = ed.selection.active.line;
    match = (h, all) => h === model.hunkAtLine(all, line);
  }
  const entry = key && entries.get(key);
  if (!entry) return null;
  const hunks = hunksOf(entry);
  const hunk = hunks.find((h) => match(h, hunks));
  return hunk ? { key, entry, hunk, hunks } : null;
}

function note(text) {
  vscode.window.setStatusBarMessage(text, 3000);
}

// ---------- writing files ----------

/** The file's text as you see it: the document while it is live, else the disk (null if the file is gone). */
function liveText(key, fsPath) {
  const doc = openDoc(key);
  if (doc && (doc.isDirty || fs.existsSync(fsPath))) return doc.getText();
  return readDisk(key, fsPath);
}

async function writeFileText(fsPath, text) {
  const key = store.keyOf(fsPath);
  // A document whose file was deleted lingers after its tab closes; recreate
  // the file on disk and let the editor reload it.
  const doc = fs.existsSync(fsPath) ? openDoc(key) : undefined;
  if (doc) {
    const edit = model.minimalEdit(doc.getText(), text);
    if (edit) {
      const we = new vscode.WorkspaceEdit();
      we.replace(doc.uri, new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end)), edit.text);
      // Only this edit is ours. Edits made while saving (format on save,
      // fix-all) are treated like yours: absorbed when outside Claude's changes.
      ownEdits.set(key, (ownEdits.get(key) || 0) + 1);
      let applied;
      try {
        applied = await vscode.workspace.applyEdit(we);
      } finally {
        ownEdits.set(key, ownEdits.get(key) - 1);
        if (!ownEdits.get(key)) ownEdits.delete(key);
      }
      if (!applied) throw new Error(`The editor refused the edit to ${path.basename(fsPath)}.`);
    }
    if (cfg('saveAfterReject', true) && doc.isDirty && !(await doc.save())) {
      throw new Error(`Could not save ${path.basename(fsPath)}; the review stays open until it is saved.`);
    }
  } else {
    let bom = false;
    try {
      const fd = fs.openSync(fsPath, 'r');
      const head = Buffer.alloc(3);
      fs.readSync(fd, head, 0, 3, 0);
      fs.closeSync(fd);
      bom = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
    } catch {
      /* new file */
    }
    await vscode.workspace.fs.writeFile(vscode.Uri.file(fsPath), Buffer.from((bom ? '\uFEFF' : '') + text, 'utf8'));
  }
  diskCache.delete(key);
  store.forgetPath(fsPath);
}

function fileUndo(entry, textBefore = null) {
  return { key: entry.key, path: entry.path, entry: store.snapshot(entry), text: textBefore, textAfter: undefined };
}

/** @returns {HistoryItem | null} */
function record(label, files) {
  if (!files.length) return null;
  const item = { label, files };
  history.push(item);
  while (history.length > HISTORY_LIMIT) history.shift();
  redoCandidate = null;
  return item;
}

function forget(item) {
  const i = history.indexOf(item);
  if (i >= 0) history.splice(i, 1);
}

/**
 * Nothing left to review, in the editor *and* on disk. An unsaved document can
 * show a review as done while the disk still has Claude's text (the save
 * failed, or saving after reject is off); keep the review until the disk agrees.
 */
function fullyResolved(entry) {
  if (hunksOf(entry).length) return false;
  const doc = openDoc(entry.key);
  if (!doc || !doc.isDirty) return true;
  const disk = readDisk(entry.key, entry.path);
  return disk === null ? !entry.existed : diffLines(splitLines(entry.content), splitLines(disk)).length === 0;
}

/** Drops a file's review once nothing is left in it. */
function settle(key) {
  const entry = entries.get(key);
  if (entry && fullyResolved(entry)) dropEntry(entry);
}

function age(ms) {
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/** Asks before rejecting reviews old enough that the file may have changed for other reasons since. */
async function confirmOld(targets) {
  const old = targets.filter((e) => e.existed && Date.now() - e.createdAt > OLD_REVIEW_MS);
  if (!old.length) return true;
  const oldest = Math.max(...old.map((e) => Date.now() - e.createdAt));
  const ok = await vscode.window.showWarningMessage(
    old.length === 1
      ? `The review of ${path.basename(old[0].path)} started ${age(oldest)} ago.`
      : `${plural(old.length, 'review')} started up to ${age(oldest)} ago.`,
    {
      modal: true,
      detail:
        'Rejecting restores the file to how it was before Claude\'s first edit back then. Changes made since by other tools (git, formatters, another editor) would be undone too.',
    },
    'Reject anyway'
  );
  return ok === 'Reject anyway';
}

// ---------- actions ----------

async function acceptHunk(arg, bStart) {
  const t = hunkFrom(arg, bStart);
  if (!t) return note('No Claude change here. Put the cursor inside one.');
  record('Accept change', [fileUndo(t.entry)]);
  saveBaseline(t.entry, model.acceptHunkInBaseline(t.entry.content, t.hunk, eolFor(t.entry)));
  settle(t.key);
  refreshNow();
  moveToNextChange(t.key, t.hunk.bStart);
}

async function rejectHunk(arg, bStart) {
  const t = hunkFrom(arg, bStart);
  if (!t) return note('No Claude change here. Put the cursor inside one.');
  const before = currentText(t.entry);
  if (before === null) return;
  const after = model.rejectHunkInText(before, t.hunk, eolFor(t.entry));
  const undo = fileUndo(t.entry, before);
  undo.textAfter = after;
  const item = record('Reject change', [undo]);
  try {
    await writeFileText(t.entry.path, after);
  } catch (e) {
    // Keep the undo record if the edit itself went in (only the save failed).
    if (liveText(t.key, t.entry.path) === before) forget(item);
    refreshNow();
    return vscode.window.showErrorMessage(String(e.message || e));
  }
  settle(t.key);
  refreshNow();
  moveToNextChange(t.key, t.hunk.bStart + t.hunk.aLines.length);
}

/** Cursor-style flow: after a decision, the cursor goes to the next change in the file. */
function moveToNextChange(key, fromLine) {
  if (!cfg('jumpToNextChange', true)) return;
  const ed = activeFileEditor();
  if (!ed || store.keyOf(ed.document.uri.fsPath) !== key) return;
  const hunks = hunksForKey(key);
  if (!hunks.length) {
    const left = pending.size;
    note(left ? `File reviewed ✓ — ${plural(left, 'file')} left` : 'All Claude changes reviewed ✓');
    return;
  }
  const next = hunks.find((h) => h.bStart >= fromLine) || hunks[0];
  reveal(ed, next.bStart);
}

async function acceptFile(arg) {
  const key = fileKeyFrom(arg);
  const entry = key && entries.get(key);
  if (!entry) return note('No Claude changes in this file.');
  record('Accept file', [fileUndo(entry)]);
  dropEntry(entry);
  refreshNow();
}

/** @returns {Promise<FileUndo | null>} what was done, or null if nothing was */
async function rejectEntry(entry, confirmDelete) {
  const before = currentText(entry);
  const undo = fileUndo(entry, before);
  if (!entry.existed) {
    if (confirmDelete) {
      const ok = await vscode.window.showWarningMessage(
        `Claude created ${path.basename(entry.path)}. Rejecting it deletes the file.`,
        { modal: true },
        'Delete file'
      );
      if (ok !== 'Delete file') return null;
    }
    const uri = fileUri(entry);
    const doc = openDoc(entry.key);
    if (doc && doc.isDirty) await doc.save();
    try {
      await vscode.workspace.fs.delete(uri, { useTrash: true });
    } catch {
      await vscode.workspace.fs.delete(uri, { useTrash: false }).then(undefined, () => {});
    }
    if (fs.existsSync(entry.path)) throw new Error(`Could not delete ${path.basename(entry.path)}.`);
    // Like Cursor: a rejected new file goes away, tab included.
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.scheme === 'file' && store.keyOf(t.input.uri.fsPath) === entry.key);
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true).then(undefined, () => {});
    diskCache.delete(entry.key);
    undo.textAfter = null;
    dropEntry(entry);
  } else {
    await writeFileText(entry.path, entry.content);
    undo.textAfter = entry.content;
    settle(entry.key);
  }
  return undo;
}

async function rejectFile(arg) {
  const key = fileKeyFrom(arg);
  const entry = key && entries.get(key);
  if (!entry) return note('No Claude changes in this file.');
  if (!(await confirmOld([entry]))) return;
  try {
    const undo = await rejectEntry(entry, true);
    if (undo) record('Reject file', [undo]);
  } catch (e) {
    vscode.window.showErrorMessage(String(e.message || e));
  }
  refreshNow();
}

async function acceptAll() {
  const keys = sortedPendingKeys();
  if (!keys.length) return note('No Claude changes to accept.');
  const total = keys.reduce((s, k) => s + pending.get(k).hunks.length, 0);
  const undo = keys.map((k) => fileUndo(pending.get(k).entry));
  for (const k of keys) dropEntry(pending.get(k).entry);
  record('Accept all', undo);
  refreshNow();
  offerUndo(`Accepted ${plural(total, 'change')} in ${plural(keys.length, 'file')}.`);
}

async function rejectAll() {
  const keys = sortedPendingKeys();
  if (!keys.length) return note('No Claude changes to reject.');
  const total = keys.reduce((s, k) => s + pending.get(k).hunks.length, 0);
  // The map can change while a dialog is open (Claude edits, another window
  // accepts); hold on to what was asked about.
  const targets = keys.map((k) => pending.get(k).entry);
  if (cfg('confirmRejectAll', true)) {
    const created = targets.filter((e) => !e.existed).length;
    const ok = await vscode.window.showWarningMessage(
      `Undo ${plural(total, 'Claude change')} in ${plural(keys.length, 'file')}?` +
        (created ? ` ${plural(created, 'file')} Claude created will be deleted.` : ''),
      { modal: true, detail: 'You can bring them back with "Claude Review: Undo last review action".' },
      'Reject all'
    );
    if (ok !== 'Reject all') return;
  }
  if (!(await confirmOld(targets))) return;
  const undo = [];
  const failed = [];
  try {
    for (const target of targets) {
      const entry = entries.get(target.key);
      if (!entry) continue; // resolved elsewhere meanwhile
      try {
        const u = await rejectEntry(entry, false);
        if (u) undo.push(u);
      } catch (e) {
        failed.push(`${path.basename(target.path)}: ${e.message || e}`);
      }
    }
  } finally {
    record('Reject all', undo);
    refreshNow();
  }
  if (failed.length) vscode.window.showErrorMessage(`Could not reject: ${failed.join('; ')}`);
  else offerUndo(`Rejected ${plural(total, 'change')} in ${plural(keys.length, 'file')}.`);
}

function offerUndo(message) {
  vscode.window.showInformationMessage(message, 'Undo').then((pick) => pick === 'Undo' && undoLast());
}

async function undoLast() {
  const item = history.pop();
  redoCandidate = null;
  if (!item) return note('Nothing to undo.');
  const skipped = [];
  for (const f of item.files) {
    if (f.text !== null) {
      const now = liveText(f.key, f.path);
      if (f.textAfter !== undefined && now !== f.textAfter) {
        skipped.push(path.basename(f.path));
        continue;
      }
      if (now !== f.text) await writeFileText(f.path, f.text);
    }
    if (f.entry) restoreEntry(f.entry);
  }
  refreshNow();
  if (skipped.length) {
    vscode.window.showWarningMessage(`Undid "${item.label}" except in ${skipped.join(', ')}: changed since, so left as is.`);
  } else {
    note(`Undid "${item.label}"`);
  }
}

// ---------- navigation ----------

function reveal(ed, line) {
  const l = Math.max(0, Math.min(line, ed.document.lineCount - 1));
  const col = ed.document.lineAt(l).firstNonWhitespaceCharacterIndex;
  const pos = new vscode.Position(l, col);
  ed.selection = new vscode.Selection(pos, pos);
  ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  updateCursorContext();
  updateStatus();
}

async function openAt(key, which) {
  const entry = entries.get(key);
  if (!entry) return;
  const ed = await vscode.window.showTextDocument(fileUri(entry), { preview: false });
  const hunks = hunksForKey(key);
  if (!hunks.length) return;
  const h = typeof which === 'number' ? hunks.find((x) => x.bStart === which) || hunks[0] : which < 0 ? hunks[hunks.length - 1] : hunks[0];
  reveal(ed, h.bStart);
}

async function goToHunk(dir) {
  const keys = sortedPendingKeys();
  const ed = activeFileEditor();
  if (!keys.length) return note('All Claude changes reviewed ✓');
  if (!ed) return openAt(dir > 0 ? keys[0] : keys[keys.length - 1], dir);
  const key = store.keyOf(ed.document.uri.fsPath);
  const hunks = pending.has(key) ? hunksForKey(key) : [];
  const line = ed.selection.active.line;
  const target = dir > 0 ? hunks.find((h) => h.bStart > line) : [...hunks].reverse().find((h) => h.bStart < line);
  if (target) return reveal(ed, target.bStart);
  const others = keys.filter((k) => k !== key);
  if (!others.length) {
    if (hunks.length) return reveal(ed, (dir > 0 ? hunks[0] : hunks[hunks.length - 1]).bStart);
    return note('All Claude changes reviewed ✓');
  }
  const idx = keys.indexOf(key);
  const nextKey = idx === -1 ? (dir > 0 ? keys[0] : keys[keys.length - 1]) : keys[(idx + dir + keys.length) % keys.length];
  return openAt(nextKey, dir);
}

async function goToFile(dir) {
  const keys = sortedPendingKeys();
  if (!keys.length) return note('All Claude changes reviewed ✓');
  const ed = activeFileEditor();
  const idx = ed ? keys.indexOf(store.keyOf(ed.document.uri.fsPath)) : -1;
  const nextKey = idx === -1 ? keys[dir > 0 ? 0 : keys.length - 1] : keys[(idx + dir + keys.length) % keys.length];
  return openAt(nextKey, 1);
}

// ---------- diffs ----------

async function showDiff(arg) {
  const key = fileKeyFrom(arg);
  const entry = key && entries.get(key);
  if (!entry) return note('No Claude changes in this file.');
  await vscode.commands.executeCommand('vscode.diff', baseUri(entry), fileUri(entry), `${path.basename(entry.path)} (Before Claude ↔ Now)`, { preview: true });
}

async function openChanges() {
  const keys = sortedPendingKeys();
  if (!keys.length) return note('No Claude changes to review.');
  const resources = keys.map((k) => {
    const e = pending.get(k).entry;
    return [fileUri(e), baseUri(e), fileUri(e)];
  });
  try {
    await vscode.commands.executeCommand('vscode.changes', 'Claude Changes', resources);
  } catch (e) {
    log.warn(`Multi-file diff unavailable (${e.message || e}); opening the first file's diff`);
    await showDiff(keys[0]);
  }
}

async function listFiles() {
  const keys = sortedPendingKeys();
  if (!keys.length) return vscode.window.showInformationMessage('No Claude changes waiting for review.');
  /** @type {any[]} */
  const items = keys.map((k) => {
    const { entry, hunks } = pending.get(k);
    const t = model.totals(hunks);
    return {
      label: `$(file) ${path.basename(entry.path)}`,
      description: vscode.workspace.asRelativePath(entry.path),
      detail: `${plural(hunks.length, 'change')}  −${t.removed} +${t.added}${entry.existed ? '' : '  · new file'}`,
      key: k,
    };
  });
  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator, key: '' },
    { label: '$(diff-multiple) Open all changes in one diff', key: '__diff' },
    { label: '$(check-all) Accept all files', key: '__accept' },
    { label: '$(close-all) Reject all files…', key: '__reject' }
  );
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Claude changes to review', matchOnDescription: true });
  if (!pick || !pick.key) return;
  if (pick.key === '__diff') return openChanges();
  if (pick.key === '__accept') return acceptAll();
  if (pick.key === '__reject') return rejectAll();
  return openAt(pick.key, 1);
}

// ---------- Claude Code hook setup ----------

async function setupHook(context) {
  const bundled = context.asAbsolutePath(path.join('hook', setup.HOOK_FILE));
  const st = setup.status(bundled);
  if (st.settingsError) {
    return vscode.window.showErrorMessage(
      `Could not read ${setup.settingsPath()} (${st.settingsError}). Fix it, then run "Claude Review: Set up Claude Code hook" again.`
    );
  }
  let acceptEdits = false;
  if (st.defaultMode !== 'acceptEdits') {
    const pick = await vscode.window.showInformationMessage(
      'Let Claude Code apply edits without asking first?',
      {
        modal: true,
        detail:
          'Inline review works best in acceptEdits mode: Claude writes, and you accept or reject here. This sets permissions.defaultMode in your Claude Code settings (a backup is made). Bash commands still ask.',
      },
      'Use acceptEdits',
      'Keep my current mode'
    );
    if (!pick) return;
    acceptEdits = pick === 'Use acceptEdits';
  }
  try {
    const done = setup.install({ bundledHook: bundled, acceptEdits });
    for (const line of done) log.info(line);
    hookReportsLanding = true;
    vscode.window.showInformationMessage('Claude Code is connected. New Claude Code sessions will show their edits here for review.');
  } catch (e) {
    vscode.window.showErrorMessage(`Setup failed: ${e.message || e}`);
  }
}

/** Keeps an installed hook in step with this extension, and offers setup once when there is none. */
function checkHook(context) {
  const bundled = context.asAbsolutePath(path.join('hook', setup.HOOK_FILE));
  let st;
  try {
    st = setup.status(bundled);
  } catch (e) {
    log.warn(`Hook check failed: ${e.message || e}`);
    return;
  }
  hookReportsLanding = st.complete;
  if (st.outdated) {
    try {
      setup.installHookScript(bundled);
      log.info(`Updated the Claude Code hook from ${st.installedVersion} to ${st.bundledVersion}`);
    } catch (e) {
      log.warn(`Could not update the hook: ${e.message || e}`);
    }
  }
  if (st.configured && !st.complete && !st.settingsError && !context.globalState.get('claudeReview.upgradeDismissed')) {
    vscode.window
      .showInformationMessage(
        'Inline Review for Claude Code: update the Claude Code hook settings? This adds a PostToolUse entry so a review survives a long permission prompt.',
        'Update',
        'Not now',
        "Don't ask again"
      )
      .then((pick) => {
        if (pick === 'Update') {
          try {
            for (const line of setup.install({ bundledHook: bundled })) log.info(line);
            hookReportsLanding = true;
          } catch (e) {
            vscode.window.showErrorMessage(`Could not update the settings: ${e.message || e}`);
          }
        } else if (pick === "Don't ask again") context.globalState.update('claudeReview.upgradeDismissed', true);
      });
  }
  if (!st.configured && !st.settingsError && !context.globalState.get('claudeReview.setupDismissed')) {
    vscode.window
      .showInformationMessage('Inline Review for Claude Code: connect Claude Code so its edits show up here for review.', 'Set up', 'Not now', "Don't ask again")
      .then((pick) => {
        if (pick === 'Set up') setupHook(context);
        else if (pick === "Don't ask again") context.globalState.update('claudeReview.setupDismissed', true);
      });
  }
}

// ---------- activation ----------

/** Builds before 0.4.0 were installed by hand under another ID; both running would draw every review twice. */
function warnAboutLegacyCopy() {
  const legacyId = 'local.claude-inline-review';
  if (!vscode.extensions.getExtension(legacyId)) return;
  vscode.window
    .showWarningMessage(
      `An older copy of this extension (${legacyId}) is also installed, so every change would be shown twice. Uninstall it from the Extensions view.`,
      'Show it'
    )
    .then((pick) => pick && vscode.commands.executeCommand('workbench.extensions.search', `@installed ${legacyId}`));
}

function updateRoots() {
  workspaceRoots = (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file').map((f) => store.keyOf(f.uri.fsPath));
}

function statusItem(id, priority, text, command, tooltip) {
  const item = vscode.window.createStatusBarItem('claudeReview.status.' + id, vscode.StatusBarAlignment.Left, priority);
  item.name = 'Claude Review';
  item.text = text;
  item.command = 'claudeReview.' + command;
  item.tooltip = tooltip;
  return item;
}

function activate(context) {
  log = vscode.window.createOutputChannel('Inline Review for Claude Code', { log: true });
  const dir = store.baselineDir();
  fs.mkdirSync(dir, { recursive: true });
  updateRoots();

  ui.addedLine = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('claudeReview.addedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('claudeReview.addedLineBorder'),
  });
  ui.addedWord = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('claudeReview.addedTextBackground'),
    borderRadius: '2px',
  });
  const removed = {
    isWholeLine: true,
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('claudeReview.removedMarker'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    after: { color: new vscode.ThemeColor('claudeReview.removedHintForeground'), fontStyle: 'italic' },
  };
  ui.removedAbove = vscode.window.createTextEditorDecorationType({ ...removed, borderWidth: '2px 0 0 0' });
  ui.removedBelow = vscode.window.createTextEditorDecorationType({ ...removed, borderWidth: '0 0 2px 0' });

  ui.comments = vscode.comments.createCommentController('claudeReview', 'Claude changes');
  ui.codeLensChanged = new vscode.EventEmitter();
  ui.fileDecorationsChanged = new vscode.EventEmitter();
  ui.baseChanged = new vscode.EventEmitter();
  ui.tree = tree;
  ui.treeView = vscode.window.createTreeView('claudeReview.changes', { treeDataProvider: tree, showCollapseAll: true });

  ui.summary = statusItem('summary', 100, '', 'listFiles', '');
  ui.prev = statusItem('prev', 99, '$(chevron-up)', 'prevHunk', 'Previous change');
  ui.position = statusItem('position', 98, '', 'nextHunk', '');
  ui.next = statusItem('next', 97, '$(chevron-down)', 'nextHunk', 'Next change');
  ui.acceptFileItem = statusItem('acceptFile', 96, '$(check-all) Accept file', 'acceptFile', 'Keep every Claude change in this file');
  ui.rejectFileItem = statusItem('rejectFile', 95, '$(close-all) Reject file', 'rejectFile', 'Undo every Claude change in this file');
  ui.fileStatus = [ui.prev, ui.position, ui.next, ui.acceptFileItem, ui.rejectFileItem];
  ui.status = [ui.summary, ...ui.fileStatus];

  const baselineWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '*.{json,landed}'));
  const reload = () => scheduleRefresh(true);
  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  const onFile = (uri) => {
    if (uri.scheme !== 'file') return;
    const key = store.keyOf(uri.fsPath);
    if (!entries.has(key)) return;
    diskCache.delete(key);
    scheduleRefresh();
  };

  const command = (name, fn) => vscode.commands.registerCommand('claudeReview.' + name, fn);

  context.subscriptions.push(
    log,
    ui.addedLine,
    ui.addedWord,
    ui.removedAbove,
    ui.removedBelow,
    ui.comments,
    ui.treeView,
    ...ui.status,
    baselineWatcher,
    baselineWatcher.onDidCreate(reload),
    baselineWatcher.onDidChange(reload),
    baselineWatcher.onDidDelete(reload),
    fileWatcher,
    fileWatcher.onDidChange(onFile),
    fileWatcher.onDidCreate(onFile),
    fileWatcher.onDidDelete(onFile),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, { ...codeLensProvider, onDidChangeCodeLenses: ui.codeLensChanged.event }),
    vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: ui.fileDecorationsChanged.event,
      provideFileDecoration(uri) {
        if (uri.scheme !== 'file') return undefined;
        const p = pending.get(store.keyOf(uri.fsPath));
        if (!p) return undefined;
        return new vscode.FileDecoration(
          'AI',
          `${plural(p.hunks.length, 'Claude change')} to review`,
          new vscode.ThemeColor(p.entry.existed ? 'gitDecoration.modifiedResourceForeground' : 'gitDecoration.addedResourceForeground')
        );
      },
    }),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, {
      onDidChange: ui.baseChanged.event,
      provideTextDocumentContent(uri) {
        const entry = entries.get(keyOfUri(uri));
        return entry ? entry.content : '';
      },
    }),
    vscode.workspace.onDidChangeTextDocument(onDocChange),
    vscode.workspace.onDidOpenTextDocument((d) => {
      rememberDoc(d);
      if (d.uri.scheme === 'file' && entries.has(store.keyOf(d.uri.fsPath))) scheduleRefresh();
    }),
    vscode.workspace.onDidCloseTextDocument((d) => d.uri.scheme === 'file' && docState.delete(store.keyOf(d.uri.fsPath))),
    vscode.window.onDidChangeVisibleTextEditors(() => scheduleRefresh()),
    vscode.window.onDidChangeActiveTextEditor(() => {
      updateCursorContext();
      updateStatus();
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === vscode.window.activeTextEditor) {
        updateCursorContext();
        updateStatus();
      }
    }),
    vscode.window.onDidChangeWindowState((s) => s.focused && scheduleRefresh(true)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      updateRoots();
      scheduleRefresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeReview')) return;
      memo.clear(); // fresh hunks, so cached word ranges and hovers are rebuilt
      refreshNow();
    }),
    command('acceptHunk', acceptHunk),
    command('rejectHunk', rejectHunk),
    command('acceptThread', (t) => acceptHunk(t)),
    command('rejectThread', (t) => rejectHunk(t)),
    command('acceptFile', acceptFile),
    command('rejectFile', rejectFile),
    command('acceptAll', acceptAll),
    command('rejectAll', rejectAll),
    command('undo', undoLast),
    command('nextHunk', () => goToHunk(1)),
    command('prevHunk', () => goToHunk(-1)),
    command('nextFile', () => goToFile(1)),
    command('prevFile', () => goToFile(-1)),
    command('openFile', (arg) => openAt(fileKeyFrom(arg), 1)),
    command('revealHunk', (key, bStart) => openAt(key, bStart)),
    command('showDiff', showDiff),
    command('openChanges', openChanges),
    command('listFiles', listFiles),
    command('refresh', () => {
      scheduleRefresh(true);
    }),
    command('setupHook', () => setupHook(context))
  );

  // Safety net for file watchers that miss events outside the workspace.
  let lastSig = '';
  const poll = setInterval(() => {
    let sig = '';
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.json') || f.endsWith('.landed')) sig += f + ':' + fs.statSync(path.join(dir, f)).mtimeMs + ';';
      }
    } catch {
      /* directory gone */
    }
    if (sig !== lastSig) {
      lastSig = sig;
      scheduleRefresh(true);
    }
  }, 2000);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });

  reloadEntries();
  refreshNow();
  checkHook(context);
  warnAboutLegacyCopy();
  log.info(`Watching ${dir}`);

  // For the extension's own tests.
  return {
    refreshNow: () => {
      reloadWanted = true;
      refreshNow();
    },
    pendingFiles: () => sortedPendingKeys().map((k) => ({ path: pending.get(k).entry.path, hunks: pending.get(k).hunks })),
    entry: (fsPath) => entries.get(store.keyOf(fsPath)) || null,
    historyLength: () => history.length,
    context: (name) => contextCache.get(name),
    tree,
    baselineDir: dir,
  };
}

function deactivate() {
  clearTimeout(refreshTimer);
}

module.exports = { activate, deactivate };
