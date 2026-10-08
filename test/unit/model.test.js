'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diffLines, splitLines } = require('../../src/diff');
const model = require('../../src/model');

const change = (l1, c1, l2, c2, text) => ({ range: { start: { line: l1, character: c1 }, end: { line: l2, character: c2 } }, text });
const hunksOf = (a, b) => diffLines(splitLines(a), splitLines(b));

/** Applies VS Code-style changes (ranges against the text before) to a text. */
function applyChanges(text, changes) {
  const lines = splitLines(text);
  for (const c of [...changes].sort((x, y) => y.range.start.line - x.range.start.line || y.range.start.character - x.range.start.character)) {
    const pre = lines[c.range.start.line].slice(0, c.range.start.character);
    const suf = lines[c.range.end.line].slice(c.range.end.character);
    lines.splice(c.range.start.line, c.range.end.line - c.range.start.line + 1, ...splitLines(pre + c.text + suf));
  }
  return lines.join('\n');
}

test('typing outside a hunk goes into the baseline, so the review is unchanged', () => {
  const base = 'a\nb\nc\nd\n';
  const now = 'a\nB\nc\nd\n'; // Claude changed b -> B
  const edit = [change(3, 1, 3, 1, '!')]; // user types after d
  const next = model.absorbUserEdits(base, hunksOf(base, now), edit, '\n');
  assert.equal(next, 'a\nb\nc\nd!\n');
  const after = applyChanges(now, edit);
  assert.deepEqual(hunksOf(next, after), hunksOf(base, now));
});

test('typing inside a hunk stays part of the change', () => {
  const base = 'a\nb\nc\n';
  const now = 'a\nB\nc\n';
  assert.equal(model.absorbUserEdits(base, hunksOf(base, now), [change(1, 1, 1, 1, 'x')], '\n'), null);
});

test('edits below an insertion map through the line offset', () => {
  const base = 'a\nc\nd\n';
  const now = 'a\nb1\nb2\nc\nd\n'; // Claude inserted two lines
  const edit = [change(4, 0, 4, 1, 'D')];
  const next = model.absorbUserEdits(base, hunksOf(base, now), edit, '\n');
  assert.equal(next, 'a\nc\nD\n');
  assert.deepEqual(hunksOf(next, applyChanges(now, edit)), hunksOf(base, now));
});

test('edits below a deletion map through the line offset', () => {
  const base = 'a\nb\nc\nd\n';
  const now = 'a\nd\n'; // Claude removed b and c
  const edit = [change(1, 0, 1, 0, 'x')];
  const next = model.absorbUserEdits(base, hunksOf(base, now), edit, '\n');
  assert.equal(next, 'a\nb\nc\nxd\n');
});

test('an edit spanning a deletion point is not absorbed', () => {
  const base = 'a\nb\nc\n';
  const now = 'a\nc\n';
  assert.equal(model.absorbUserEdits(base, hunksOf(base, now), [change(0, 1, 1, 0, '')], '\n'), null);
});

test('several changes in one event (multi-cursor) are all absorbed', () => {
  const base = 'one\ntwo\nthree\nfour\n';
  const now = 'one\nTWO\nthree\nfour\n';
  const edits = [change(0, 0, 0, 0, '// '), change(3, 0, 3, 0, '// ')];
  const next = model.absorbUserEdits(base, hunksOf(base, now), edits, '\n');
  assert.equal(next, '// one\ntwo\nthree\n// four\n');
  assert.deepEqual(hunksOf(next, applyChanges(now, edits)).length, 1);
});

test('pressing Enter right above a hunk keeps the hunk intact', () => {
  const base = 'a\nb\nc\n';
  const now = 'a\nB\nc\n';
  const edit = [change(0, 1, 0, 1, '\n')];
  const next = model.absorbUserEdits(base, hunksOf(base, now), edit, '\n');
  assert.equal(next, 'a\n\nb\nc\n');
  const hunks = hunksOf(next, applyChanges(now, edit));
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].aLines, ['b']);
  assert.deepEqual(hunks[0].bLines, ['B']);
});

test('CRLF baselines keep their line endings', () => {
  const base = 'a\r\nb\r\nc\r\n';
  const now = 'a\r\nB\r\nc\r\n';
  const next = model.absorbUserEdits(base, hunksOf(base, now), [change(2, 1, 2, 1, '!')], '\r\n');
  assert.equal(next, 'a\r\nb\r\nc!\r\n');
});

test('accept moves the hunk into the baseline; reject moves it out of the text', () => {
  const base = 'a\nb\nc\nd\n';
  const now = 'a\nB\nc\nD\n';
  const [h1, h2] = hunksOf(base, now);
  const accepted = model.acceptHunkInBaseline(base, h1, '\n');
  assert.equal(accepted, 'a\nB\nc\nd\n');
  assert.deepEqual(hunksOf(accepted, now), [hunksOf(base, now)[1]]);
  const rejected = model.rejectHunkInText(now, h2, '\n');
  assert.equal(rejected, 'a\nB\nc\nd\n');
  assert.deepEqual(hunksOf(base, rejected).length, 1);
});

test('rejecting every hunk, last first, restores the baseline', () => {
  const base = 'l1\nl2\nl3\nl4\nl5\nl6\n';
  let now = 'l1\nX\nl3\nl5\nl6\nnew\n';
  for (const h of hunksOf(base, now).reverse()) now = model.rejectHunkInText(now, h, '\n');
  assert.equal(now, base);
});

test('minimalEdit is the smallest replacement and never splits CRLF', () => {
  assert.equal(model.minimalEdit('same', 'same'), null);
  assert.deepEqual(model.minimalEdit('abcdef', 'abXdef'), { start: 2, end: 3, text: 'X' });
  assert.deepEqual(model.minimalEdit('a\r\nb', 'a\nb'), { start: 1, end: 3, text: '\n' }); // keeps the CRLF whole
  const crlf = model.minimalEdit('x\r\ny', 'x\r\nz\r\ny');
  assert.ok(crlf);
  const result = 'x\r\ny'.slice(0, crlf.start) + crlf.text + 'x\r\ny'.slice(crlf.end);
  assert.equal(result, 'x\r\nz\r\ny');
  for (const [b, a] of [
    ['', 'abc'],
    ['abc', ''],
    ['aaa', 'aa'],
    ['a😀b', 'a😁b'],
  ]) {
    const e = model.minimalEdit(b, a);
    assert.equal(b.slice(0, e.start) + e.text + b.slice(e.end), a);
  }
});

test('hunkAtLine finds the change under the cursor', () => {
  const hunks = hunksOf('a\nb\nc\nd\n', 'a\nB\nB2\nc\n');
  assert.equal(model.hunkAtLine(hunks, 0), undefined);
  assert.equal(model.hunkAtLine(hunks, 1), hunks[0]);
  assert.equal(model.hunkAtLine(hunks, 2), hunks[0]);
  const del = hunksOf('a\nb\nc\n', 'a\nc\n');
  assert.equal(model.hunkAtLine(del, 1), del[0]);
  assert.equal(model.hunkAtLine(del, 0), del[0]);
});

test('hunkStat and totals', () => {
  const [h] = hunksOf('a\nb\nc\n', 'a\nX\nY\nZ\nc\n');
  assert.equal(model.hunkStat(h), '−1 +3');
  assert.deepEqual(model.totals([h]), { removed: 1, added: 3 });
  assert.equal(model.plural(1, 'change'), '1 change');
  assert.equal(model.plural(2, 'change'), '2 changes');
});

test('replaceLines matches split/splice/join on uniform line endings', () => {
  let seed = 3;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let round = 0; round < 3000; round++) {
    const eol = rand() < 0.5 ? '\n' : '\r\n';
    const lines = Array.from({ length: Math.floor(rand() * 6) + 1 }, () => (rand() < 0.3 ? '' : 'l' + Math.floor(rand() * 9)));
    const text = lines.join(eol);
    const start = Math.floor(rand() * (lines.length + 1));
    const count = Math.floor(rand() * (lines.length - Math.min(start, lines.length) + 1));
    const repl = Array.from({ length: Math.floor(rand() * 3) }, (_, i) => 'n' + i);
    if (start === lines.length && count === 0 && repl.length === 0) continue;
    const expected = [...lines];
    expected.splice(start, count, ...repl);
    assert.equal(model.replaceLines(text, start, count, repl, eol), expected.join(eol), JSON.stringify({ text, start, count, repl }));
  }
});

test('reject in a mixed-ending file leaves the other line endings alone', () => {
  const base = 'a\nb\nc\nd\r\n';
  const now = 'a\nB\nc\nd\r\n';
  const [h] = hunksOf(base, now);
  assert.equal(model.rejectHunkInText(now, h, '\n'), base);
  assert.equal(model.acceptHunkInBaseline(base, h, '\n'), now);
});

test('accepting or rejecting at the end of a file without a final newline', () => {
  const base = 'x';
  const now = 'x\ny';
  const [h] = hunksOf(base, now);
  assert.equal(model.rejectHunkInText(now, h, '\n'), 'x');
  assert.equal(model.acceptHunkInBaseline(base, h, '\n'), 'x\ny');
  const [d] = hunksOf('x\r\ny', 'x');
  assert.equal(model.rejectHunkInText('x', d, '\r\n'), 'x\r\ny');
  assert.equal(model.acceptHunkInBaseline('x\r\ny', d, '\r\n'), 'x');
});
