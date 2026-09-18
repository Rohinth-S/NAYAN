import type { AgentStatus, ExtensionSettings, PopupCommand, PrivacyReceipt } from './types';
import { renderSanitizedDomPreview } from './dom-preview';
import { normalizePrivacyGrade, type PrivacyGrade } from './privacy-policy';
import { PERSISTED_SETTING_KEYS, serializePersistedSettings } from './settings';
import { taskPreset, TASK_PRESETS } from './task-presets';
import { ext } from './webext';

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element: ${id}`);
  return element as T;
};

const task = byId<HTMLTextAreaElement>('task');
const privacyGrade = byId<HTMLSelectElement>('privacyGrade');
const gradeSummary = byId<HTMLParagraphElement>('gradeSummary');
const endpoint = byId<HTMLInputElement>('endpoint');
const maxSteps = byId<HTMLInputElement>('maxSteps');
const apiKey = byId<HTMLInputElement>('apiKey');
const canaries = byId<HTMLTextAreaElement>('canaries');
const fallback = byId<HTMLInputElement>('fallback');
const highAssurance = byId<HTMLInputElement>('highAssurance');
const autoApproveLocalDemo = byId<HTMLInputElement>('autoApproveLocalDemo');
const start = byId<HTMLButtonElement>('start');


const preview = byId<HTMLButtonElement>('preview');
const stop = byId<HTMLButtonElement>('stop');
const state = byId<HTMLSpanElement>('state');
const message = byId<HTMLParagraphElement>('message');
const step = byId<HTMLElement>('step');
const detector = byId<HTMLElement>('detector');
const redactions = byId<HTMLElement>('redactions');
const maskedArea = byId<HTMLElement>('masked-area');
const latency = byId<HTMLElement>('latency');
const previewPane = byId<HTMLElement>('previewPane');
const previewFrame = byId<HTMLDivElement>('previewFrame');
const previewImage = byId<HTMLImageElement>('previewImage');
const expandPreview = byId<HTMLButtonElement>('expandPreview');
const domProof = byId<HTMLElement>('domProof');
const domProofContent = byId<HTMLElement>('domProofContent');
const toggleDomProof = byId<HTMLButtonElement>('toggleDomProof');
const privacyReceipt = byId<HTMLElement>('privacyReceipt');
const privacyReceiptContent = byId<HTMLElement>('privacyReceiptContent');
const previewModal = byId<HTMLDivElement>('previewModal');
const previewModalStage = byId<HTMLDivElement>('previewModalStage');
const previewModalImage = byId<HTMLImageElement>('previewModalImage');
const previewFullscreen = byId<HTMLButtonElement>('previewFullscreen');
const previewClose = byId<HTMLButtonElement>('previewClose');
const previewZoomOut = byId<HTMLButtonElement>('previewZoomOut');
const previewZoomValue = byId<HTMLOutputElement>('previewZoomValue');
const previewZoomIn = byId<HTMLButtonElement>('previewZoomIn');
const previewZoomReset = byId<HTMLButtonElement>('previewZoomReset');
const openPreviewTab = byId<HTMLButtonElement>('openPreviewTab');
const activityLog = document.getElementById('activityLog') as HTMLOListElement | null;

let previewReturnFocus: HTMLElement | null = null;
let previewZoom = 1;
// Side panels and extension popups can reject the native Fullscreen API.
// Keep a CSS viewport fallback so the control never silently does nothing.
let previewFallbackFullscreen = false;
let lastActivity = '';
let domProofOpen = true;
let lastDomSnapshotId = '';

const PREVIEW_ZOOM_MIN = 0.5;
const PREVIEW_ZOOM_MAX = 3;
const PREVIEW_ZOOM_STEP = 0.25;

function renderPreviewZoom(): void {
  const percentage = Math.round(previewZoom * 100);
  previewZoomValue.value = `${percentage}%`;
  previewZoomValue.textContent = `${percentage}%`;
  previewModalImage.style.setProperty('--preview-scale', String(previewZoom));
  previewModalStage.classList.toggle('is-zoomed', previewZoom > 1);
  previewZoomOut.disabled = previewZoom <= PREVIEW_ZOOM_MIN;
  previewZoomIn.disabled = previewZoom >= PREVIEW_ZOOM_MAX;
  previewZoomReset.disabled = previewZoom === 1;
}

function setPreviewZoom(value: number): void {
  const next = Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, value));
  previewZoom = Math.round(next / PREVIEW_ZOOM_STEP) * PREVIEW_ZOOM_STEP;
  renderPreviewZoom();
}

function renderPreviewFullscreenState(): void {
  const native = document.fullscreenElement === previewModal;
  const active = native || previewFallbackFullscreen;
  previewFullscreen.textContent = active ? 'Exit fullscreen' : 'Fullscreen';
  previewFullscreen.setAttribute('aria-pressed', String(active));
  previewModal.classList.toggle('is-native-fullscreen', native);
  previewModal.classList.toggle('is-fallback-fullscreen', previewFallbackFullscreen);
}

async function togglePreviewFullscreen(): Promise<void> {
  if (document.fullscreenElement === previewModal) {
    await document.exitFullscreen();
    return;
  }
  if (previewFallbackFullscreen) {
    previewFallbackFullscreen = false;
    renderPreviewFullscreenState();
    return;
  }
  if (!previewModal.requestFullscreen) {
    previewFallbackFullscreen = true;
    renderPreviewFullscreenState();
    void ext.tabs.create({ url: ext.runtime.getURL('preview.html') });
    return;
  }
  try {
    await previewModal.requestFullscreen();
    if (document.fullscreenElement !== previewModal) {
      previewFallbackFullscreen = true;
      renderPreviewFullscreenState();
      void ext.tabs.create({ url: ext.runtime.getURL('preview.html') });
      return;
    }
    renderPreviewFullscreenState();
  } catch {
    // Firefox and some embedded Chromium side panels can refuse fullscreen.
    // The dedicated preview tab is the reliable full-viewport fallback.
    previewFallbackFullscreen = true;
    renderPreviewFullscreenState();
    void ext.tabs.create({ url: ext.runtime.getURL('preview.html') });
  }
}

function recordActivity(phase: AgentStatus['phase'], text: string): void {
  if (!activityLog || !text || text === lastActivity) return;
  lastActivity = text;
  const item = document.createElement('li');
  const dot = document.createElement('span');
  dot.className = 'activity-dot';
  const copy = document.createElement('span');
  copy.textContent = text;
  item.append(dot, copy);
  activityLog.append(item);
  while (activityLog.children.length > 12) activityLog.firstElementChild?.remove();
  // Keep the newest event in view without stealing focus from a running task.
  activityLog.scrollTop = activityLog.scrollHeight;
  item.dataset.phase = phase;
}

function openPreviewViewer(): void {
  const source = previewImage.currentSrc || previewImage.src;
  if (!source) return;
  previewReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previewModalImage.src = source;
  setPreviewZoom(1);
  previewFallbackFullscreen = false;
  previewModal.hidden = false;
  document.body.classList.add('preview-open');
  previewClose.focus();
}

function closePreviewViewer(): void {
  if (previewModal.hidden) return;
  if (document.fullscreenElement === previewModal) void document.exitFullscreen();
  previewFallbackFullscreen = false;
  renderPreviewFullscreenState();
  previewModal.hidden = true;
  document.body.classList.remove('preview-open');
  previewModalImage.removeAttribute('src');
  const target = previewReturnFocus;
  previewReturnFocus = null;
  if (target?.isConnected) target.focus();
}

// Starter tasks make the first run discoverable without sending anything to
// the server. The selected text remains editable and is persisted only when
// the user starts a run, just like manually entered task text.
function installTaskPresets(): void {
  const field = task.closest('label');
  const panel = field?.parentElement;
  if (!field || !panel || document.getElementById('taskPreset')) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'task-presets';
  const label = document.createElement('label');
  label.htmlFor = 'taskPreset';
  label.textContent = 'Quick start';
  const select = document.createElement('select');
  select.id = 'taskPreset';
  select.setAttribute('aria-label', 'Choose a starter task');
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose a starter task…';
  placeholder.selected = true;
  select.append(placeholder);
  for (const preset of TASK_PRESETS) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    select.append(option);
  }
  select.addEventListener('change', () => {
    const preset = taskPreset(select.value);
    if (!preset) return;
    task.value = preset.task;
    task.dispatchEvent(new Event('input', { bubbles: true }));
  });
  label.append(select);
  wrapper.append(label);
  panel.insertBefore(wrapper, field);
}

installTaskPresets();

// Keep form-validation feedback visible while the background status poll runs.
// Without this, the 500 ms GET_STATUS poll immediately replaced local errors
// such as "Enter a task first" with the background's stale "Ready" message.
let popupError: string | null = null;

function settings(): ExtensionSettings {
  return {
    endpoint: endpoint.value.trim(),
    apiKey: apiKey.value,
    task: task.value.trim(),
    maxSteps: Number(maxSteps.value),
    privacyGrade: normalizePrivacyGrade(Number(privacyGrade.value)),
    allowFullMaskFallback: fallback.checked,
    highAssuranceMode: highAssurance.checked,
    autoApproveLocalDemo: autoApproveLocalDemo.checked,
    canaries: canaries.value.split(/\r?\n/u).map((item) => item.trim()).filter((item) => item.length >= 3),
  };
}

const gradeSummaries: Readonly<Record<PrivacyGrade, string>> = {
  1: 'Essential protection. Names and ordinary contact details may be shared.',
  2: 'Balanced protection. Names and professional context may be shared.',
  3: 'Strict protection. Names and all unknown populated fields are hidden.',
};

function renderPrivacyGrade(value: unknown): void {
  const grade = normalizePrivacyGrade(value);
  privacyGrade.value = String(grade);
  gradeSummary.textContent = gradeSummaries[grade];
}

function endpointOriginPattern(raw: string): string {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Endpoint must use HTTP(S)');
  return `${url.origin}/*`;
}

function receiptRows(receipt: PrivacyReceipt): ReadonlyArray<readonly [string, string]> {
  const categories = Object.entries(receipt.redactionCategories)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${kind}: ${count}`)
    .join(' · ') || 'none';
  return [
    ['Privacy grade', `Grade ${receipt.privacyGrade}`],
    ['Detector', receipt.detectorBackend],
    ['Transmission', receipt.transmissionMode],
    ['Redaction mode', receipt.redactionMode],
    ['Categories', categories],
    ['Masked area', `${receipt.maskedAreaPercentage}%`],
    ['Request count', String(receipt.requestCount)],
    ['Egress', receipt.sent ? 'accepted by server' : 'local preview / not sent'],
    ['Sanitized image hash', receipt.imageSha256],
  ];
}

function renderPrivacyReceipt(receipt: PrivacyReceipt | null): void {
  if (!receipt) {
    privacyReceipt.hidden = true;
    privacyReceiptContent.replaceChildren();
    return;
  }
  privacyReceipt.hidden = false;
  privacyReceiptContent.replaceChildren();
  for (const [label, value] of receiptRows(receipt)) {
    const wrapper = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    wrapper.append(dt, dd);
    privacyReceiptContent.append(wrapper);
  }
}

async function ensureEndpointPermission(raw: string): Promise<void> {
  const origin = endpointOriginPattern(raw);
  if (await ext.permissions.contains({ origins: [origin] })) return;
  let granted: boolean;
  try {
    granted = await ext.permissions.request({ origins: [origin] });
  } catch {
    throw new Error('Reasoning endpoint permission request was rejected');
  }
  if (!granted) throw new Error('Reasoning endpoint permission was not granted');
}

/**
 * Persistent side panels do not reliably retain Chrome's temporary
 * `activeTab` grant when the user switches tabs after opening the panel. The
 * manifests therefore declare HTTP(S) host access for the prototype. This
 * check keeps the user-facing error actionable before the background worker
 * attempts local scripting and screenshot capture.
 */
async function ensurePagePermission(): Promise<void> {
  const lastFocused = await ext.tabs.query({ active: true, lastFocusedWindow: true });
  const currentWindow = await ext.tabs.query({ active: true, currentWindow: true });
  const candidates = [...lastFocused, ...currentWindow];
  const tab = candidates.find((candidate) => {
    if (!candidate?.id || !candidate.url) return false;
    try {
      return ['http:', 'https:'].includes(new URL(candidate.url).protocol);
    } catch {
      return false;
    }
  });
  if (!tab?.url) {
    const candidate = candidates.find((item) => item?.id);
    if (!candidate?.url) throw new Error('No active browser tab. Open an HTTP(S) page and retry');
    throw new Error('Only HTTP(S) pages are supported. Open the demo or another website and retry');
  }
  // The manifest requests the broad Chrome capture grant, but users can still
  // switch an unpacked extension to a restricted site-access mode. Confirm the
  // concrete origin here while handling the button click and request it if the
  // browser is withholding it. This request grants local page access only; it
  // never grants the reasoning endpoint or permits raw page egress.
  const pageOrigin = endpointOriginPattern(tab.url);
  if (await ext.permissions.contains({ origins: [pageOrigin] })) return;
  let granted = false;
  try {
    granted = await ext.permissions.request({ origins: [pageOrigin] });
  } catch {
    throw new Error('Page access permission request was rejected. Enable site access for this extension and retry');
  }
  if (!granted) throw new Error('Page access permission was not granted. Enable site access for this extension and retry');
}

async function send(command: PopupCommand): Promise<AgentStatus> {
  return (await ext.runtime.sendMessage(command)) as AgentStatus;
}

function render(current: AgentStatus): void {
  state.textContent = current.phase;
  state.dataset.phase = current.phase;
  const staleGrade = current.sanitizedDomPreview !== null
    && current.sanitizedDomPreview.grade !== normalizePrivacyGrade(Number(privacyGrade.value));
  const visibleMessage = popupError ?? (staleGrade && !current.running
    ? 'Privacy grade changed. Generate a new Privacy preview to apply it.'
    : current.message);
  message.textContent = visibleMessage;
  recordActivity(current.phase, visibleMessage);
  step.textContent = String(current.step);
  const hasRun = current.phase !== 'idle' ||
    current.step > 0 ||
    current.redactionCount > 0 ||
    current.previewDataUrl !== null ||
    current.sanitizedDomPreview !== null;
  detector.textContent = hasRun ? current.detectorBackend : 'not run';
  redactions.textContent = String(current.redactionCount);
  maskedArea.textContent = current.maskedAreaPercentage !== undefined ? `${current.maskedAreaPercentage}%` : '—';
  latency.textContent = current.lastLatencyMs === null ? '—' : `${current.lastLatencyMs} ms`;
  renderPrivacyReceipt(current.privacyReceipt);
  start.disabled = current.running;
  preview.disabled = current.running;
  stop.disabled = !current.running;
  privacyGrade.disabled = current.running;
  if (staleGrade) {
    closePreviewViewer();
    privacyReceipt.hidden = true;
  }
  if (current.previewDataUrl && !staleGrade) {
    previewImage.src = current.previewDataUrl;
    if (!previewModal.hidden) previewModalImage.src = current.previewDataUrl;
    previewPane.hidden = false;
  } else {
    previewPane.hidden = true;
    previewImage.removeAttribute('src');
  }
  const domPreview = current.sanitizedDomPreview;
  if (!domPreview || staleGrade) {
    domProof.hidden = true;
    domProofContent.replaceChildren();
    lastDomSnapshotId = '';
    return;
  }
  domProof.hidden = false;
  if (domPreview.snapshotId !== lastDomSnapshotId) {
    renderSanitizedDomPreview(domProofContent, domPreview);
    lastDomSnapshotId = domPreview.snapshotId;
    domProofOpen = true;
  }
  domProofContent.hidden = !domProofOpen;
  toggleDomProof.textContent = domProofOpen ? 'Hide DOM proof' : 'Show DOM proof';
  toggleDomProof.setAttribute('aria-expanded', String(domProofOpen));
}

async function run(type: 'START' | 'PREVIEW'): Promise<void> {
  popupError = null;
  try {
    const value = settings();
    if (type === 'START' && !value.task) throw new Error('Enter a task first');
    // Ask while handling the user's explicit button click. This is required
    // for persistent Chrome side panels after a tab switch; activeTab alone
    // can otherwise be missing when the background worker injects content.js.
    await ensurePagePermission();
    if (type === 'START') await ensureEndpointPermission(value.endpoint);
    await ext.storage.local.set(serializePersistedSettings(value));
    render(await send({ type, settings: value }));
  } catch (error) {
    popupError = error instanceof Error ? error.message : 'Could not start';
    message.textContent = popupError;
  }
}

start.addEventListener('click', () => void run('START'));
preview.addEventListener('click', () => void run('PREVIEW'));
stop.addEventListener('click', () => void send({ type: 'STOP' }).then(render));
previewFrame.addEventListener('click', openPreviewViewer);
previewFrame.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openPreviewViewer();
  }
});
expandPreview.addEventListener('click', (event) => {
  event.stopPropagation();
  openPreviewViewer();
  // In the persistent side panel, the entry button can request native
  // fullscreen in the same user gesture. The toolbar button remains available
  // inside the modal when a browser declines that request.
  if (document.body.classList.contains('sidepanel')) void togglePreviewFullscreen();
});
toggleDomProof.addEventListener('click', () => {
  domProofOpen = !domProofOpen;
  domProofContent.hidden = !domProofOpen;
  toggleDomProof.textContent = domProofOpen ? 'Hide DOM proof' : 'Show DOM proof';
  toggleDomProof.setAttribute('aria-expanded', String(domProofOpen));
});
previewClose.addEventListener('click', closePreviewViewer);
previewFullscreen.addEventListener('click', () => void togglePreviewFullscreen());
previewZoomOut.addEventListener('click', () => setPreviewZoom(previewZoom - PREVIEW_ZOOM_STEP));
previewZoomIn.addEventListener('click', () => setPreviewZoom(previewZoom + PREVIEW_ZOOM_STEP));
previewZoomReset.addEventListener('click', () => setPreviewZoom(1));
previewModalStage.addEventListener('wheel', (event) => {
  if (previewModal.hidden || (!event.ctrlKey && !event.metaKey)) return;
  event.preventDefault();
  setPreviewZoom(previewZoom + (event.deltaY < 0 ? PREVIEW_ZOOM_STEP : -PREVIEW_ZOOM_STEP));
}, { passive: false });
openPreviewTab.addEventListener('click', () => {
  void ext.tabs.create({ url: ext.runtime.getURL('preview.html') });
});
previewModal.addEventListener('click', (event) => {
  if (event.target instanceof HTMLElement && event.target.dataset.previewClose === 'true') closePreviewViewer();
});
document.addEventListener('keydown', (event) => {
  if (previewModal.hidden) return;
  if (event.key === 'Escape') {
    if (document.fullscreenElement === previewModal) {
      void document.exitFullscreen();
    } else if (previewFallbackFullscreen) {
      previewFallbackFullscreen = false;
      renderPreviewFullscreenState();
    } else {
      closePreviewViewer();
    }
    return;
  }
  if (event.key === '+' || event.key === '=') {
    event.preventDefault();
    setPreviewZoom(previewZoom + PREVIEW_ZOOM_STEP);
  } else if (event.key === '-') {
    event.preventDefault();
    setPreviewZoom(previewZoom - PREVIEW_ZOOM_STEP);
  } else if (event.key === '0') {
    event.preventDefault();
    setPreviewZoom(1);
  }
});
document.addEventListener('fullscreenchange', renderPreviewFullscreenState);
renderPreviewZoom();
renderPreviewFullscreenState();
privacyGrade.addEventListener('change', () => {
  popupError = null;
  const grade = normalizePrivacyGrade(Number(privacyGrade.value));
  renderPrivacyGrade(grade);
  void ext.storage.local.set({ privacyGrade: grade });
});

for (const field of [task, endpoint, maxSteps, apiKey, canaries, fallback, highAssurance, autoApproveLocalDemo]) {
  field.addEventListener('input', () => {
    popupError = null;
  });
}

renderPrivacyGrade(3);
void ext.storage.local.get([...PERSISTED_SETTING_KEYS]).then((saved) => {
  if (typeof saved.endpoint === 'string') endpoint.value = saved.endpoint;
  if (typeof saved.maxSteps === 'number') maxSteps.value = String(saved.maxSteps);
  if (typeof saved.allowFullMaskFallback === 'boolean') fallback.checked = saved.allowFullMaskFallback;
  if (typeof saved.highAssuranceMode === 'boolean') highAssurance.checked = saved.highAssuranceMode;
  if (typeof saved.autoApproveLocalDemo === 'boolean') autoApproveLocalDemo.checked = saved.autoApproveLocalDemo;
  renderPrivacyGrade(saved.privacyGrade);
});

const poll = async (): Promise<void> => {
  try {
    render(await send({ type: 'GET_STATUS' }));
  } catch {
    if (!popupError) message.textContent = 'Background agent is unavailable';
  }
};
void poll();
setInterval(() => void poll(), 500);
