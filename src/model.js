'use strict';

// Review logic with no editor dependency, so it can be tested in plain Node.

const { splitLines } = require('./diff');

/** @typedef {import('./diff').Hunk} Hunk */
/** @typedef {{ start: { line: number, character: number }, end: { line: number, character: number } }} LineRange */
/** @typedef {{ range: LineRange, text: string }} TextChange */

/** @param {Hunk} h */
function hunkEnd(h) {
  return h.bStart + h.bLines.length;
}

/**
 * True when an edit spanning lines [l1, l2] of the current text touches the hunk.
 * @param {Hunk} h
 */
function touches(h, l1, l2) {
  if (h.bLines.length === 0) return l1 < h.bStart && l2 >= h.bStart; // spans the deletion point
  return l1 <= hunkEnd(h) - 1 && l2 >= h.bStart;
}

/**
 * Copies the user's own edits into the baseline so they never show up as
 * Claude's changes. An edit inside one of Claude's hunks is left alone: it
 * becomes part of that change. `hunks` must describe the text *before* the
 * edits (VS Code reports change ranges against that text).
 * @param {string} baseline
 * @param {Hunk[]} hunks
 * @param {readonly TextChange[]} changes
 * @param {string} eol
 * @returns {string | null} the new baseline, or null when nothing was absorbed
 */
function absorbUserEdits(baseline, hunks, changes, eol) {
  const lines = splitLines(baseline);
  const sorted = [...changes].sort(
    (x, y) => y.range.start.line - x.range.start.line || y.range.start.character - x.range.start.character
  );
  let changed = false;
  for (const c of sorted) {
    const l1 = c.range.start.line;
    const l2 = c.range.end.line;
    if (hunks.some((h) => touches(h, l1, l2))) continue;
    // Both ends sit in unchanged text, so they map to the baseline by the net
    // line count of the hunks above.
    let offset = 0;
    for (const h of hunks) if (hunkEnd(h) <= l1) offset += h.aLines.length - h.bLines.length;
    const a1 = l1 + offset;
    const a2 = l2 + offset;
    if (a1 < 0 || a2 >= lines.length) continue;
    const prefix = lines[a1].slice(0, c.range.start.character);
    const suffix = lines[a2].slice(c.range.end.character);
    lines.splice(a1, a2 - a1 + 1, ...splitLines(prefix + c.text + suffix));
    changed = true;
  }
  return changed ? lines.join(eol) : null;
}

/** Offset where each line starts (as many entries as splitLines returns lines). */
function lineStarts(text) {
  const starts = [0];
  const re = /\r\n|\n/g;
  let m;
  while ((m = re.exec(text))) starts.push(m.index + m[0].length);
  return starts;
}

/**
 * Replaces lines [start, start + count) of `text` with `lines`. Every other
 * character, line endings included, is kept as it was, so a mixed-ending file
 * is not rewritten; new lines end with `eol`.
 */
function replaceLines(text, start, count, lines, eol) {
  const starts = lineStarts(text);
  const n = starts.length;
  const end = start + count;
  if (start >= n) return text + lines.map((l) => eol + l).join(''); // after the last line
  if (end < n) return text.slice(0, starts[start]) + lines.map((l) => l + eol).join('') + text.slice(starts[end]);
  // The range runs to the last line, which has no line ending of its own.
  if (lines.length) return text.slice(0, starts[start]) + lines.join(eol);
  if (start === 0) return '';
  const cut = text.slice(starts[start] - 2, starts[start]) === '\r\n' ? 2 : 1;
  return text.slice(0, starts[start] - cut);
}

/** Keeping a hunk: the baseline takes Claude's lines. */
function acceptHunkInBaseline(baseline, hunk, eol) {
  return replaceLines(baseline, hunk.aStart, hunk.aLines.length, hunk.bLines, eol);
}

/** Rejecting a hunk: the file takes the baseline's lines back. */
function rejectHunkInText(text, hunk, eol) {
  return replaceLines(text, hunk.bStart, hunk.bLines.length, hunk.aLines, eol);
}

/**
 * The smallest single replacement turning `before` into `after`, so an edit
 * keeps the cursor, folding and undo history of untouched text.
 * @returns {{ start: number, end: number, text: string } | null} offsets into `before`
 */
function minimalEdit(before, after) {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  // Never split a CRLF or a surrogate pair.
  const splits = (str, i) =>
    i > 0 &&
    i < str.length &&
    ((str[i - 1] === '\r' && str[i] === '\n') || (/[\uD800-\uDBFF]/.test(str[i - 1]) && /[\uDC00-\uDFFF]/.test(str[i])));
  while (p > 0 && (splits(before, p) || splits(after, p))) p--;
  while (s > 0 && (splits(before, before.length - s) || splits(after, after.length - s))) s--;
  return { start: p, end: before.length - s, text: after.slice(p, after.length - s) };
}

/**
 * The hunk under a cursor line: containing it, or a deletion right at it.
 * @param {Hunk[]} hunks
 * @param {number} line
 */
function hunkAtLine(hunks, line) {
  return (
    hunks.find((h) => h.bLines.length > 0 && line >= h.bStart && line < hunkEnd(h)) ||
    hunks.find((h) => h.bLines.length === 0 && (line === h.bStart || line === h.bStart - 1))
  );
}

/** "−2 +5" */
function hunkStat(h) {
  const parts = [];
  if (h.aLines.length) parts.push('−' + h.aLines.length);
  if (h.bLines.length) parts.push('+' + h.bLines.length);
  return parts.join(' ');
}

/** @param {Hunk[]} hunks */
function totals(hunks) {
  let removed = 0;
  let added = 0;
  for (const h of hunks) {
    removed += h.aLines.length;
    added += h.bLines.length;
  }
  return { removed, added };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

module.exports = {
  absorbUserEdits,
  replaceLines,
  acceptHunkInBaseline,
  rejectHunkInText,
  minimalEdit,
  hunkAtLine,
  hunkEnd,
  hunkStat,
  totals,
  touches,
  plural,
};
