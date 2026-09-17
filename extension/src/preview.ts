import type { AgentStatus } from './types';
import { renderSanitizedDomPreview } from './dom-preview';
import { ext } from './webext';

const message = document.getElementById('message') as HTMLParagraphElement;
const image = document.getElementById('preview') as HTMLImageElement;
const imagePanel = document.getElementById('previewImagePanel') as HTMLDivElement;
const imageStage = document.getElementById('previewImageStage') as HTMLDivElement;
const zoomOut = document.getElementById('previewZoomOut') as HTMLButtonElement;
const zoomValue = document.getElementById('previewZoomValue') as HTMLOutputElement;
const zoomIn = document.getElementById('previewZoomIn') as HTMLButtonElement;
const zoomReset = document.getElementById('previewZoomReset') as HTMLButtonElement;
const fullscreen = document.getElementById('previewFullscreen') as HTMLButtonElement;
const close = document.getElementById('close') as HTMLButtonElement;
const domProofPanel = document.getElementById('dom-proof-panel') as HTMLElement;
const domProofContent = document.getElementById('dom-preview-content') as HTMLElement;
const toggleDomProof = document.getElementById('toggle-dom-proof') as HTMLButtonElement;
let domProofOpen = true;
let previewFallbackFullscreen = false;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;
let zoom = 1;

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
  message.hidden = Boolean(status.previewDataUrl || status.sanitizedDomPreview);
}

close.addEventListener('click', () => window.close());
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
