# Changelog

## 0.3.0

New:

- Word-level highlight of the exact text Claude changed inside a line.
- Cursor's keys inside a change: `Ctrl/⌘+Y` accept, `Ctrl/⌘+N` reject; the cursor moves on to the next change.
- Review bar in the status bar (position, previous/next, accept/reject file) and the same buttons in the editor title bar.
- "Claude Changes" view in the Source Control sidebar with inline accept/reject per file and per change, and a count badge.
- Hover on a change: the code it replaced, with Accept / Reject / Diff links.
- "Open all changes in one diff" (multi-file diff editor); file/explorer context menu entries.
- Undo: `Ctrl+Z` after a reject brings the change back for review; "Undo last review action" for accept/reject of a change, a file or everything; Undo button after accept all / reject all.
- Changes to files you have not opened can be reviewed without opening them; rejecting a file Claude created closes its tab.
- "Set up Claude Code hook" command; the extension keeps an installed hook up to date (upgrades only, atomically).
- The hook also runs as PostToolUse and marks Claude's write as landed: a review waiting on a long permission prompt is kept, an abandoned one is cleaned up.
- Rejecting a review older than a day asks first.
- Themeable colors; settings for word highlights, hover, keys, jump-to-next, save-after-reject, reveal-on-edit.

Fixed:

- Your first keystroke in a freshly reloaded file, and two quick Claude writes in a row, could be classified the wrong way round (your edit shown as Claude's, or Claude's absorbed as yours).
- Reject followed by `Ctrl+Z` silently accepted Claude's change.
- A file reached through a symlink got two separate reviews.
- Files with a path longer than ~190 characters were never tracked (baseline file name too long).
- Files with a UTF-8 BOM showed the first line as changed.
- Large rewrites collapsed into one huge change; the diff is now Myers with a time budget, and inserted/deleted blocks are placed the way you'd draw them.
- The installer no longer forces `acceptEdits`; it asks (or takes `--accept-edits` / `--keep-mode`).
- Typing in one file while a reject was saving another was not recognised as yours; edits made by format-on-save are now treated as yours too.
- A reject whose save or delete failed no longer closes the review.
- Accept/reject in a mixed line-ending file no longer rewrites every line ending.
- Setup writes through a symlinked settings.json and keeps its file permissions.

## 0.2.0

Initial version: hook + extension with line highlights, removed code in comment widgets, CodeLens accept/reject.
