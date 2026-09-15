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
    else if (/\.(zip|xpi|crx|json)$/u.test(name)) {
      const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
      files.push({ path: relative(root, path).replaceAll('\\', '/'), sha256 });
    }
  }
}
visit(dist);
const output = { generatedAt: new Date().toISOString(), node: process.version, artifacts: files.sort((a, b) => a.path.localeCompare(b.path)) };
writeFileSync(join(dist, 'RELEASE_METADATA.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Recorded ${files.length} artifact checksums in dist/RELEASE_METADATA.json`);
