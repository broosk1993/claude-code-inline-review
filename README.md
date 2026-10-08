# Inline Review for Claude Code

Cursor-style review of [Claude Code](https://www.anthropic.com/claude-code)'s
edits, inside the file, in **VS Code** and **Cursor** (and other VS Code-based
editors).

When Claude Code changes a file, the change shows up where it happened: added
lines in green with the changed words highlighted, removed code in a red block
where it used to be, and **Accept** / **Reject** on every change. Review one
change, one file, or everything at once. Your own typing is never mistaken for
Claude's, and every decision can be undone.

> A community extension. It is not made by, endorsed by, or affiliated with
> Anthropic or Cursor.

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

**Requirements:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
and [Node.js](https://nodejs.org) on your `PATH` (Claude Code runs the review
hook with `node`).

1. Install the extension:
   - **VS Code**: search for *Inline Review for Claude Code* in the Extensions
     view, or `code --install-extension broosk1993.claude-code-inline-review`.
   - **Cursor, VSCodium, Windsurf** (Open VSX): search for it in the
     Extensions view.
   - **Any editor, offline**: download the `.vsix` from the
     [latest release](https://github.com/broosk1993/claude-code-inline-review/releases/latest)
     and run *Extensions: Install from VSIX…*.
2. Connect Claude Code: on first start the extension offers **Set up**, or run
   **Claude Review: Set up Claude Code hook** from the command palette. It copies
   a small hook script to `~/.claude/hooks/` and adds it to
   `~/.claude/settings.json` (after a backup; a settings file it cannot read is
   never touched).
3. Start a new Claude Code session. Its edits now show up for review.

Setup asks whether Claude Code may apply edits without asking
(`permissions.defaultMode: acceptEdits`). That is the recommended mode: Claude
writes, and you accept or reject here instead of in a prompt for every edit.
Bash commands still ask. Say no and nothing about your permissions changes.

The extension keeps the installed hook up to date on every start.

### Without the marketplace

The release zip contains an installer that does both steps for every editor it
finds:

```bash
node install.js                # asks about acceptEdits
node install.js --accept-edits # or decide up front (--keep-mode to leave it)
node install.js --uninstall    # remove hook, settings entry and extension (--purge drops pending reviews)
```

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

## Privacy

Everything stays on your machine. Baselines (copies of files as they were
before Claude changed them) are kept in `~/.claude/review/baselines` until you
accept or reject the change; nothing is sent anywhere.

## Development

```bash
npm install
npm test            # unit tests + type-check against the VS Code 1.85 API
npm run test:e2e    # runs the suite inside a real VS Code (temp profile)
npm run package     # dist/: .vsix, release folder, zip
```

`CIR_EDITOR=/path/to/editor-binary npm run test:e2e` runs the end-to-end suite
in another editor, Cursor for example.

Releases: bump `version` in `package.json` and the hook's header, add a
CHANGELOG entry, then push a `v<version>` tag. CI tests, builds, attaches the
`.vsix` and zip to a GitHub release, and publishes to the VS Code Marketplace
and Open VSX when the `VSCE_PAT` and `OVSX_PAT` secrets are set.

## License

[MIT](LICENSE)
