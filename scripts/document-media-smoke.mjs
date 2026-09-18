// Real packaged-extension OCR regression. Only synthetic demo data is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(pathToFileURL(path.join(root, '.tools/playwright/node_modules/playwright/index.mjs')).href);
const endpoint = process.env.PRIVACY_E2E_SERVER ?? 'http://127.0.0.1:8765';
const extension = path.join(root, 'extension/dist/chrome');
const rows = [];
await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
const contains = (outer, inner, tolerance = 1) => outer.x <= inner.x + tolerance && outer.y <= inner.y + tolerance
  && outer.x + outer.width >= inner.x + inner.width - tolerance && outer.y + outer.height >= inner.y + inner.height - tolerance;

for (const dpr of [1, 1.25]) {
  const profile = await fs.mkdtemp(path.join(root, '.runtime', 'document-media-smoke-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.PRIVACY_E2E_CHROME_EXECUTABLE ?? path.join(root, '.runtime/cft-chromium/chrome-win/chrome.exe'),
    headless: true, viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox', '--window-size=1280,1000', `--force-device-scale-factor=${dpr}`],
  });
  let reasonRequests = 0;
  context.on('request', request => { if (new URL(request.url()).pathname === '/v1/reason') reasonRequests++; });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const demo = await context.newPage();
    await demo.goto(`${endpoint}/demo`, { waitUntil: 'networkidle' });
    await worker.evaluate(async () => {
      if (!await chrome.offscreen.hasDocument()) await chrome.offscreen.createDocument({
        url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Verify local synthetic document redaction',
      });
    });
    for (const zoom of [1, 0.8, 0.67]) {
      await demo.evaluate(zoom => { document.body.style.zoom = String(zoom); window.scrollTo(0, document.documentElement.scrollHeight); }, zoom);
      await demo.bringToFront();
      for (const grade of [1, 2, 3]) {
        const result = await worker.evaluate(async ({ grade, endpoint }) => {
          const tab = (await chrome.tabs.query({ url: `${endpoint}/demo` }))[0];
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
          const captured = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_DOM', snapshotId: crypto.randomUUID(), knownValues: [], privacyGrade: grade });
          if (!captured.ok) throw new Error(captured.error);
          const dom = captured.snapshot;
          const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
          const response = await chrome.runtime.sendMessage({
            target: 'privacy-offscreen', type: 'SANITIZE_CAPTURE', requestId: crypto.randomUUID(),
            screenshot, dom, allowFullMaskFallback: false, canaries: [], privacyGrade: grade,
          });
          if (!response.ok) throw new Error(response.error);
          const raster = response.raster;
          const scaleX = raster.width / dom.viewport.width;
          const scaleY = raster.height / dom.viewport.height;
          return {
            raster,
            hints: dom.mediaHints.map(({ bounds, kind, documentType, localImage }) => ({
              bounds: { x: bounds.x * scaleX, y: bounds.y * scaleY, width: bounds.width * scaleX, height: bounds.height * scaleY },
              kind, documentType, nativeSource: !!localImage,
            })),
          };
        }, { grade, endpoint });
        const { raster, hints } = result;
        const documents = hints.filter(h => h.kind === 'document');
        assert.equal(documents.length, 3, 'all three document fixtures must be visible');
        for (const doc of documents) {
          assert(doc.nativeSource, `native pixels missing for ${doc.documentType}`);
          assert(!raster.redactions.some(mask => mask.kind === 'uninspectable-media' && contains(mask.bounds, doc.bounds)), `${doc.documentType} was fully masked: grade ${grade}, zoom ${zoom}, DPR ${dpr}`);
          const kind = doc.documentType === 'credit-card' ? 'sensitive-field' : doc.documentType;
          const required = doc.documentType === 'pan-card' ? grade
            : doc.documentType === 'aadhaar-card' ? [0, 1, 4, 6][grade] : grade === 3 ? 4 : 3;
          const fields = raster.redactions.filter(mask => mask.source === 'ocr' && mask.kind === kind && contains(doc.bounds, mask.bounds, 8));
          assert.equal(fields.length, required, `${doc.documentType}: incorrect grade-specific field count`);
          assert(fields.every(mask => mask.bounds.width * mask.bounds.height < doc.bounds.width * doc.bounds.height * 0.2), 'field mask must not cover the document');
        }
        for (const portrait of hints.filter(h => h.kind === 'person')) {
          assert(raster.redactions.some(mask => contains(mask.bounds, portrait.bounds)), 'portrait must remain masked at every grade');
        }
        const row = { dpr, zoom, grade, documents: documents.length, masks: raster.redactions.length, backend: raster.detectorBackend, status: 'passed' };
        rows.push(row);
        console.log(JSON.stringify(row));
        if (grade === 3) await fs.writeFile(path.join(root, `artifacts/document-media-dpr-${dpr}-zoom-${zoom}.png`), Buffer.from(raster.dataBase64, 'base64'));
      }
    }
    assert.equal(reasonRequests, 0, 'preview verification must not call a reasoning server');
  } finally { await context.close(); }
}
await fs.writeFile(path.join(root, 'artifacts/document-media-smoke.json'), `${JSON.stringify({ scope: 'synthetic Chrome document OCR', rawDataSent: false, checks: rows }, null, 2)}\n`);
