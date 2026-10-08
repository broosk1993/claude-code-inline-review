#!/usr/bin/env node
// Prints this version's section of CHANGELOG.md, for the GitHub release notes.

'use strict';

const fs = require('fs');
const path = require('path');

const { version } = require('../package.json');
const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
const sections = changelog.split(/^## /m);
const section = sections.find((s) => s.startsWith(version + '\n') || s.startsWith(version + ' '));
const body = section ? section.slice(section.indexOf('\n') + 1).trim() : `Release ${version}.`;
process.stdout.write(
  body +
    '\n\n---\n\nInstall from the VS Code Marketplace or Open VSX (search for *Inline Review for Claude Code*), or download the `.vsix` below and run *Extensions: Install from VSIX…*. Then run **Claude Review: Set up Claude Code hook**.\n'
);
