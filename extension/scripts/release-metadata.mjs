import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
if (!existsSync(dist)) throw new Error('Run npm run package before generating release metadata');

const files = [];
function visit(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) visit(path);
    else if (name !== 'RELEASE_METADATA.json') {
      const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
      files.push({ path: relative(root, path).replaceAll('\\', '/'), sha256 });
    }
  }
}
visit(dist);
const packageDirectory = join(root, 'artifacts');
if (!existsSync(packageDirectory)) throw new Error('Run npm run package before generating release metadata');
visit(packageDirectory);
for (const browser of ['chrome', 'firefox']) {
  if (!files.some((file) => file.path === `artifacts/sih-private-agent-${browser}-0.1.0.zip`)) {
    throw new Error(`Missing ${browser} release archive`);
  }
}
const output = { metadataVersion: '1.0', node: process.version, signingStatus: 'unsigned', artifacts: files.sort((a, b) => a.path.localeCompare(b.path)) };
writeFileSync(join(dist, 'RELEASE_METADATA.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Recorded ${files.length} artifact checksums in dist/RELEASE_METADATA.json`);
