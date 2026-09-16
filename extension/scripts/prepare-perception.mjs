import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sources = JSON.parse(await readFile(join(root, 'models/perception-sources.json'), 'utf8'));
const output = join(root, 'models/perception');
const entries = [];
for (const spec of Object.values(sources.models)) {
  for (const name of spec.files) entries.push({
    path: 'models/' + spec.id + '/' + name,
    url: 'https://huggingface.co/' + spec.id + '/resolve/' + spec.revision + '/' + name,
  });
}
for (const language of sources.ocr.languages) entries.push({
  path: 'lang-data/' + language + '.traineddata',
  url: 'https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@' + sources.ocr.revision + '/' + language + '.traineddata',
});
const lockPath = join(root, 'models/perception-lock.json');
let previous;
try { previous = JSON.parse(await readFile(lockPath, 'utf8')); } catch { /* First reviewed preparation writes the lock. */ }
const artifacts = [];
for (const entry of entries) {
  const destination = join(output, entry.path);
  let bytes;
  try { bytes = await readFile(destination); } catch {
    const response = await fetch(entry.url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error('Model download failed: ' + response.status);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const prior = previous?.artifacts.find(x => x.path === entry.path);
  if (previous && (!prior || prior.sha256 !== sha256)) throw new Error('Model checksum mismatch; refusing to update lock');
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  artifacts.push({ ...entry, bytes: bytes.length, sha256 });
  console.log('Verified ' + entry.path + ' (' + bytes.length + ' bytes)');
}
await writeFile(lockPath, JSON.stringify({ version: sources.version, artifacts }, null, 2) + '\n');
