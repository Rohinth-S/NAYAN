import { CaptureRateGate } from './capture-rate-gate';
import { sameTabContext, type TabContext } from './context-guard';
import { sendSanitizedObservation, type ReasoningRequestOptions } from './egress';
import { localSanitizer } from '#local-sanitizer';
import { isOffscreenMessage } from './offscreen-protocol';
import { pseudonymizeOrigin, sanitizeText } from './privacy';
import { isPrivacyGrade, REGISTRY_DIGEST } from './privacy-policy';
import { SCHEMA_VERSION, type AgentAction, type AgentStatus, type ContentResponse, type ExtensionSettings, type PopupCommand, type RawDomSnapshot, type SanitizedObservation, type ScrollDriftState } from './types';
import { validateObservation, type ObservationValidationOptions } from './validation';
import { ext } from './webext';

const originAliasKey = crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const captureRateGate = new CaptureRateGate();
let stopRequested = false;
let activeRun = 0;
let activeReasoningController: AbortController | null = null;
const tabUpdateGeneration = new Map<number, number>();
const windowActivationGeneration = new Map<number, number>();
let status: AgentStatus = {
  running: false,
  phase: 'idle',
  message: 'Ready',
  step: 0,
  detectorBackend: localSanitizer.state,
  redactionCount: 0,
  lastLatencyMs: null,
  previewDataUrl: null,
};

type CapturedContext = {
  tab: TabContext;
  dom: RawDomSnapshot;
  observation: SanitizedObservation;
  documentRevision: number;
  tabGeneration: number;
  windowGeneration: number;
};

function update(patch: Partial<AgentStatus>): void {
  status = { ...status, ...patch };
}

function safeMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Operation failed safely';
  const allowed = [
    'blocked', 'unavailable', 'invalid', 'stale', 'changed', 'permission', 'rejected', 'too large', 'forbidden',
    'unsupported', 'missing', 'failed', 'not a PNG', 'endpoint', 'origin', 'detector', 'target', 'editable', 'option',
  ];
  return allowed.some((word) => error.message.toLowerCase().includes(word)) ? error.message.slice(0, 240) : 'Operation failed safely';
}

function reportBlockedOperation(stage: string, error: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message.slice(0, 240)}` : 'unknown error';
  // This is a local diagnostic only. It never enters the observation or the
  // reasoning request, and helps distinguish browser capability failures from
  // a deliberate privacy block during a demo.
  console.warn(`[privacy-agent] ${stage} blocked (${detail})`);
}

async function keepServiceWorkerAlive<T>(operation: Promise<T>): Promise<T> {
  // Chrome documents this bounded extension-API heartbeat for exceptional
  // operations that may outlive the MV3 worker's normal idle window. It runs
  // only while one sanitized reasoning request is outstanding.
  const heartbeat = setInterval(() => {
    void ext.runtime.getPlatformInfo().catch(() => undefined);
  }, 20_000);
  try {
    return await operation;
  } finally {
    clearInterval(heartbeat);
  }
}

function validateSettings(settings: ExtensionSettings, requireTask = true): void {
  if ((requireTask && !settings.task.trim()) || settings.task.length > 2_000) throw new Error('Task is invalid');
  if (!Number.isInteger(settings.maxSteps) || settings.maxSteps < 1 || settings.maxSteps > 30) throw new Error('Step count is invalid');
  if (settings.apiKey.length > 1_000) throw new Error('API key is invalid');
  if (!isPrivacyGrade(settings.privacyGrade)) throw new Error('Privacy grade is invalid');
  if (settings.canaries.length > 100 || settings.canaries.some((item) => item.length > 500)) throw new Error('Canary list is invalid');
}

async function activeTab(): Promise<TabContext> {
  const tabs = await ext.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id || tab.windowId === undefined || !tab.url) throw new Error('Active tab is unavailable');
  const url = new URL(tab.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) pages are supported');
  return { id: tab.id, windowId: tab.windowId, origin: url.origin };
}

async function ensureContent(tabId: number): Promise<void> {
  try {
    const response = (await ext.tabs.sendMessage(tabId, { type: 'PING' })) as ContentResponse;
    if (response?.ok) return;
  } catch {
    // Expected before the first user-authorized injection.
  }
  const api = ext as typeof ext & {
    scripting?: { executeScript(options: { target: { tabId: number }; files: string[] }): Promise<unknown> };
    tabs: typeof ext.tabs & { executeScript?: (tabId: number, details: { file: string }) => Promise<unknown> };
  };
  if (api.scripting?.executeScript) await api.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  else if (api.tabs.executeScript) await api.tabs.executeScript(tabId, { file: 'content.js' });
  else throw new Error('Content injection is unavailable');
}

async function captureVisible(windowId: number): Promise<string> {
  const delayMs = captureRateGate.reserve(performance.now());
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const dataUrl = await ext.tabs.captureVisibleTab(windowId, { format: 'png' });
  if (typeof dataUrl !== 'string') throw new Error('Screenshot capture failed');
  return dataUrl;
}

async function captureAndSanitize(
  settings: ExtensionSettings,
  pinnedTab?: TabContext,
  validationOptions: ObservationValidationOptions = {},
): Promise<CapturedContext> {
  const visibleTab = await activeTab();
  const tab = pinnedTab ?? visibleTab;
  if (pinnedTab && !sameTabContext(pinnedTab, visibleTab)) {
    throw new Error('Active tab changed before capture');
  }
  const initialTabGeneration = tabUpdateGeneration.get(tab.id) ?? 0;
  const initialWindowGeneration = windowActivationGeneration.get(tab.windowId) ?? 0;
  await ensureContent(tab.id);
  const snapshotId = crypto.randomUUID();
  update({ phase: 'capturing', message: 'Capturing locally…' });
  const contentResponse = (await ext.tabs.sendMessage(tab.id, {
    type: 'CAPTURE_DOM', snapshotId, knownValues: settings.canaries, privacyGrade: settings.privacyGrade,
  })) as ContentResponse;
  if (!contentResponse.ok || !contentResponse.snapshot) throw new Error(contentResponse.ok ? 'DOM capture failed' : contentResponse.error);
  const dom = contentResponse.snapshot;
  if (dom.origin !== tab.origin) throw new Error('Tab origin changed during capture');
  const screenshot = await captureVisible(tab.windowId);
  const tabAfterCapture = await activeTab();
  if (
    !sameTabContext(tab, tabAfterCapture) ||
    (tabUpdateGeneration.get(tab.id) ?? 0) !== initialTabGeneration ||
    (windowActivationGeneration.get(tab.windowId) ?? 0) !== initialWindowGeneration
  ) {
    throw new Error('Active tab changed during screenshot capture');
  }
  update({ phase: 'sanitizing', message: 'Running local privacy filters…' });
  const raster = await localSanitizer.sanitize(
    screenshot,
    dom,
    settings.allowFullMaskFallback,
    settings.canaries,
    settings.privacyGrade,
    settings.task,
  );
  // Do not retain the raw screenshot. Only the freshly encoded sanitized PNG is kept for preview/request.
  const observation: SanitizedObservation = {
    schemaVersion: SCHEMA_VERSION,
    snapshotId,
    documentId: dom.documentId,
    page: {
      origin: await pseudonymizeOrigin(dom.origin, await originAliasKey),
      title: sanitizeText(raster.safeTitle ?? dom.title, settings.canaries, 300, settings.privacyGrade),
    },
    task: sanitizeText(raster.safeTask ?? settings.task, settings.canaries, 2_000, settings.privacyGrade),
    elements: raster.elements,
    image: { mime: 'image/png', dataBase64: raster.dataBase64, width: raster.width, height: raster.height },
    redactions: raster.redactions,
    privacy: {
      grade: settings.privacyGrade,
      detectorBackend: raster.detectorBackend,
      visualFallback: raster.visualFallback,
      rawImageRetained: false,
      redactionMode: raster.redactionMode,
      registryDigest: REGISTRY_DIGEST,
      ...(raster.detectorArch ? { detectorArch: raster.detectorArch } : {}),
    },
  };
  const revisionResponse = (await ext.tabs.sendMessage(tab.id, { type: 'VERIFY_REVISION' })) as ContentResponse;
  const revision = revisionResponse.ok ? revisionResponse.revision : undefined;
  if (
    !revision ||
    revision.documentId !== dom.documentId ||
    revision.documentRevision !== dom.documentRevision ||
    revision.origin !== dom.origin ||
    revision.viewport.width !== dom.viewport.width ||
    revision.viewport.height !== dom.viewport.height ||
    revision.viewport.scrollX !== dom.viewport.scrollX ||
    revision.viewport.scrollY !== dom.viewport.scrollY
  ) {
    throw new Error('Document changed during capture or local sanitization');
  }
  validateObservation(observation, validationOptions);
  update({
    detectorBackend: raster.detectorBackend,
    redactionCount: raster.redactions.length,
    previewDataUrl: raster.previewDataUrl,
    categoryCounts: raster.categoryCounts,
    maskedAreaPercentage: raster.maskedAreaPercentage,
    message: `Sanitized locally (${raster.redactions.length} masks)`,
  });
  return {
    tab,
    dom,
    observation,
    documentRevision: dom.documentRevision,
    tabGeneration: initialTabGeneration,
    windowGeneration: initialWindowGeneration,
  };
}

async function setScrollGuard(tabId: number, active: boolean): Promise<ScrollDriftState> {
  const response = await ext.tabs.sendMessage(tabId, { type: 'SET_SCROLL_GUARD', active }) as ContentResponse;
  if (!response.ok || !response.scrollDrift) throw new Error('Scroll-drift guard is unavailable');
  return response.scrollDrift;
}

async function execute(context: CapturedContext, action: AgentAction): Promise<string> {
  const visibleTab = await activeTab();
  if (
    !sameTabContext(context.tab, visibleTab) ||
    (tabUpdateGeneration.get(context.tab.id) ?? 0) !== context.tabGeneration ||
    (windowActivationGeneration.get(context.tab.windowId) ?? 0) !== context.windowGeneration
  ) {
    throw new Error('Active tab changed before action');
  }
  const current = await ext.tabs.get(context.tab.id);
  if (!current.url || new URL(current.url).origin !== context.tab.origin) throw new Error('Tab origin changed before action');
  const response = (await ext.tabs.sendMessage(context.tab.id, {
    type: 'EXECUTE_ACTION',
    snapshotId: context.observation.snapshotId,
    documentId: context.dom.documentId,
    documentRevision: context.documentRevision,
    action,
  })) as ContentResponse;
  if (!response.ok) throw new Error(response.error);
  return response.result ?? 'Action executed';
}

async function preview(settings: ExtensionSettings): Promise<void> {
  if (status.running) throw new Error('Agent is already running');
  // A preview is a local privacy inspection and does not need a user goal.
  // Agent execution still validates a non-empty task before any capture.
  validateSettings(settings, false);
  update({ running: true, phase: 'capturing', step: 0, message: 'Preparing privacy preview…', previewDataUrl: null });
  try {
    await captureAndSanitize(settings, undefined, { allowEmptyTask: true });
    update({ running: false, phase: 'idle', message: 'Preview ready. No data was sent.' });
  } catch (error) {
    reportBlockedOperation('preview', error);
    update({ running: false, phase: 'blocked', message: safeMessage(error) });
  }
}

async function runAgent(settings: ExtensionSettings): Promise<void> {
  if (status.running) throw new Error('Agent is already running');
  validateSettings(settings);
  const runId = ++activeRun;
  const reasoningController = new AbortController();
  activeReasoningController = reasoningController;
  stopRequested = false;
  update({ running: true, phase: 'capturing', step: 0, message: 'Starting locally…', previewDataUrl: null });
  try {
    // Bind the complete run to the page selected by the user gesture. A tab
    // switch must stop the run instead of silently moving the agent and its
    // privacy state onto another page.
    const pinnedTab = await activeTab();
    for (let step = 1; step <= settings.maxSteps; step += 1) {
      if (stopRequested || runId !== activeRun) {
        update({ running: false, phase: 'idle', message: 'Stopped by user' });
        return;
      }
      update({ step });
      const context = await captureAndSanitize(settings, pinnedTab);
      if (stopRequested || runId !== activeRun) return;
      // Approach B: activate the guard inside the page content script before
      // the VLM call. The service worker cannot observe webpage scroll events.
      const guardState = await setScrollGuard(context.tab.id, true);
      update({ phase: 'reasoning', message: 'Sending sanitized observation…', scrollDrift: guardState });
      const started = performance.now();
      let accepted = false;
      let progressTimer: ReturnType<typeof setInterval> | undefined;
      const progressOptions: ReasoningRequestOptions = {
        signal: reasoningController.signal,
        onProgress: (stage) => {
          if (runId !== activeRun || stopRequested) return;
          if (stage === 'accepted') accepted = true;
          const elapsed = Math.max(0, Math.round((performance.now() - started) / 1_000));
          update({
            phase: 'reasoning',
            message: stage === 'accepted'
              ? `Request accepted · model deciding (${elapsed}s). First model load may take longer.`
              : `Sending sanitized observation (${elapsed}s)…`,
          });
        },
      };
      progressTimer = setInterval(() => {
        if (runId !== activeRun || stopRequested) return;
        const elapsed = Math.max(0, Math.round((performance.now() - started) / 1_000));
        update({
          phase: 'reasoning',
          message: accepted
            ? `Waiting for reasoning decision (${elapsed}s)…`
            : `Sending sanitized observation (${elapsed}s)…`,
        });
      }, 1_000);
      let response;
      let driftState: ScrollDriftState = guardState;
      try {
        response = await keepServiceWorkerAlive(
          sendSanitizedObservation(settings.endpoint, settings.apiKey, context.observation, settings.canaries, progressOptions),
        );
      } finally {
        if (progressTimer) clearInterval(progressTimer);
        driftState = await setScrollGuard(context.tab.id, false).catch(() => ({
          drifted: true,
          lastDriftTimestamp: Date.now(),
          debounceMs: 350,
        }));
      }
      if (runId !== activeRun || stopRequested) return;
      // Discard actions resolved against a viewport that moved during the
      // network call. The content script owns this observation.
      if (driftState.drifted) {
        // Viewport changed during reasoning — discard the stale action and re-capture.
        update({
          message: 'Viewport changed during reasoning — re-capturing…',
          scrollDrift: driftState,
        });
        continue; // Re-enter the step loop with a fresh capture.
      }
      update({ lastLatencyMs: Math.round(performance.now() - started), scrollDrift: driftState });
      if (stopRequested || runId !== activeRun) {
        update({ running: false, phase: 'idle', message: 'Stopped by user' });
        return;
      }
      update({ phase: 'executing', message: `Executing ${response.action.type}…` });
      const result = await execute(context, response.action);
      if (response.action.type === 'done') {
        update({ running: false, phase: 'done', message: result });
        return;
      }
      update({ message: result });
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    update({ running: false, phase: 'blocked', message: 'Maximum step count reached' });
  } catch (error) {
    if (runId !== activeRun || stopRequested || reasoningController.signal.aborted) return;
    reportBlockedOperation('agent run', error);
    update({ running: false, phase: 'blocked', message: safeMessage(error) });
  } finally {
    if (activeReasoningController === reasoningController) activeReasoningController = null;
  }
}

async function handlePopup(message: unknown): Promise<AgentStatus> {
  if (!message || typeof message !== 'object' || !('type' in message)) throw new Error('Invalid popup command');
  const command = message as PopupCommand;
  if (command.type === 'GET_STATUS') return status;
  if (command.type === 'STOP') {
    stopRequested = true;
    activeRun += 1;
    activeReasoningController?.abort();
    activeReasoningController = null;
    update({ running: false, phase: 'idle', message: 'Stopped by user' });
    return status;
  }
  if (command.type === 'PREVIEW') {
    await preview(command.settings);
    return status;
  }
  if (command.type === 'START') {
    await runAgent(command.settings);
    return status;
  }
  throw new Error('Unsupported popup command');
}

ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // The offscreen document owns local raster requests. Do not race its response.
  if (isOffscreenMessage(message)) return false;
  void handlePopup(message).then(sendResponse).catch((error) => sendResponse({ ...status, message: safeMessage(error) }));
  return true;
});

ext.tabs.onActivated.addListener((activeInfo) => {
  windowActivationGeneration.set(activeInfo.windowId, (windowActivationGeneration.get(activeInfo.windowId) ?? 0) + 1);
});
ext.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status || changeInfo.url) tabUpdateGeneration.set(tabId, (tabUpdateGeneration.get(tabId) ?? 0) + 1);
});
