import { pipeline, env, RawImage } from '@huggingface/transformers';
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, arch, cpus } from 'node:os';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
env.allowRemoteModels = false;
env.localModelPath = resolve(root, 'extension/models/perception/models') + '/';
env.useFSCache = false;
const corpus = JSON.parse(await readFile(resolve(root, 'evaluation/corpus/perception-v1.json'), 'utf8'));
const lock = JSON.parse(await readFile(resolve(root, 'extension/models/perception-lock.json'), 'utf8'));
const start = performance.now();
const ner = await pipeline('token-classification', 'Xenova/bert-base-multilingual-cased-ner-hrl', { dtype: 'q8', device: 'cpu', local_files_only: true });
const nerInitMs = performance.now() - start;
const ocrStarted = performance.now();
const ocr = await createWorker(['eng', 'hin'], 1, {
  langPath: resolve(root, 'extension/models/perception/lang-data'), gzip: false, cacheMethod: 'none',
  logger: () => undefined, errorHandler: () => undefined,
});
const ocrInitMs = performance.now() - ocrStarted;
const categories = { PER: 'name', LOC: 'location', ORG: 'professional-id' };
const grades = { name: 3, location: 2, 'professional-id': 3, uninspectable: 1 };
const buckets = {};
const nerTimes = [], ocrTimes = [];
let ocrExact = 0, rssPeak = process.memoryUsage().rss;
let visualImage;
const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const normalize = s => s.normalize('NFKC').replace(/\s+/gu, '').trim();
for (const sample of corpus.cases) {
  const began = performance.now();
  const output = await ner(sample.text);
  nerTimes.push(performance.now() - began);
  const predicted = new Set(output.map(x => x.score < 0.8 ? 'uninspectable' : categories[x.entity.replace(/^[BI]-/u, '')]).filter(Boolean));
  for (const grade of [1, 2, 3]) {
    for (const category of Object.keys(grades)) {
      const key = [sample.language, category, grade].join('/');
      const b = buckets[key] ??= { language: sample.language, category, grade, tp: 0, fp: 0, fn: 0, tn: 0 };
      const expected = sample.categories.includes(category) && grades[category] <= grade;
      const actual = predicted.has(category) && grades[category] <= grade;
      b[expected ? actual ? 'tp' : 'fn' : actual ? 'fp' : 'tn']++;
    }
  }
  const svg = '<svg width="640" height="100" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="20" y="65" font-family="Nirmala UI,Arial" font-size="36" fill="black">' + escape(sample.ocr) + '</text></svg>';
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  visualImage ??= png;
  const ocrStart = performance.now();
  const recognized = await ocr.recognize(png);
  ocrTimes.push(performance.now() - ocrStart);
  if (normalize(recognized.data.text) === normalize(sample.ocr)) ocrExact++;
  rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
}
await ocr.terminate();
await ner.dispose();
const visualStart = performance.now();
const visual = await pipeline('image-classification', 'Xenova/mobilevit-small', { dtype: 'q8', device: 'cpu', local_files_only: true });
const visualInitMs = performance.now() - visualStart;
const visStart = performance.now();
await visual(await RawImage.fromBlob(new Blob([visualImage], { type: 'image/png' })));
const visualInferenceMs = performance.now() - visStart;
await visual.dispose();
const wilson = (success, total) => {
  if (!total) return null;
  const z = 1.96, p = success / total, d = 1 + z*z/total;
  const c = (p + z*z/(2*total))/d, h = z*Math.sqrt(p*(1-p)/total + z*z/(4*total*total))/d;
  return [Math.max(0,c-h), Math.min(1,c+h)];
};
const percentile = (xs, p) => [...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*p)-1];
const metrics = Object.values(buckets).map(b => {
  const precision = b.tp + b.fp ? b.tp/(b.tp+b.fp) : null;
  const recall = b.tp + b.fn ? b.tp/(b.tp+b.fn) : null;
  return { ...b, precision, recall, f1: precision !== null && recall !== null && precision+recall ? 2*precision*recall/(precision+recall) : null, precision95: wilson(b.tp,b.tp+b.fp), recall95: wilson(b.tp,b.tp+b.fn) };
});
const report = {
  reportVersion: '1.0', registryVersion: '1.1.0', corpusVersion: corpus.version, synthetic: true,
  measurement: 'real quantized model inference; category-presence, not span or population accuracy',
  machine: { platform: platform(), architecture: arch(), logicalCpus: cpus().length },
  backend: 'NER/visual native CPU; OCR WASM', browser: null,
  modelAssets: lock.artifacts.map(({path,sha256,bytes})=>({path,sha256,bytes})),
  ner: { samples: corpus.cases.length, initMs: nerInitMs, p50Ms: percentile(nerTimes,.5), p95Ms: percentile(nerTimes,.95), metrics },
  ocr: { samples: corpus.cases.length, exactMatches: ocrExact, exactMatchRate: ocrExact/corpus.cases.length, exactMatch95: wilson(ocrExact,corpus.cases.length), initMs: ocrInitMs, p50Ms: percentile(ocrTimes,.5), p95Ms: percentile(ocrTimes,.95) },
  visual: { initMs: visualInitMs, inferenceMs: visualInferenceMs, decision: 'Not admitted to the privacy decision path: image classification has no verified PII boxes or page-semantic accuracy.' },
  resource: { sampledProcessPeakRssBytes: rssPeak, gpuMemoryBytes: null, browserMainThreadMs: null },
  limitations: ['Small synthetic corpus; independent review pending', 'No GPU or browser measurements in this report', 'Redaction IoU and excess area require pixel fixtures; not inferred from category predictions', 'Media remains fully masked at every grade'],
};
await writeFile(resolve(root, 'evidence/local-perception.json'), JSON.stringify(report, null, 2)+'\n');
console.log(JSON.stringify({samples:corpus.cases.length, ocrExact, nerP95Ms:report.ner.p95Ms, ocrP95Ms:report.ocr.p95Ms, output:'evidence/local-perception.json'}));
