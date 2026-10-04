#!/usr/bin/env node
// Bumps the version in every file that carries it, so they never drift.
//
//   node scripts/bump-version.mjs            # patch: 0.1.0 -> 0.1.1
//   node scripts/bump-version.mjs minor      # 0.1.3 -> 0.2.0
//   node scripts/bump-version.mjs 1.0.0      # explicit
//
// Prints the new version. src/index.js reads it from package.json at runtime.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const write = (f, data) => fs.writeFileSync(path.join(root, f), JSON.stringify(data, null, 2) + '\n');

const current = read('package.json').version;
const arg = process.argv[2] || 'patch';
let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) {
  next = arg;
} else {
  const [major, minor, patch] = current.split('.').map(Number);
  next = { major: `${major + 1}.0.0`, minor: `${major}.${minor + 1}.0`, patch: `${major}.${minor}.${patch + 1}` }[arg];
  if (!next) throw new Error(`usage: bump-version.mjs [patch|minor|major|x.y.z] (got "${arg}")`);
}

const pkg = read('package.json');
pkg.version = next;
write('package.json', pkg);

const plugin = read('.claude-plugin/plugin.json');
plugin.version = next;
write('.claude-plugin/plugin.json', plugin);

const market = read('.claude-plugin/marketplace.json');
for (const p of market.plugins) if (p.name === pkg.name) p.version = next;
write('.claude-plugin/marketplace.json', market);

const server = read('server.json');
server.version = next;
for (const p of server.packages) if (p.identifier === pkg.name) p.version = next;
write('server.json', server);

console.log(next);
