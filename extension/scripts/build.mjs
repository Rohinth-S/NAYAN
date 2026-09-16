import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const artifacts = join(root, 'artifacts');
const modelSource = join(root, 'models', 'version-RFB-320.onnx');
const modelIncluded = await exists(modelSource);
const perceptionEnabled = process.argv.includes('--perception') || process.env.LOCAL_PERCEPTION === '1';
if (perceptionEnabled) {
  const lock = JSON.parse(await readFile(join(root, 'models/perception-lock.json'), 'utf8'));
  for (const asset of lock.artifacts) {
    const bytes = await readFile(join(root, 'models/perception', asset.path));
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Perception model checksum mismatch');
  }
}
const reproducibleArchiveDate = new Date('1980-01-01T00:00:00.000Z');

const commonManifest = {
  name: 'SIH Private Browser Agent',
  version: '0.1.0',
  description: 'Locally sanitizes browser observations before private-agent reasoning requests.',
  permissions: ['activeTab', 'storage'],
};

const chromeManifest = {
  ...commonManifest,
  manifest_version: 3,
  permissions: [...commonManifest.permissions, 'scripting', 'offscreen'],
  optional_host_permissions: ['http://*/*', 'https://*/*'],
  background: { service_worker: 'background.js' },
  action: { default_popup: 'popup.html', default_title: 'Private Browser Agent' },
  content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
};

const firefoxManifest = {
  ...commonManifest,
  manifest_version: 2,
  permissions: [...commonManifest.permissions],
  optional_permissions: ['http://*/*', 'https://*/*'],
  background: { scripts: ['background.js'], persistent: false },
  browser_action: { default_popup: 'popup.html', default_title: 'Private Browser Agent' },
  content_security_policy: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  browser_specific_settings: { gecko: { id: 'sih-private-agent@example.invalid', strict_min_version: '121.0' } },
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const [target, manifest] of [['chrome', chromeManifest], ['firefox', firefoxManifest]]) {
  const outdir = join(dist, target);
  await mkdir(outdir, { recursive: true });
  await build({
    entryPoints: {
      background: join(root, 'src', 'background.ts'),
      content: join(root, 'src', 'content.ts'),
      popup: join(root, 'src', 'popup.ts'),
      preview: join(root, 'src', 'preview.ts'),
      ...(target === 'chrome' ? { offscreen: join(root, 'src', 'offscreen.ts') } : {}),
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: target === 'chrome' ? ['chrome120'] : ['firefox121'],
    outdir,
    sourcemap: false,
    minify: true,
    legalComments: 'none',
    define: { __FACE_MODEL_INCLUDED__: JSON.stringify(modelIncluded), __PERCEPTION_ENABLED__: JSON.stringify(perceptionEnabled) },
    alias: {
      '#local-sanitizer': join(root, 'src', target === 'chrome' ? 'sanitizer-offscreen.ts' : 'sanitizer-direct.ts'),
    },
  });
  await cp(join(root, 'src', 'popup.html'), join(outdir, 'popup.html'));
  await cp(join(root, 'src', 'popup.css'), join(outdir, 'popup.css'));
  await cp(join(root, 'src', 'preview.html'), join(outdir, 'preview.html'));
  await cp(join(root, 'src', 'preview.css'), join(outdir, 'preview.css'));
  if (target === 'chrome') await cp(join(root, 'src', 'offscreen.html'), join(outdir, 'offscreen.html'));
  await writeFile(join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await copyRuntimeAssets(outdir);
}

// npm's lifecycle name avoids forwarding a flag into the esbuild service on
// Windows, where an arbitrary Node argument can make the service resolve
// entry points relative to the filesystem root. Direct --package remains
// supported for shells that do not exhibit that behavior.
if (process.argv.includes('--package')) {
  await rm(artifacts, { recursive: true, force: true });
  await mkdir(artifacts, { recursive: true });
  for (const target of ['chrome', 'firefox']) {
    const files = await zipEntries(join(dist, target));
    await writeFile(
      join(artifacts, `sih-private-agent-${target}-0.1.0.zip`),
      zipSync(files, { level: 9, mtime: reproducibleArchiveDate }),
    );
  }
}

console.log(`Built Chrome and Firefox extension${modelIncluded ? ' with UltraFace model' : ' without model (runtime will fail closed)'}.`);

async function copyRuntimeAssets(outdir) {
  if (perceptionEnabled) {
    const perceptionDir = join(outdir, 'perception');
    await cp(join(root, 'models/perception'), perceptionDir, { recursive: true });
    await cp(join(root, 'node_modules/tesseract.js/dist/worker.min.js'), join(perceptionDir, 'worker.min.js'));
    await cp(join(root, 'node_modules/tesseract.js-core'), join(perceptionDir, 'core'), { recursive: true });
    const nestedOrt = join(root, 'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist');
    const nerOrt = await exists(nestedOrt) ? nestedOrt : join(root, 'node_modules/onnxruntime-web/dist');
    await mkdir(join(perceptionDir, 'ner-wasm'), { recursive: true });
    for (const name of await readdir(nerOrt)) {
      if (name.endsWith('.wasm') || name.endsWith('.mjs')) await cp(join(nerOrt, name), join(perceptionDir, 'ner-wasm', name));
    }
  }
  if (modelIncluded) {
    await mkdir(join(outdir, 'models'), { recursive: true });
    await cp(modelSource, join(outdir, 'models', 'version-RFB-320.onnx'));
    for (const file of ['ULTRAFACE_LICENSE.txt', 'NOTICE.md']) {
      const source = join(root, 'models', file);
      if (await exists(source)) await cp(source, join(outdir, 'models', file));
    }
  }
  const ortDist = join(root, 'node_modules', 'onnxruntime-web', 'dist');
  const wasmDir = join(outdir, 'wasm');
  await mkdir(wasmDir, { recursive: true });
  for (const name of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
    const source = join(ortDist, name);
    // A missing loader/binary is a packaging error, not a usable extension.
    await cp(source, join(wasmDir, name));
  }
}

async function zipEntries(directory) {
  const result = {};
  for (const path of await walk(directory)) result[relative(directory, path).replaceAll('\\', '/')] = new Uint8Array(await readFile(path));
  return result;
}

async function walk(directory) {
  const result = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    if ((await stat(path)).isDirectory()) result.push(...await walk(path));
    else result.push(path);
  }
  return result;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
