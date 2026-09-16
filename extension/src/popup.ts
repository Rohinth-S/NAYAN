import type { AgentStatus, ExtensionSettings, PopupCommand } from './types';
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
const previewModal = byId<HTMLDivElement>('previewModal');
const previewModalImage = byId<HTMLImageElement>('previewModalImage');
const previewClose = byId<HTMLButtonElement>('previewClose');
const openPreviewTab = byId<HTMLButtonElement>('openPreviewTab');
const activityLog = document.getElementById('activityLog') as HTMLOListElement | null;

let previewReturnFocus: HTMLElement | null = null;
let lastActivity = '';

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
  previewModal.hidden = false;
  document.body.classList.add('preview-open');
  previewClose.focus();
}

function closePreviewViewer(): void {
  if (previewModal.hidden) return;
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

async function ensureEndpointPermission(raw: string): Promise<void> {
  const origin = endpointOriginPattern(raw);
  const granted = await ext.permissions.request({ origins: [origin] });
  if (!granted) throw new Error('Reasoning endpoint permission was not granted');
}

async function send(command: PopupCommand): Promise<AgentStatus> {
  return (await ext.runtime.sendMessage(command)) as AgentStatus;
}

function render(current: AgentStatus): void {
  state.textContent = current.phase;
  state.dataset.phase = current.phase;
  const visibleMessage = popupError ?? current.message;
  message.textContent = visibleMessage;
  recordActivity(current.phase, visibleMessage);
  step.textContent = String(current.step);
  const hasRun = current.phase !== 'idle' || current.step > 0 || current.redactionCount > 0 || current.previewDataUrl !== null;
  detector.textContent = hasRun ? current.detectorBackend : 'not run';
  redactions.textContent = String(current.redactionCount);
  maskedArea.textContent = current.maskedAreaPercentage !== undefined ? `${current.maskedAreaPercentage}%` : '—';
  latency.textContent = current.lastLatencyMs === null ? '—' : `${current.lastLatencyMs} ms`;
  start.disabled = current.running;
  preview.disabled = current.running;
  stop.disabled = !current.running;
  if (current.previewDataUrl) {
    previewImage.src = current.previewDataUrl;
    if (!previewModal.hidden) previewModalImage.src = current.previewDataUrl;
    previewPane.hidden = false;
  }
}

async function run(type: 'START' | 'PREVIEW'): Promise<void> {
  popupError = null;
  try {
    const value = settings();
    if (type === 'START' && !value.task) throw new Error('Enter a task first');
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
expandPreview.addEventListener('click', openPreviewViewer);
previewClose.addEventListener('click', closePreviewViewer);
openPreviewTab.addEventListener('click', () => {
  void ext.tabs.create({ url: ext.runtime.getURL('preview.html') });
});
previewModal.addEventListener('click', (event) => {
  if (event.target instanceof HTMLElement && event.target.dataset.previewClose === 'true') closePreviewViewer();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !previewModal.hidden) closePreviewViewer();
});
privacyGrade.addEventListener('change', () => {
  popupError = null;
  const grade = normalizePrivacyGrade(Number(privacyGrade.value));
  renderPrivacyGrade(grade);
  void ext.storage.local.set({ privacyGrade: grade });
});

for (const field of [task, endpoint, maxSteps, apiKey, canaries, fallback]) {
  field.addEventListener('input', () => {
    popupError = null;
  });
}

renderPrivacyGrade(3);
void ext.storage.local.get([...PERSISTED_SETTING_KEYS]).then((saved) => {
  if (typeof saved.endpoint === 'string') endpoint.value = saved.endpoint;
  if (typeof saved.maxSteps === 'number') maxSteps.value = String(saved.maxSteps);
  if (typeof saved.allowFullMaskFallback === 'boolean') fallback.checked = saved.allowFullMaskFallback;
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
