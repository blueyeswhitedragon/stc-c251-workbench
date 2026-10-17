'use strict';
// Generates distribution notices from the exact installed runtime dependencies.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const seen = new Set(); const parts = ['JavaScript runtime dependencies — complete original notices\n'];
function visit(name) {
  if (seen.has(name)) return; seen.add(name);
  const dir = path.join(root, 'node_modules', name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
  const files = fs.readdirSync(dir).filter(n => /^licen[cs]e(?:\.|$)/i.test(n));
  if (!files.length && name !== '@nodable/entities') throw new Error('Missing license for '+name);
  parts.push(`\n===== ${name}@${pkg.version} (${pkg.license}) =====\n`);
  for (const file of files) parts.push(fs.readFileSync(path.join(dir,file),'utf8'));
  if (name === '@nodable/entities' && !files.length) parts.push(fs.readFileSync(path.join(root,'licenses/nodable-entities-LICENSE'),'utf8'));
  for (const child of Object.keys(pkg.dependencies || {})) visit(child);
}
for (const name of Object.keys(require('../package.json').dependencies)) visit(name);
fs.writeFileSync(path.join(root,'THIRD_PARTY_LICENSES.txt'),parts.join('\n'));
console.log(`Included ${seen.size} runtime license notices.`);
