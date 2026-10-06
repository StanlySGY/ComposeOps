import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const version = manifest('package.json').version;
const tag = process.argv.slice(2).find(arg => !arg.startsWith('--')) || 'v' + version;
if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Release tag must be a stable vX.Y.Z version');
if (tag !== 'v' + version) throw new Error('Tag and root package version differ');
for (const dir of ['frontend', 'backend']) {
  // npm workspaces:统一用根 lockfile 校验版本(workspace 包各自的 lockfile 已移除)
  if (manifest(dir + '/package.json').version !== version) throw new Error(dir + ' version differs');
  if (manifest('package-lock.json').packages[dir].version !== version) throw new Error(dir + ' lockfile version differs');
}
const lines = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split('\n');
const start = lines.findIndex(line => line.startsWith('## [' + version + ']'));
if (start < 0) throw new Error('Missing changelog entry for ' + version);
const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
const notes = lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim();
if (!notes) throw new Error('Release notes must not be empty');
const compose = readFileSync(path.join(root, 'deploy/compose.yml'), 'utf8');
const pinned = compose.replace(/image: stanly1997\/opsdash:[^\n]+/, 'image: stanly1997/opsdash:' + version);
if (!compose.includes('COMPOSEOPS_VERSION:-' + version)) throw new Error('Install manifest version differs');
if (!process.argv.includes('--check')) {
  const output = path.join(root, 'artifacts/release');
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'notes.md'), notes + '\n');
  writeFileSync(path.join(output, 'compose.yml'), pinned);
}
console.log('Release metadata verified: ' + tag);
