import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium, firefox } = await import(
  pathToFileURL(path.join(root, '.tools', 'playwright', 'node_modules', 'playwright', 'index.mjs')).href,
);
const browserName = (process.env.PRIVACY_E2E_BROWSER ?? 'chrome').toLowerCase();
const serverBase = process.env.PRIVACY_E2E_SERVER ?? 'http://127.0.0.1:8765';
const extensionSource = path.join(root, 'extension', 'dist', browserName === 'firefox' ? 'firefox' : 'chrome');
const extensionCopy = path.join(root, '.runtime', `browser-matrix-${browserName}-extension`);
const profile = path.join(root, '.runtime', `browser-matrix-${browserName}-profile`);
const chromeExecutable = process.env.PRIVACY_E2E_CHROME_EXECUTABLE
  ?? path.join(root, '.runtime', 'cft-chromium', 'chrome-win', 'chrome.exe');
const firefoxExecutable = process.env.PRIVACY_E2E_FIREFOX_EXECUTABLE ?? '';

function writeEvidence(value) {
  return fs.writeFile(
    path.join(root, 'evidence', `browser-matrix-${browserName}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  );
}

if (browserName === 'firefox' && !firefoxExecutable) {
  const evidence = {
    browser: 'firefox',
    status: 'skipped',
    reason: 'Set PRIVACY_E2E_FIREFOX_EXECUTABLE to a Firefox binary to run the extension matrix.',
    rawDataSent: false,
  };
  await writeEvidence(evidence);
  console.log(JSON.stringify(evidence));
  process.exit(0);
}

if (browserName !== 'chrome' && browserName !== 'firefox') throw new Error(`Unsupported browser: ${browserName}`);
const executable = browserName === 'firefox' ? firefoxExecutable : chromeExecutable;
await fs.access(executable);
await fs.rm(extensionCopy, { recursive: true, force: true });
await fs.rm(profile, { recursive: true, force: true });
await fs.cp(extensionSource, extensionCopy, { recursive: true });

const manifestPath = path.join(extensionCopy, 'manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
if (browserName === 'chrome') {
  delete manifest.optional_host_permissions;
  manifest.host_permissions = ['<all_urls>'];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

const launchOptions = {
  executablePath: executable,
  headless: true,
  viewport: null,
  ...(browserName === 'chrome'
    ? { args: [`--disable-extensions-except=${extensionCopy}`, `--load-extension=${extensionCopy}`, '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,1000'] }
    : {}),
};
const context = browserName === 'chrome'
  ? await chromium.launchPersistentContext(profile, launchOptions)
  : await firefox.launchPersistentContext(profile, launchOptions);

const evidence = {
  browser: browserName,
  status: 'passed',
  rawDataSent: false,
  checks: {
    semanticPreview: false,
    structureOnlyPreview: false,
    receiptVisible: false,
  },
};
try {
  let extensionId = '';
  if (browserName === 'chrome') {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    extensionId = new URL(serviceWorker.url()).hostname;
  }
  const demo = await context.newPage();
  await demo.goto(`${serverBase}/demo`, { waitUntil: 'networkidle' });
  const popup = await context.newPage();
  const extensionPage = browserName === 'chrome'
    ? `chrome-extension://${extensionId}/popup.html`
    : `moz-extension://${(await context.pages())[0]?.url().split('/')[2] ?? ''}/popup.html`;
  await popup.goto(extensionPage, { waitUntil: 'domcontentloaded' });
  await popup.fill('#task', 'Review the enrollment details.');

  async function runPreview(highAssurance) {
    await popup.locator('details.advanced').evaluate((details) => { details.open = true; });
    await popup.locator('#highAssurance').setChecked(highAssurance);
    await demo.bringToFront();
    await popup.locator('#preview').evaluate((button) => button.click());
    await popup.waitForFunction((expectedMode) => {
      const receipt = document.querySelector('#privacyReceipt');
      const content = document.querySelector('#privacyReceiptContent')?.textContent ?? '';
      return receipt instanceof HTMLElement && !receipt.hidden &&
        content.includes(expectedMode);
    }, highAssurance ? 'structure-only' : 'sanitized-visual', { timeout: 15_000 });
    const receipt = await popup.locator('#privacyReceiptContent').innerText();
    const image = await popup.locator('#previewImage').getAttribute('src');
    if (!image?.startsWith('data:image/png;base64,')) throw new Error('Sanitized preview PNG is unavailable');
    return { receipt, image };
  }

  const semantic = await runPreview(false);
  evidence.semanticReceipt = semantic.receipt;
  evidence.checks.semanticPreview = semantic.receipt.includes('sanitized-visual');
  evidence.checks.receiptVisible = true;
  const structureOnly = await runPreview(true);
  evidence.structureOnlyReceipt = structureOnly.receipt;
  evidence.checks.structureOnlyPreview = structureOnly.receipt.includes('structure-only');
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  await fs.writeFile(path.join(root, `artifacts/sanitized-preview-${browserName}-semantic.png`), Buffer.from(semantic.image.split(',')[1], 'base64'));
  await fs.writeFile(path.join(root, `artifacts/sanitized-preview-${browserName}-structure-only.png`), Buffer.from(structureOnly.image.split(',')[1], 'base64'));
  if (!Object.values(evidence.checks).every(Boolean)) throw new Error('Browser privacy checks did not pass');
} catch (error) {
  evidence.status = 'failed';
  evidence.reason = error instanceof Error ? error.message : 'Browser matrix failed';
  throw error;
} finally {
  await writeEvidence(evidence);
  await context.close();
}
console.log(JSON.stringify(evidence));
