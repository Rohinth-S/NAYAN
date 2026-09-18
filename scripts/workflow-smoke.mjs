// Isolated synthetic browser -> sanitizer -> HTTP server -> action broker test.
// Uses the development structural planner; this is NOT model-accuracy evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(pathToFileURL(path.join(root, '.tools/playwright/node_modules/playwright/index.mjs')).href);
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const python = path.join(root, 'server/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const smokeKey = 'workflow-smoke-key-2026-09-18';
const child = spawn(python, ['-c', `import uvicorn; from pydantic import SecretStr; from app.main import create_app; from app.settings import Settings; uvicorn.run(create_app(Settings(ollama_model='workflow-smoke-no-model',structural_fallback=True,api_key=SecretStr('${smokeKey}'),require_api_key=True)),host='127.0.0.1',port=${port},access_log=False,log_level='error')`], {
  cwd: path.join(root, 'server'), stdio: 'ignore', windowsHide: true,
});
let startupError;
child.on('error', error => { startupError = error; });
let context;
const started = Date.now();
try {
  for (let i = 0; i < 60; i++) {
    if (startupError || child.exitCode !== null) throw new Error('Isolated smoke server failed to start');
    const response = await fetch(`${base}/health/live`).catch(() => null);
    if (response?.ok) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert((await fetch(`${base}/health/live`)).ok);
  const profile = await fs.mkdtemp(path.join(root, '.runtime', 'workflow-smoke-'));
  const extension = path.join(root, 'extension/dist/chrome');
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.PRIVACY_E2E_CHROME_EXECUTABLE ?? path.join(root, '.runtime/cft-chromium/chrome-win/chrome.exe'),
    headless: true, viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox', '--window-size=1280,1000'],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const demo = await context.newPage();
  let confirmations = 0;
  demo.on('dialog', async dialog => {
    assert.equal(dialog.type(), 'confirm');
    confirmations++;
    await dialog.accept(); // Only this isolated synthetic enrollment is authorized.
  });
  await demo.goto(`${base}/demo`, { waitUntil: 'networkidle' });
  await demo.locator('#consent').scrollIntoViewIfNeeded();
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/popup.html`);
  await demo.bringToFront();
  await demo.waitForTimeout(400);
  const run = panel.evaluate(settings => chrome.runtime.sendMessage({ type: 'START', settings }), {
    endpoint: `${base}/v1/reason`, apiKey: smokeKey,
    task: 'Check the confirmation checkbox, then submit the enrollment.',
    maxSteps: 8, privacyGrade: 3, allowFullMaskFallback: false, highAssuranceMode: false,
    canaries: ['SIH-Canary-Password-93!', 'SIH-ATTR-CANARY-8841'],
  });
  let timeout;
  const result = await Promise.race([run, new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Workflow smoke timed out')), 120_000);
  })]).finally(() => clearTimeout(timeout));
  assert.equal(new URL(demo.url()).pathname, '/demo/success', result.message);
  assert.match(await demo.locator('#success-heading').innerText(), /Enrollment submitted\s+successfully\./);
  assert.equal((await (await fetch(`${base}/demo/api/state`)).json()).submitted, true);
  assert.equal(result.phase, 'done', result.message);
  assert(confirmations > 0, 'Native confirmation must run before submit');
  const report = {
    scope: 'synthetic-Chrome-structural-planner-workflow', status: 'passed',
    steps: result.step, detector: result.detectorBackend, confirmations,
    submitted: true, redirectedToSuccess: true, modelInferenceTested: false, elapsedMs: Date.now() - started,
  };
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  await fs.writeFile(path.join(root, 'artifacts/workflow-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await context?.close();
  child.kill();
}
