'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { candidateKeilPaths, findKeil } = require('../src/toolchain');

test('Keil candidates include standard and STC installation locations', () => {
  const paths = candidateKeilPaths({ ProgramFiles: 'P:\\PF', 'ProgramFiles(x86)': 'P:\\PFX86' });
  assert.ok(paths.includes('C:\\Keil_v5\\UV4\\UV4.exe'));
  assert.ok(paths.includes('C:\\STC\\UV4\\UV4.exe'));
  assert.ok(paths.includes(path.join('P:\\PF', 'Keil', 'UV4', 'UV4.exe')));
  assert.equal(new Set(paths).size, paths.length);
});

test('findKeil returns only an existing file and does not alter environment', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stc-toolchain-'));
  const exe = path.join(root, 'UV4.exe');
  await fs.writeFile(exe, 'fixture');
  const before = process.env.PATH;
  assert.equal(await findKeil(exe), path.normalize(exe));
  assert.equal(await findKeil(path.join(root, 'missing.exe')), null);
  assert.equal(process.env.PATH, before);
  await fs.rm(root, { recursive: true, force: true });
});
