import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(
  pathToFileURL(path.join(root, '.tools', 'playwright', 'node_modules', 'playwright', 'index.mjs')).href,
);
const serverBase = process.env.PRIVACY_E2E_SERVER ?? 'http://127.0.0.1:8765';
const extensionSource = path.join(root, 'extension', 'dist', 'chrome');
const extensionCopy = path.join(root, '.runtime', 'preview-extension');
const profile = path.join(root, '.runtime', 'preview-profile');
const executable = path.join(root, '.runtime', 'cft-chromium', 'chrome-win', 'chrome.exe');

await fs.rm(extensionCopy, { recursive: true, force: true });
await fs.rm(profile, { recursive: true, force: true });
await fs.cp(extensionSource, extensionCopy, { recursive: true });
const manifestPath = path.join(extensionCopy, 'manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
delete manifest.optional_host_permissions;
// Headless automation cannot open the toolbar popup to grant activeTab. This
// temporary copy is isolated and used only to test local screenshot capture.
manifest.host_permissions = ['<all_urls>'];
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const context = await chromium.launchPersistentContext(profile, {
  executablePath: executable,
  headless: true,
  viewport: null,
  args: [`--disable-extensions-except=${extensionCopy}`, `--load-extension=${extensionCopy}`, '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,1000'],
});
try {
  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(serviceWorker.url()).hostname;
  const demo = await context.newPage();
  await demo.goto(`${serverBase}/demo`, { waitUntil: 'networkidle' });
  await demo.bringToFront();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await popup.fill('#task', 'Review the enrollment details.');
  await demo.bringToFront();
  await popup.locator('#preview').evaluate((button) => button.click());
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const state = await popup.locator('#state').textContent();
  const message = await popup.locator('#message').textContent();
  const detector = await popup.locator('#detector').textContent();
  const masks = await popup.locator('#redactions').textContent();
  const preview = popup.locator('#previewImage');
  const hasPreview = await preview.isVisible().catch(() => false);
  if (hasPreview) {
    const dataUrl = await preview.getAttribute('src');
    if (!dataUrl?.startsWith('data:image/png;base64,')) throw new Error('Sanitized preview PNG is unavailable');
    await fs.writeFile(path.join(root, 'artifacts', 'sanitized-preview-semantic.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
  console.log(JSON.stringify({ state, message, detector, masks, hasPreview }));
} finally {
  await context.close();
}
