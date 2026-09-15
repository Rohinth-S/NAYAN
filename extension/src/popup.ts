import type { AgentStatus, ExtensionSettings, PopupCommand } from './types';
import { normalizePrivacyGrade, type PrivacyGrade } from './privacy-policy';
import { PERSISTED_SETTING_KEYS, serializePersistedSettings } from './settings';
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
const latency = byId<HTMLElement>('latency');
const previewPane = byId<HTMLElement>('previewPane');
const previewImage = byId<HTMLImageElement>('previewImage');

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
  message.textContent = current.message;
  step.textContent = String(current.step);
  detector.textContent = current.detectorBackend;
  redactions.textContent = String(current.redactionCount);
  latency.textContent = current.lastLatencyMs === null ? '—' : `${current.lastLatencyMs} ms`;
  start.disabled = current.running;
  preview.disabled = current.running;
  stop.disabled = !current.running;
  if (current.previewDataUrl) {
    previewImage.src = current.previewDataUrl;
    previewPane.hidden = false;
  }
}

async function run(type: 'START' | 'PREVIEW'): Promise<void> {
  try {
    const value = settings();
    if (!value.task) throw new Error('Enter a task first');
    if (type === 'START') await ensureEndpointPermission(value.endpoint);
    await ext.storage.local.set(serializePersistedSettings(value));
    render(await send({ type, settings: value }));
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : 'Could not start';
  }
}

start.addEventListener('click', () => void run('START'));
preview.addEventListener('click', () => void run('PREVIEW'));
stop.addEventListener('click', () => void send({ type: 'STOP' }).then(render));
privacyGrade.addEventListener('change', () => {
  const grade = normalizePrivacyGrade(Number(privacyGrade.value));
  renderPrivacyGrade(grade);
  void ext.storage.local.set({ privacyGrade: grade });
});

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
    message.textContent = 'Background agent is unavailable';
  }
};
void poll();
setInterval(() => void poll(), 500);
