'use strict';

// Runs test/e2e/suite.js inside a real editor with this extension loaded.
// Uses an installed VS Code when it can find one (CIR_EDITOR to pick
// another, e.g. Cursor's binary), otherwise downloads one. Everything it
// touches lives in a temp directory: your settings, extensions, Claude config
// and pending reviews are never read or written.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

function findExecutable() {
  if (process.env.CIR_EDITOR) return process.env.CIR_EDITOR;
  const candidates = {
    linux: ['/usr/share/code/code', '/opt/visual-studio-code/code', '/usr/lib/code/code'],
    darwin: ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron'],
    win32: [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe')],
  }[process.platform] || [];
  return candidates.find((p) => fs.existsSync(p));
}

async function main() {
  const root = path.resolve(__dirname, '../..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cir-e2e-'));
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace);
  // Launched from inside an editor (an integrated terminal, Claude Code), the
  // environment says "run Electron as plain Node" and points at the parent
  // editor's IPC. The test editor must not inherit either.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('ELECTRON_') || name.startsWith('VSCODE_')) delete process.env[name];
  }
  const executable = findExecutable();
  console.log(`Editor: ${executable || '(downloading VS Code)'}\nTemp: ${tmp}`);
  try {
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--user-data-dir',
        path.join(tmp, 'user-data'),
        '--extensions-dir',
        path.join(tmp, 'extensions'),
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-gpu',
      ],
      extensionTestsEnv: {
        CLAUDE_REVIEW_DIR: path.join(tmp, 'baselines'),
        CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
        CIR_E2E_WORKSPACE: workspace,
      },
    });
  } catch (e) {
    console.error('End-to-end tests failed:', e.message || e);
    process.exitCode = 1;
  } finally {
    if (!process.exitCode) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
