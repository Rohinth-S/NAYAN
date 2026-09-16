import type { AgentStatus } from './types';
import { ext } from './webext';

const message = document.getElementById('message') as HTMLParagraphElement;
const image = document.getElementById('preview') as HTMLImageElement;
const close = document.getElementById('close') as HTMLButtonElement;

async function load(): Promise<void> {
  const status = (await ext.runtime.sendMessage({ type: 'GET_STATUS' })) as AgentStatus;
  if (!status.previewDataUrl) {
    message.textContent = 'No local preview is available. Run Privacy preview from the extension first.';
    return;
  }
  const container = document.getElementById('preview-container') as HTMLDivElement;
  const areaStat = document.getElementById('masked-area-stat') as HTMLSpanElement;
  const countsContainer = document.getElementById('category-counts-container') as HTMLDivElement;
  
  image.src = status.previewDataUrl;
  container.hidden = false;
  message.hidden = true;
  
  if (status.maskedAreaPercentage !== undefined) {
    areaStat.textContent = status.maskedAreaPercentage.toString();
  }
  
  if (status.categoryCounts) {
    countsContainer.innerHTML = '<h4>Masked Categories:</h4><ul>' + 
      Object.entries(status.categoryCounts)
        .map(([kind, count]) => `<li><strong>${kind}:</strong> ${count}</li>`)
        .join('') + 
      '</ul>';
  }
}

close.addEventListener('click', () => window.close());
void load().catch(() => { message.textContent = 'The local preview could not be loaded.'; });
