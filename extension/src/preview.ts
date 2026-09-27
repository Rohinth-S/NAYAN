import type { AgentStatus } from './types';
import { renderSanitizedDomPreview } from './dom-preview';
import { downloadRedactionReport, renderRedactionReport } from './redaction-report';
import { ext } from './webext';
import './thinking-orb';

const message = document.getElementById('message') as HTMLParagraphElement;
const image = document.getElementById('preview') as HTMLImageElement;
const imagePanel = document.getElementById('previewImagePanel') as HTMLDivElement;
const imageStage = document.getElementById('previewImageStage') as HTMLDivElement;
const zoomOut = document.getElementById('previewZoomOut') as HTMLButtonElement;
const zoomValue = document.getElementById('previewZoomValue') as HTMLOutputElement;
const zoomIn = document.getElementById('previewZoomIn') as HTMLButtonElement;
const zoomReset = document.getElementById('previewZoomReset') as HTMLButtonElement;
const fullscreen = document.getElementById('previewFullscreen') as HTMLButtonElement;
const whyHiddenToggle = document.getElementById('whyHiddenToggle') as HTMLButtonElement;
const whyHiddenExplanation = document.getElementById('whyHiddenExplanation') as HTMLDivElement;
const whyHiddenText = document.getElementById('whyHiddenText') as HTMLParagraphElement;
const whyHiddenCategories = document.getElementById('whyHiddenCategories') as HTMLUListElement;
const close = document.getElementById('close') as HTMLButtonElement;
const domProofPanel = document.getElementById('dom-proof-panel') as HTMLElement;
const domProofContent = document.getElementById('dom-preview-content') as HTMLElement;
const toggleDomProof = document.getElementById('toggle-dom-proof') as HTMLButtonElement;
const runReport = document.getElementById('runReport') as HTMLElement;
const runReportContent = document.getElementById('runReportContent') as HTMLElement;
const downloadReport = document.getElementById('downloadReport') as HTMLButtonElement;
let domProofOpen = true;
let previewFallbackFullscreen = false;
let latestStatus: AgentStatus | null = null;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;
let zoom = 1;

function renderWhyHidden(status: AgentStatus): void {
  const grade = status.sanitizedDomPreview?.grade;
  const categories = Object.entries(status.categoryCounts ?? {})
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  if (categories.length === 0) {
    whyHiddenText.textContent = grade
      ? `No sensitive categories were reported for privacy Grade ${grade}. The preview may still be unavailable because the local detector failed closed.`
      : 'No sensitive categories were reported by the local privacy filter.';
    whyHiddenCategories.replaceChildren();
    return;
  }
  whyHiddenText.textContent = grade
    ? `The local filter applied privacy Grade ${grade} before this preview was created. It detected the following categories:`
    : 'The local filter detected the following categories before this preview was created:';
  whyHiddenCategories.replaceChildren(...categories.map(([kind, count]) => {
    const item = document.createElement('li');
    item.textContent = `${kind}: ${count}`;
    return item;
  }));
}

function toggleWhyHidden(): void {
  const open = whyHiddenExplanation.hidden;
  whyHiddenExplanation.hidden = !open;
  whyHiddenToggle.setAttribute('aria-expanded', String(open));
}

function renderZoom(): void {
  const percentage = Math.round(zoom * 100);
  zoomValue.value = `${percentage}%`;
  zoomValue.textContent = `${percentage}%`;
  image.style.setProperty('--preview-scale', String(zoom));
  imageStage.classList.toggle('is-zoomed', zoom > 1);
  zoomOut.disabled = zoom <= ZOOM_MIN;
  zoomIn.disabled = zoom >= ZOOM_MAX;
  zoomReset.disabled = zoom === 1;
}

function setZoom(value: number): void {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
  zoom = Math.round(next / ZOOM_STEP) * ZOOM_STEP;
  renderZoom();
}

function renderFullscreenState(): void {
  const native = document.fullscreenElement === imagePanel;
  const active = native || previewFallbackFullscreen;
  fullscreen.textContent = active ? 'Exit fullscreen' : 'Fullscreen';
  fullscreen.setAttribute('aria-pressed', String(active));
  imagePanel.classList.toggle('is-native-fullscreen', native);
  imagePanel.classList.toggle('is-fallback-fullscreen', previewFallbackFullscreen);
}

async function toggleFullscreen(): Promise<void> {
  if (document.fullscreenElement === imagePanel) {
    await document.exitFullscreen();
    return;
  }
  if (previewFallbackFullscreen) {
    previewFallbackFullscreen = false;
    renderFullscreenState();
    return;
  }
  if (!imagePanel.requestFullscreen) {
    previewFallbackFullscreen = true;
    renderFullscreenState();
    return;
  }
  try {
    await imagePanel.requestFullscreen();
    if (document.fullscreenElement !== imagePanel) {
      previewFallbackFullscreen = true;
      renderFullscreenState();
      return;
    }
    renderFullscreenState();
  } catch {
    // Some extension pages still reject native fullscreen. Keep the action
    // visible by expanding the panel to the viewport with CSS.
    previewFallbackFullscreen = true;
    renderFullscreenState();
  }
}

async function load(): Promise<void> {
  const status = (await ext.runtime.sendMessage({ type: 'GET_STATUS' })) as AgentStatus;
  latestStatus = status;
  renderWhyHidden(status);
  if (!status.previewDataUrl && !status.sanitizedDomPreview) {
    message.textContent = 'No local preview is available. Run Privacy preview from the extension first.';
    return;
  }
  const container = document.getElementById('preview-container') as HTMLDivElement;
  const areaStat = document.getElementById('masked-area-stat') as HTMLSpanElement;
  const countsContainer = document.getElementById('category-counts-container') as HTMLDivElement;

  if (status.previewDataUrl) {
    image.src = status.previewDataUrl;
    setZoom(1);
    container.hidden = false;
  } else {
    container.hidden = true;
  }

  if (status.maskedAreaPercentage !== undefined) {
    areaStat.textContent = status.maskedAreaPercentage.toString();
  }
  
  if (status.categoryCounts) {
    countsContainer.replaceChildren();
    const heading = document.createElement('h4');
    heading.textContent = 'Masked Categories:';
    const list = document.createElement('ul');
    for (const [kind, count] of Object.entries(status.categoryCounts)) {
      const item = document.createElement('li');
      const label = document.createElement('strong');
      label.textContent = `${kind}:`;
      item.append(label, document.createTextNode(` ${count}`));
      list.append(item);
    }
    countsContainer.append(heading, list);
  } else {
    countsContainer.replaceChildren();
  }

  if (status.sanitizedDomPreview) {
    renderSanitizedDomPreview(domProofContent, status.sanitizedDomPreview);
    domProofPanel.hidden = false;
    domProofContent.hidden = !domProofOpen;
    toggleDomProof.textContent = domProofOpen ? 'Hide details' : 'Show details';
    toggleDomProof.setAttribute('aria-expanded', String(domProofOpen));
  } else {
    domProofPanel.hidden = true;
  }
  if (status.latestReport) {
    runReport.hidden = false;
    renderRedactionReport(runReportContent, status.latestReport, status.previewDataUrl);
  } else {
    runReport.hidden = true;
    runReportContent.replaceChildren();
  }
  message.hidden = Boolean(status.previewDataUrl || status.sanitizedDomPreview);
}

downloadReport.addEventListener('click', () => {
  const report = latestStatus?.latestReport;
  if (report) downloadRedactionReport(report, latestStatus?.previewDataUrl ?? null);
});

async function closePreviewTab(): Promise<void> {
  if (document.fullscreenElement === imagePanel) {
    try {
      await document.exitFullscreen();
    } catch {
      // The tab can still be closed if the browser has already exited native
      // fullscreen or rejected the exit request.
    }
  }
  const openerTabId = Number(new URLSearchParams(window.location.search).get('openerTabId'));
  const currentTab = await ext.tabs.getCurrent();
  if (Number.isInteger(openerTabId) && openerTabId > 0) {
    try {
      await ext.tabs.update(openerTabId, { active: true });
    } catch {
      // The originating tab may have been closed; closing this preview is
      // still the correct recovery path.
    }
  }
  if (currentTab?.id !== undefined) {
    try {
      await ext.tabs.remove(currentTab.id);
      return;
    } catch {
      // Fall through to the browser's normal close behavior.
    }
  }
  window.close();
}

close.addEventListener('click', () => void closePreviewTab());
toggleDomProof.addEventListener('click', () => {
  domProofOpen = !domProofOpen;
  domProofContent.hidden = !domProofOpen;
  toggleDomProof.textContent = domProofOpen ? 'Hide details' : 'Show details';
  toggleDomProof.setAttribute('aria-expanded', String(domProofOpen));
});
zoomOut.addEventListener('click', () => setZoom(zoom - ZOOM_STEP));
zoomIn.addEventListener('click', () => setZoom(zoom + ZOOM_STEP));
zoomReset.addEventListener('click', () => setZoom(1));
fullscreen.addEventListener('click', () => void toggleFullscreen());
whyHiddenToggle.addEventListener('click', toggleWhyHidden);
imageStage.addEventListener('wheel', (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  setZoom(zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
}, { passive: false });
document.addEventListener('fullscreenchange', renderFullscreenState);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.fullscreenElement === imagePanel) {
    void document.exitFullscreen();
    return;
  }
  if (event.key === 'Escape' && previewFallbackFullscreen) {
    previewFallbackFullscreen = false;
    renderFullscreenState();
    return;
  }
  if (event.key === '+' || event.key === '=') setZoom(zoom + ZOOM_STEP);
  else if (event.key === '-') setZoom(zoom - ZOOM_STEP);
  else if (event.key === '0') setZoom(1);
});
renderZoom();
renderFullscreenState();
void load().catch(() => { message.textContent = 'The local preview could not be loaded.'; });
