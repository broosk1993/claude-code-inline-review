# Claude Inline Review

Cursor-style review of Claude Code's edits, inside the file, in Cursor or VS Code.

When Claude Code changes a file, the change shows up where it happened: added
lines in green with the changed words highlighted, removed code in a red block
where it used to be, and **Accept** / **Reject** on every change. Review one
change, one file, or everything at once. Your own typing is never mistaken for
Claude's, and every decision can be undone.

## What you get

| | |
| --- | --- |
| **Inline diff** | Green background on added/changed lines, a stronger highlight on the exact words that changed, the removed code drawn as a red block in place, markers in the overview ruler. |
| **Per-change actions** | `Accept` / `Reject` above each change (CodeLens), in its hover, in the editor's right-click menu, and on the removed-code block. |
| **Cursor's keys** | With the cursor inside a change: `Ctrl+Y` / `⌘Y` accepts, `Ctrl+N` / `⌘N` rejects. Outside a change those keys do what they always did. `Ctrl+Alt+Enter` / `Ctrl+Alt+Backspace` always work. |
| **Flow** | After a decision the cursor moves to the next change. `Ctrl+Alt+↓` / `↑` walks every change across every file. |
| **Review bar** | Status bar: `✦ 7 changes · 3 files`, and for the open file `▲ 2 of 5 ▼  Accept file  Reject file`. Same buttons in the editor title bar. |
| **Claude Changes view** | In the Source Control sidebar: every file with `−removed +added`, each change underneath with a preview, accept/reject buttons inline, a badge with the count. |
| **Full diffs** | "Show before/after diff" for one file, or "Open all changes in one diff" (multi-file diff editor). The native diff editor's revert arrows work too. |
| **Undo** | `Ctrl+Z` right after a reject brings the change back *for review*. "Claude Review: Undo last review action" undoes accept/reject of a change, a file, or everything; accept all / reject all also offer Undo in their notification. |
| **Your edits stay yours** | Typing, pasting, formatting outside Claude's changes goes into the baseline; editing inside a change makes it part of that change. |
| **Files you never opened** | Changes to closed files are listed and can be accepted or rejected without opening them. A file Claude created is deleted on reject (and its tab closed). |

## How it works

1. A Claude Code **PreToolUse hook** (`Edit`, `MultiEdit`, `Write`) saves the
   file as it is *before* Claude's first edit — the *baseline* — in
   `~/.claude/review/baselines` (outside your project; nothing to gitignore).
   Later edits pile into the same review until you've reviewed it. The same
   script, as a **PostToolUse** hook, marks the write as landed, so a review
   waiting on a long permission prompt is not mistaken for an abandoned one.
2. The extension diffs each file against its baseline (Myers diff, with
   readable hunk placement and word-level detail) and draws the result.
3. **Accept** moves Claude's lines into the baseline. **Reject** puts the
   baseline's lines back into the file and saves it, so Claude reads what you
   see. A file with nothing left to review leaves the list.

## Install

From the release folder:

```bash
node install.js                # asks whether Claude may edit without asking
node install.js --accept-edits # or decide up front (--keep-mode to leave it)
```

It copies the hook to `~/.claude/hooks/`, adds it to `~/.claude/settings.json`
(after a backup; an unreadable settings file is never touched, a symlinked one
is written through, its permissions kept) and installs the
extension into every Cursor / VS Code / VSCodium / Windsurf it finds. Reload the
editor window and restart Claude Code.

Or install the `.vsix` from the editor ("Extensions: Install from VSIX…") and
run **Claude Review: Set up Claude Code hook**; the extension also offers this
on first start. It keeps the installed hook in step with itself on every start.

`acceptEdits` is recommended: Claude applies its edits and you review them
here, instead of approving each one in a prompt. Bash commands still ask.

Uninstall: `node install.js --uninstall` (add `--purge` to drop pending reviews).

## Settings

| Setting | Default | |
| --- | --- | --- |
| `claudeReview.showCodeLens` | `true` | Accept / Reject above each change and file buttons on line 1 |
| `claudeReview.showRemovedInline` | `true` | Draw removed code as a red block in place |
| `claudeReview.highlightWordChanges` | `true` | Highlight the changed words inside modified lines |
| `claudeReview.showHover` | `true` | Hover a change for the old code and Accept / Reject / Diff links |
| `claudeReview.cursorStyleKeybindings` | `true` | `Ctrl/⌘+Y` and `Ctrl/⌘+N` inside a change |
| `claudeReview.jumpToNextChange` | `true` | Move to the next change after a decision |
| `claudeReview.saveAfterReject` | `true` | Save after rejecting so Claude reads the file you see |
| `claudeReview.confirmRejectAll` | `true` | Ask before rejecting everything |
| `claudeReview.revealOnEdit` | `false` | Open files in a preview tab as Claude starts changing them |
| `claudeReview.maxRemovedLinesShown` | `60` | Cut-off for removed code drawn inline or in a hover |

Colors are themeable: `claudeReview.addedLineBackground`,
`claudeReview.addedTextBackground`, `claudeReview.addedLineBorder`,
`claudeReview.removedMarker`, `claudeReview.removedHintForeground` (they default
to your theme's diff colors).

## Limits

- Only edits made through Claude Code's `Edit`, `MultiEdit` and `Write` tools
  are tracked. A file Claude changes through Bash (`sed -i`, a formatter) is
  tracked only if it already has a pending review.
- Editors give extensions no way to insert real lines between lines, so removed
  code is drawn with the comment widget — the same block, slightly different
  chrome from Cursor's.
- While a review is pending, changes to the file from *other* tools that
  reload it from disk (`git checkout`, a formatter run in a terminal) look like
  Claude's. Your own typing never does. Rejecting a review older than a day
  asks first, because the file may have moved on for other reasons.
- A change that only converts line endings (CRLF ↔ LF) is not shown.
- A change on line 1 draws its removed code just below line 1: the comment
  widget cannot sit above the first line.
- `Ctrl+Z` does not undo an *accept* (accepting does not touch the file); use
  "Undo last review action".
- Text files only; binary files and files over 8 MB are skipped.

## Development

```bash
npm install
npm test            # unit tests + type-check against the VS Code 1.85 API
npm run test:e2e    # runs the suite inside a real VS Code (temp profile)
npm run package     # dist/: .vsix, release folder, zip
```
