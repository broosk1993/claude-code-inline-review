'use strict';

// Line and word diffs for the inline review.
//
// A hunk is { aStart, aLines, bStart, bLines }: `a` is the baseline (the file
// before Claude touched it), `b` is the text now. Hunks are maximal runs of
// changed lines separated by at least one unchanged line.

/** @typedef {{ aStart: number, aLines: string[], bStart: number, bLines: string[] }} Hunk */
/** @typedef {{ line: number, start: number, end: number }} CharRange */

// Rough number of diagonal steps one diff may spend before the rest of the
// region is reported as replaced wholesale. Keeps a full rewrite of a large
// file from stalling the editor on every keystroke.
const LINE_BUDGET = 8_000_000;
const WORD_BUDGET = 1_000_000;
const MAX_WORD_TOKENS = 6_000;

/** @param {string} text */
function splitLines(text) {
  return text.split(/\r\n|\n/);
}

/** @param {string} text */
function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Maps both sequences to small integers so the diff compares numbers, not strings.
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 * @returns {[Int32Array, Int32Array]}
 */
function intern(a, b) {
  const ids = new Map();
  const map = (/** @type {readonly string[]} */ arr) => {
    const out = new Int32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      let id = ids.get(arr[i]);
      if (id === undefined) {
        id = ids.size;
        ids.set(arr[i], id);
      }
      out[i] = id;
    }
    return out;
  };
  return [map(a), map(b)];
}

/**
 * Marks the elements of A and B that are not part of a longest common
 * subsequence. Myers' O(ND) algorithm in linear space (middle snake). When the
 * budget runs out the remaining region is marked changed: still a correct
 * diff, only coarser.
 * @param {Int32Array} A
 * @param {Int32Array} B
 * @param {number} [budget]
 */
function diffMarks(A, B, budget = LINE_BUDGET) {
  const ctx = {
    A,
    B,
    aChanged: new Uint8Array(A.length),
    bChanged: new Uint8Array(B.length),
    budget,
  };
  compare(ctx, 0, A.length, 0, B.length);
  return { aChanged: ctx.aChanged, bChanged: ctx.bChanged };
}

function compare(ctx, aLo, aHi, bLo, bHi) {
  const { A, B } = ctx;
  for (;;) {
    while (aLo < aHi && bLo < bHi && A[aLo] === B[bLo]) {
      aLo++;
      bLo++;
    }
    while (aLo < aHi && bLo < bHi && A[aHi - 1] === B[bHi - 1]) {
      aHi--;
      bHi--;
    }
    if (aLo === aHi) {
      ctx.bChanged.fill(1, bLo, bHi);
      return;
    }
    if (bLo === bHi) {
      ctx.aChanged.fill(1, aLo, aHi);
      return;
    }
    const snake = ctx.budget > 0 ? middleSnake(ctx, aLo, aHi, bLo, bHi) : null;
    const stuck =
      !snake ||
      (snake[0] === aLo && snake[1] === bLo && snake[2] === aHi && snake[3] === bHi) ||
      (snake[0] === aHi && snake[1] === bHi) ||
      (snake[2] === aLo && snake[3] === bLo);
    if (stuck) {
      ctx.aChanged.fill(1, aLo, aHi);
      ctx.bChanged.fill(1, bLo, bHi);
      return;
    }
    const [sx, sy, ex, ey, editAtStart] = snake;
    // The snake holds one edit besides its diagonal: at its start when the
    // forward search found it, at its end when the backward search did.
    if (ex - sx === ey - sy + 1) ctx.aChanged[editAtStart ? sx : ex - 1] = 1;
    else if (ey - sy === ex - sx + 1) ctx.bChanged[editAtStart ? sy : ey - 1] = 1;
    compare(ctx, aLo, sx, bLo, sy);
    aLo = ex;
    bLo = ey;
  }
}

/**
 * Finds the middle snake of the box [left, right) x [top, bottom).
 * @returns {[number, number, number, number, number] | null} start x, start y, end x, end y, 1 if the edit is at the start
 */
function middleSnake(ctx, left, right, top, bottom) {
  const { A, B } = ctx;
  const width = right - left;
  const height = bottom - top;
  const delta = width - height;
  const odd = (delta & 1) !== 0;
  const max = Math.ceil((width + height) / 2);
  const off = max + 1;
  const vf = new Int32Array(2 * max + 3);
  const vb = new Int32Array(2 * max + 3);
  vf[off + 1] = left;
  vb[off + 1] = bottom;

  for (let d = 0; d <= max; d++) {
    ctx.budget -= 2 * d + 2;
    if (ctx.budget <= 0) return null;

    for (let k = d; k >= -d; k -= 2) {
      let x;
      let px;
      if (k === -d || (k !== d && vf[off + k - 1] < vf[off + k + 1])) {
        px = x = vf[off + k + 1];
      } else {
        px = vf[off + k - 1];
        x = px + 1;
      }
      let y = top + (x - left) - k;
      const py = d === 0 || x !== px ? y : y - 1;
      while (x < right && y < bottom && A[x] === B[y]) {
        x++;
        y++;
      }
      vf[off + k] = x;
      const c = k - delta;
      if (odd && c >= -(d - 1) && c <= d - 1 && y >= vb[off + c]) {
        return [px, py, x, y, 1];
      }
    }

    for (let c = d; c >= -d; c -= 2) {
      let y;
      let py;
      if (c === -d || (c !== d && vb[off + c - 1] > vb[off + c + 1])) {
        py = y = vb[off + c + 1];
      } else {
        py = vb[off + c - 1];
        y = py - 1;
      }
      const k = c + delta;
      let x = left + (y - top) + k;
      const px = d === 0 || y !== py ? x : x + 1;
      while (x > left && y > top && A[x - 1] === B[y - 1]) {
        x--;
        y--;
      }
      vb[off + c] = y;
      if (!odd && k >= -d && k <= d && x <= vf[off + k]) {
        return [x, y, px, py, 0];
      }
    }
  }
  return null;
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @param {Uint8Array} aChanged
 * @param {Uint8Array} bChanged
 * @returns {Hunk[]}
 */
function hunksFromMarks(a, b, aChanged, bChanged) {
  /** @type {Hunk[]} */
  const hunks = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && !aChanged[i] && !bChanged[j]) {
      i++;
      j++;
      continue;
    }
    const aStart = i;
    const bStart = j;
    while (i < a.length && aChanged[i]) i++;
    while (j < b.length && bChanged[j]) j++;
    if (i === aStart && j === bStart) break; // inconsistent marks; never expected
    hunks.push({ aStart, aLines: a.slice(aStart, i), bStart, bLines: b.slice(bStart, j) });
  }
  return hunks;
}

function indentOf(line) {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n += 1;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}

const isBlank = (line) => line.trim() === '';

/**
 * Lower is better. A pure insertion or deletion can often sit at several
 * offsets (the classic "}\n\nfn b() {" vs "fn b() {\n}\n" ambiguity); pick the
 * one a person would draw: ends on a blank line, does not start with a
 * closing bracket, starts at a shallow indent.
 * @param {string[]} lines
 */
function blockScore(lines) {
  const first = lines[0];
  const last = lines[lines.length - 1];
  let score = 0;
  if (!isBlank(last)) score += 4;
  if (isBlank(first)) score += 2;
  if (/^\s*[)\]}]/.test(first)) score += 6;
  if (!isBlank(first)) score += Math.min(indentOf(first), 16) / 2;
  return score;
}

/**
 * Slides pure insertions and deletions to their most readable position. Only
 * moves a block through equal lines and never next to another hunk, so the
 * result is still an exact diff.
 * @param {Hunk[]} hunks
 * @param {string[]} a
 * @param {string[]} b
 */
function slideHunks(hunks, a, b) {
  for (let n = 0; n < hunks.length; n++) {
    const h = hunks[n];
    const insertion = h.aLines.length === 0;
    const deletion = h.bLines.length === 0;
    if (insertion === deletion) continue;

    const seq = insertion ? b : a;
    const len = insertion ? h.bLines.length : h.aLines.length;
    const startOf = (x) => (insertion ? x.bStart : x.aStart);
    const lenOf = (x) => (insertion ? x.bLines.length : x.aLines.length);
    const prev = hunks[n - 1];
    const next = hunks[n + 1];
    const lo = prev ? startOf(prev) + lenOf(prev) + 1 : 0;
    const hi = next ? startOf(next) - 1 : seq.length;

    const origin = startOf(h);
    let s = origin;
    while (s - 1 >= lo && seq[s - 1] === seq[s + len - 1]) s--;
    let best = s;
    let bestScore = blockScore(seq.slice(s, s + len));
    for (let t = s; t + len < hi && seq[t] === seq[t + len]; ) {
      t++;
      const score = blockScore(seq.slice(t, t + len));
      if (score <= bestScore) {
        best = t;
        bestScore = score;
      }
    }
    if (best === origin) continue;
    const shift = best - origin;
    h.aStart += shift;
    h.bStart += shift;
    if (insertion) h.bLines = b.slice(h.bStart, h.bStart + len);
    else h.aLines = a.slice(h.aStart, h.aStart + len);
  }
  return hunks;
}

/**
 * @param {string[]} a baseline lines
 * @param {string[]} b current lines
 * @param {number} [budget]
 * @returns {Hunk[]}
 */
function diffLines(a, b, budget = LINE_BUDGET) {
  const [A, B] = intern(a, b);
  const { aChanged, bChanged } = diffMarks(A, B, budget);
  return slideHunks(hunksFromMarks(a, b, aChanged, bChanged), a, b);
}

const TOKEN = /\n|[^\S\n]+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/**
 * @param {string[]} tokens
 * @param {Uint8Array} changed
 * @param {string[]} lines
 * @returns {CharRange[]}
 */
function rangesOf(tokens, changed, lines) {
  /** @type {CharRange[]} */
  const out = [];
  let line = 0;
  let col = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '\n') {
      line++;
      col = 0;
      continue;
    }
    if (changed[i]) {
      const last = out[out.length - 1];
      // Join ranges separated only by whitespace: "foo bar" changed to
      // "baz qux" reads as one change, not two with a gap.
      if (last && last.line === line && isBlank(lines[line].slice(last.end, col))) last.end = col + t.length;
      else out.push({ line, start: col, end: col + t.length });
    }
    col += t.length;
  }
  return out;
}

/**
 * Word-level changes between the old and new lines of one hunk, as character
 * ranges relative to the hunk's first line. Null when the hunk is too large
 * to be worth it.
 * @param {string[]} aLines
 * @param {string[]} bLines
 * @returns {{ added: CharRange[], removed: CharRange[], addedRatio: number } | null}
 */
function wordDiff(aLines, bLines) {
  const aTokens = aLines.join('\n').match(TOKEN) || [];
  const bTokens = bLines.join('\n').match(TOKEN) || [];
  if (aTokens.length > MAX_WORD_TOKENS || bTokens.length > MAX_WORD_TOKENS) return null;
  const [A, B] = intern(aTokens, bTokens);
  const { aChanged, bChanged } = diffMarks(A, B, WORD_BUDGET);
  let addedChars = 0;
  let totalChars = 0;
  for (let i = 0; i < bTokens.length; i++) {
    if (bTokens[i] === '\n' || isBlank(bTokens[i])) continue;
    totalChars += bTokens[i].length;
    if (bChanged[i]) addedChars += bTokens[i].length;
  }
  return {
    added: rangesOf(bTokens, bChanged, bLines),
    removed: rangesOf(aTokens, aChanged, aLines),
    addedRatio: totalChars ? addedChars / totalChars : 0,
  };
}

module.exports = { splitLines, eolOf, diffLines, diffMarks, intern, wordDiff, blockScore };
