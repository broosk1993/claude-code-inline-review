#!/usr/bin/env node
// Packages the extension (.vsix) and a ready-to-share folder + zip:
//   dist/<name>-<version>.vsix
//   dist/<name>-<version>/   vsix, installer, hook, unpacked extension, INSTALL.txt
//   dist/<name>-<version>.zip

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const { name: packageName, version, displayName } = require('../package.json');
const dist = path.join(root, 'dist');
const name = `${packageName}-${version}`;
const vsix = path.join(dist, `${name}.vsix`);
const bundle = path.join(dist, name);

fs.rmSync(bundle, { recursive: true, force: true });
fs.mkdirSync(bundle, { recursive: true });

execFileSync(process.execPath, [path.join(root, 'node_modules/@vscode/vsce/vsce'), 'package', '--no-dependencies', '--out', vsix], { cwd: root, stdio: 'inherit' });

fs.copyFileSync(vsix, path.join(bundle, path.basename(vsix)));
fs.copyFileSync(path.join(root, 'scripts/install.js'), path.join(bundle, 'install.js'));
fs.copyFileSync(path.join(root, 'src/setup.js'), path.join(bundle, 'setup.js'));
fs.copyFileSync(path.join(root, 'hook/review-snapshot.js'), path.join(bundle, 'review-snapshot.js'));
fs.copyFileSync(path.join(root, 'README.md'), path.join(bundle, 'README.md'));
const ext = path.join(bundle, 'extension');
for (const item of ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'src', 'hook', 'media']) {
  fs.cpSync(path.join(root, item), path.join(ext, item), { recursive: true });
}
fs.writeFileSync(
  path.join(bundle, 'settings-snippet.json'),
  JSON.stringify(
    {
      permissions: { defaultMode: 'acceptEdits' },
      hooks: Object.fromEntries(
        ['PreToolUse', 'PostToolUse'].map((event) => [
          event,
          [{ matcher: 'Edit|MultiEdit|Write', hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/review-snapshot.js"' }] }],
        ])
      ),
    },
    null,
    2
  ) + '\n'
);
fs.writeFileSync(
  path.join(bundle, 'INSTALL.txt'),
  `${displayName} ${version}

Easiest: open a terminal in this folder and run
    node install.js
It copies the Claude Code hook, adds it to ~/.claude/settings.json (backup made
first), asks whether Claude may edit without asking (acceptEdits), and installs
the extension into Cursor / VS Code. Then reload the editor window and restart
Claude Code.

Options: --accept-edits, --keep-mode, --no-extension, --no-hook, --uninstall

Extension only: in the editor, run "Extensions: Install from VSIX..." and pick
${path.basename(vsix)}. Then run "Claude Review: Set up Claude Code hook" from
the command palette to connect Claude Code.
`
);

fs.rmSync(path.join(dist, `${name}.zip`), { force: true });
/** @type {[string, string[]][]} */
const zippers = [
  ['zip', ['-qr', `${name}.zip`, name]],
  ['python3', ['-m', 'zipfile', '-c', `${name}.zip`, name]],
];
const zipped = zippers.some(([cmd, args]) => {
  try {
    execFileSync(cmd, args, { cwd: dist, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});
console.log(`Built ${path.relative(root, vsix)}, ${path.relative(root, bundle)}/` + (zipped ? ` and dist/${name}.zip` : ' (no zip: neither zip nor python3 found)'));
