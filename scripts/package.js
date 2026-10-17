'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const output = path.join(root, 'artifacts');
fs.mkdirSync(output, { recursive: true });
const cli = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
const result = spawnSync(process.execPath, [cli, 'package', '--no-dependencies', '--out', path.join(output, `${pkg.name}-${pkg.version}.vsix`)], {
  cwd: root, stdio: 'inherit', shell: false, windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
