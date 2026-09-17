import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(root, 'models/ocr-lock.json');
const lock = JSON.parse(await readFile(lockPath, 'utf8'));

for (const artifact of lock.artifacts) {
  const destination = join(root, 'models/ocr', artifact.path);
  let bytes;
  try {
    bytes = await readFile(destination);
  } catch {
    const response = await fetch(artifact.url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`OCR model download failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== artifact.bytes || sha256 !== artifact.sha256) {
    throw new Error(`OCR model checksum mismatch for ${artifact.path}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  console.log(`Verified ${artifact.path} (${bytes.length} bytes)`);
}
