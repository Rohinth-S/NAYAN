import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
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
const digest = process.env.PRIVACY_AGENT_OLLAMA_MODEL_DIGEST || null;
if (digest && !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid reasoning model digest');
const archivePaths = files.filter(file => file.path.endsWith('.zip')).map(file => join(root, file.path));
const signed = archivePaths.length > 0 && archivePaths.every(file => existsSync(`${file}.asc`) && existsSync(`${file}.sha256`));
const output = {
  metadataVersion: '1.2',
  node: process.version,
  signingStatus: signed ? 'signature-present-unverified' : 'unsigned',
  visionLockSha256: createHash('sha256').update(readFileSync(join(root, 'models/vision-lock.json'))).digest('hex'),
  model: {
    id: process.env.PRIVACY_AGENT_OLLAMA_MODEL || 'qwen3-vl:2b-instruct',
    digest,
    digestRequired: process.env.PRIVACY_AGENT_PRODUCTION === '1',
  },
  promptVersion: '2026-09-16.1',
  detectorRegistryVersion: '1.1.0',
  documentOcrEnabled: existsSync(join(dist, 'chrome/ocr/lang-data/eng.traineddata')),
  documentOcrLockSha256: createHash('sha256').update(readFileSync(join(root, 'models/ocr-lock.json'))).digest('hex'),
  perceptionEnabled: existsSync(join(dist, 'chrome/perception')),
  perceptionLockSha256: createHash('sha256').update(readFileSync(join(root, 'models/perception-lock.json'))).digest('hex'),
  artifacts: files.sort((a, b) => a.path.localeCompare(b.path)),
};
writeFileSync(join(dist, 'RELEASE_METADATA.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Recorded ${files.length} artifact checksums in dist/RELEASE_METADATA.json`);
