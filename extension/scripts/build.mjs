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
const yoloModelSource = join(root, 'models', 'yolo-privacy-v1.onnx');
const dbnetModelSource = join(root, 'models', 'dbnet-text-det.onnx');
const ocrModelSource = join(root, 'models', 'ocr', 'lang-data', 'eng.traineddata');
const modelIncluded = await exists(modelSource);
const yoloModelIncluded = await exists(yoloModelSource);
const dbnetModelIncluded = await exists(dbnetModelSource);
const ocrModelIncluded = await exists(ocrModelSource);
const perceptionRequested = process.argv.includes('--perception') || process.env.LOCAL_PERCEPTION === '1';
const perceptionEvaluated = process.env.LOCAL_PERCEPTION_EVALUATED === '1';
if (perceptionRequested && !perceptionEvaluated) {
  throw new Error('Perception bundle is evaluation-gated. Set LOCAL_PERCEPTION_EVALUATED=1 only after reviewing evidence/local-perception.json.');
}
const perceptionEnabled = perceptionRequested && perceptionEvaluated;
// The narrow credential OCR path is part of the checked-in deterministic
// baseline.  It is checksum-verified below and remains fail-closed at runtime
// when OCR times out, returns low confidence, or cannot classify the media.
// `LOCAL_OCR=0` is an explicit opt-out for constrained builds.  The broader
// OCR/NER/barcode perception bundle remains evaluation-gated independently.
const ocrEnabled = ocrModelIncluded && process.env.LOCAL_OCR !== '0';
if (ocrModelIncluded) {
  const lock = JSON.parse(await readFile(join(root, 'models/ocr-lock.json'), 'utf8'));
  const asset = lock.artifacts.find(item => item.path === 'lang-data/eng.traineddata');
  if (!asset) throw new Error('OCR lock file does not contain eng.traineddata');
  const bytes = await readFile(ocrModelSource);
  if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new Error('OCR model checksum mismatch');
  }
}
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
  // `tabs` exposes only tab metadata (URL/title) so the side panel can
  // identify the current origin before requesting least-privilege page
  // access. It does not grant DOM or screenshot access by itself.
  permissions: ['activeTab', 'tabs', 'storage'],
};

// Chrome documents captureVisibleTab as requiring either activeTab or
// `<all_urls>`. A persistent side panel cannot depend on activeTab after a
// tab switch, so use the explicit all-sites grant for local capture and
// script injection. Runtime code still accepts only HTTP(S) tabs, and this
// permission never authorizes raw network egress: the gateway accepts only
// sanitized data.
const pageHostPermissions = ['http://*/*', 'https://*/*'];
const chromePageHostPermissions = ['<all_urls>'];

const chromeManifest = {
  ...commonManifest,
  manifest_version: 3,
  permissions: [...commonManifest.permissions, 'scripting', 'offscreen', 'sidePanel'],
  host_permissions: chromePageHostPermissions,
  background: { service_worker: 'background.js' },
  action: { default_title: 'Open Private Browser Agent' },
  side_panel: { default_path: 'sidepanel.html' },
  content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
};

const firefoxManifest = {
  ...commonManifest,
  manifest_version: 2,
  permissions: [...commonManifest.permissions, ...pageHostPermissions],
  background: { scripts: ['background.js'], persistent: false },
  browser_action: { default_title: 'Open Private Browser Agent' },
  sidebar_action: {
    default_title: 'Private Browser Agent',
    default_panel: 'sidepanel.html',
    width: 420,
  },
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
      sidepanel: join(root, 'src', 'popup.ts'),
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
    define: {
      __FACE_MODEL_INCLUDED__: JSON.stringify(modelIncluded),
      __YOLO_MODEL_INCLUDED__: JSON.stringify(yoloModelIncluded),
      __DBNET_MODEL_INCLUDED__: JSON.stringify(dbnetModelIncluded),
      __PERCEPTION_ENABLED__: JSON.stringify(perceptionEnabled),
      __OCR_ENABLED__: JSON.stringify(ocrEnabled),
    },
    alias: {
      '#local-sanitizer': join(root, 'src', target === 'chrome' ? 'sanitizer-offscreen.ts' : 'sanitizer-direct.ts'),
    },
  });
  await cp(join(root, 'src', 'popup.html'), join(outdir, 'popup.html'));
  await cp(join(root, 'src', 'popup.css'), join(outdir, 'popup.css'));
  await cp(join(root, 'src', 'sidepanel.html'), join(outdir, 'sidepanel.html'));
  await cp(join(root, 'src', 'sidepanel.css'), join(outdir, 'sidepanel.css'));
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

console.log(
  `Built Chrome and Firefox extension with ${
    yoloModelIncluded ? 'unified YOLO' : modelIncluded ? 'UltraFace fallback' : 'no visual detector'
  }${dbnetModelIncluded ? ' and DBNet canvas detector' : ''}${ocrEnabled ? ' and local credential OCR' : ''}.`,
);

async function copyRuntimeAssets(outdir) {
  if (perceptionEnabled) {
    const perceptionDir = join(outdir, 'perception');
    await cp(join(root, 'models/perception'), perceptionDir, { recursive: true });
    await copyTesseractRuntime(perceptionDir);
    const nestedOrt = join(root, 'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist');
    const nerOrt = await exists(nestedOrt) ? nestedOrt : join(root, 'node_modules/onnxruntime-web/dist');
    await mkdir(join(perceptionDir, 'ner-wasm'), { recursive: true });
    for (const name of await readdir(nerOrt)) {
      if (name.endsWith('.wasm') || name.endsWith('.mjs')) await cp(join(nerOrt, name), join(perceptionDir, 'ner-wasm', name));
    }
  }
  if (ocrEnabled) {
    const ocrDir = join(outdir, 'ocr');
    await mkdir(join(ocrDir, 'lang-data'), { recursive: true });
    await cp(ocrModelSource, join(ocrDir, 'lang-data', 'eng.traineddata'));
    const ocrNotice = join(root, 'models', 'ocr', 'NOTICE.md');
    if (await exists(ocrNotice)) await cp(ocrNotice, join(ocrDir, 'NOTICE.md'));
    await copyTesseractRuntime(ocrDir);
  }
  if (modelIncluded) {
    await mkdir(join(outdir, 'models'), { recursive: true });
    await cp(modelSource, join(outdir, 'models', 'version-RFB-320.onnx'));
    for (const file of ['ULTRAFACE_LICENSE.txt', 'NOTICE.md']) {
      const source = join(root, 'models', file);
      if (await exists(source)) await cp(source, join(outdir, 'models', file));
    }
  }
  if (yoloModelIncluded || dbnetModelIncluded) await mkdir(join(outdir, 'models'), { recursive: true });
  if (yoloModelIncluded) await cp(yoloModelSource, join(outdir, 'models', 'yolo-privacy-v1.onnx'));
  if (dbnetModelIncluded) await cp(dbnetModelSource, join(outdir, 'models', 'dbnet-text-det.onnx'));
  const ortDist = join(root, 'node_modules', 'onnxruntime-web', 'dist');
  const wasmDir = join(outdir, 'wasm');
  await mkdir(wasmDir, { recursive: true });
  for (const name of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
    const source = join(ortDist, name);
    // A missing loader/binary is a packaging error, not a usable extension.
    await cp(source, join(wasmDir, name));
  }
}

async function copyTesseractRuntime(targetDir) {
  const coreSource = join(root, 'node_modules/tesseract.js-core');
  const coreTarget = join(targetDir, 'core');
  await mkdir(coreTarget, { recursive: true });
  await cp(join(root, 'node_modules/tesseract.js/dist/worker.min.js'), join(targetDir, 'worker.min.js'));
  // OEM 1 (LSTM_ONLY) selects these two loaders. Keeping only SIMD and
  // non-SIMD LSTM variants avoids shipping legacy/full-core binaries.
  for (const name of [
    'LICENSE',
    'README.md',
    'package.json',
    'tesseract-core-simd-lstm.wasm.js',
    'tesseract-core-simd-lstm.wasm',
    'tesseract-core-lstm.wasm.js',
    'tesseract-core-lstm.wasm',
  ]) {
    await cp(join(coreSource, name), join(coreTarget, name));
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
