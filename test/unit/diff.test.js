'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diffLines, diffMarks, intern, splitLines, wordDiff, eolOf } = require('../../src/diff');

/** Applies hunks to `a` and must reproduce `b` exactly. */
function apply(a, hunks) {
  const out = [];
  let i = 0;
  for (const h of hunks) {
    while (i < h.aStart) out.push(a[i++]);
    assert.deepEqual(a.slice(h.aStart, h.aStart + h.aLines.length), h.aLines, 'hunk aLines match baseline');
    out.push(...h.bLines);
    i += h.aLines.length;
  }
  while (i < a.length) out.push(a[i++]);
  return out;
}

function lcsLength(a, b) {
  const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  return t[0][0];
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('identical texts have no hunks', () => {
  assert.deepEqual(diffLines(['a', 'b'], ['a', 'b']), []);
  assert.deepEqual(diffLines([''], ['']), []);
});

test('replacement in the middle is one hunk with both sides', () => {
  const hunks = diffLines(['a', 'b', 'c'], ['a', 'X', 'c']);
  assert.deepEqual(hunks, [{ aStart: 1, aLines: ['b'], bStart: 1, bLines: ['X'] }]);
});

test('pure insertion and pure deletion', () => {
  assert.deepEqual(diffLines(['a', 'c'], ['a', 'b', 'c']), [{ aStart: 1, aLines: [], bStart: 1, bLines: ['b'] }]);
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'c']), [{ aStart: 1, aLines: ['b'], bStart: 1, bLines: [] }]);
});

test('new file against empty baseline', () => {
  assert.deepEqual(diffLines([''], ['x', '']), [{ aStart: 0, aLines: [], bStart: 0, bLines: ['x'] }]);
});

test('random edits: hunks are exact and minimal', () => {
  const rand = rng(42);
  for (let round = 0; round < 400; round++) {
    const alphabet = 2 + Math.floor(rand() * 5);
    const n = Math.floor(rand() * 30);
    const a = Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(rand() * alphabet)));
    const b = a.slice();
    const edits = Math.floor(rand() * 8);
    for (let e = 0; e < edits; e++) {
      const at = Math.floor(rand() * (b.length + 1));
      const op = rand();
      if (op < 0.4) b.splice(at, 0, String.fromCharCode(97 + Math.floor(rand() * alphabet)));
      else if (op < 0.8) b.splice(at, 1);
      else if (b.length) b[Math.min(at, b.length - 1)] = 'z';
    }
    const hunks = diffLines(a, b);
    assert.deepEqual(apply(a, hunks), b, `round ${round}`);
    const edited = hunks.reduce((s, h) => s + h.aLines.length + h.bLines.length, 0);
    assert.equal(edited, a.length + b.length - 2 * lcsLength(a, b), `minimal, round ${round}`);
    for (let k = 1; k < hunks.length; k++) {
      const p = hunks[k - 1];
      assert.ok(hunks[k].bStart > p.bStart + p.bLines.length, 'hunks are separated by an unchanged line');
      assert.ok(hunks[k].aStart > p.aStart + p.aLines.length);
    }
  }
});

test('completely different sequences', () => {
  const rand = rng(7);
  for (let round = 0; round < 100; round++) {
    const a = Array.from({ length: Math.floor(rand() * 20) }, (_, i) => 'a' + i);
    const b = Array.from({ length: Math.floor(rand() * 20) }, (_, i) => 'b' + i);
    assert.deepEqual(apply(a, diffLines(a, b)), b);
  }
});

test('an exhausted budget degrades to a coarse but exact diff', () => {
  const a = Array.from({ length: 300 }, (_, i) => `line ${i % 7} ${i % 13}`);
  const b = a.map((l, i) => (i % 3 === 0 ? l + ' changed' : l));
  const hunks = diffLines(a, b, 50);
  assert.deepEqual(apply(a, hunks), b);
});

test('large file with a small change stays fast and precise', () => {
  const a = Array.from({ length: 50_000 }, (_, i) => `const v${i} = ${i};`);
  const b = a.slice();
  b.splice(25_000, 1, 'const changed = true;');
  b.splice(40_000, 0, 'inserted();');
  const started = Date.now();
  const hunks = diffLines(a, b);
  assert.ok(Date.now() - started < 1000, 'diff took too long');
  assert.equal(hunks.length, 2);
  assert.deepEqual(apply(a, hunks), b);
});

test('a full rewrite of a large file finishes', () => {
  const a = Array.from({ length: 8000 }, (_, i) => `old ${i}`);
  const b = Array.from({ length: 8000 }, (_, i) => `new ${i}`);
  const started = Date.now();
  const hunks = diffLines(a, b);
  assert.ok(Date.now() - started < 2000, 'diff took too long');
  assert.deepEqual(apply(a, hunks), b);
});

test('inserted function is placed as a person would draw it', () => {
  const a = ['fn a() {', '}', '', 'fn c() {', '}', ''];
  const b = ['fn a() {', '}', '', 'fn b() {', '}', '', 'fn c() {', '}', ''];
  const hunks = diffLines(a, b);
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].bLines, ['fn b() {', '}', '']);
  assert.equal(hunks[0].bStart, 3);
});

test('inserted block between closing braces starts at the opening line', () => {
  const a = ['if (x) {', '  foo();', '}'];
  const b = ['if (x) {', '  foo();', '}', 'if (y) {', '  foo();', '}'];
  const hunks = diffLines(a, b);
  assert.deepEqual(hunks[0].bLines, ['if (y) {', '  foo();', '}']);
});

test('deleted function is placed as a person would draw it', () => {
  const a = ['fn a() {', '}', '', 'fn b() {', '}', '', 'fn c() {', '}'];
  const b = ['fn a() {', '}', '', 'fn c() {', '}'];
  const hunks = diffLines(a, b);
  assert.deepEqual(hunks, [{ aStart: 3, aLines: ['fn b() {', '}', ''], bStart: 3, bLines: [] }]);
});

test('diffMarks marks exactly the non-common elements', () => {
  const [A, B] = intern(['a', 'b', 'c', 'd'], ['b', 'c', 'e']);
  const { aChanged, bChanged } = diffMarks(A, B);
  assert.deepEqual([...aChanged], [1, 0, 0, 1]);
  assert.deepEqual([...bChanged], [0, 0, 1]);
});

test('splitLines and eolOf', () => {
  assert.deepEqual(splitLines('a\r\nb\nc'), ['a', 'b', 'c']);
  assert.deepEqual(splitLines('a\n'), ['a', '']);
  assert.equal(eolOf('a\r\nb'), '\r\n');
  assert.equal(eolOf('a\nb'), '\n');
});

test('wordDiff highlights only the changed words', () => {
  const wd = wordDiff(['const total = price * qty;'], ['const total = price * quantity + tax;']);
  assert.ok(wd);
  const line = 'const total = price * quantity + tax;';
  const texts = wd.added.map((r) => line.slice(r.start, r.end));
  assert.deepEqual(texts, ['quantity + tax']);
  assert.deepEqual(
    wd.removed.map((r) => 'const total = price * qty;'.slice(r.start, r.end)),
    ['qty']
  );
  assert.ok(wd.addedRatio > 0 && wd.addedRatio < 0.5);
});

test('wordDiff ranges are per line', () => {
  const wd = wordDiff(['a b', 'c d'], ['a X', 'c d', 'new line']);
  assert.ok(wd);
  assert.deepEqual(wd.added, [
    { line: 0, start: 2, end: 3 },
    { line: 2, start: 0, end: 8 },
  ]);
});

test('wordDiff refuses huge hunks', () => {
  const big = Array.from({ length: 4000 }, (_, i) => `w${i} x${i}`);
  assert.equal(wordDiff(big, big.map((l) => l + ' y')), null);
});
