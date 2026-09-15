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
  image.src = status.previewDataUrl;
  image.hidden = false;
  message.hidden = true;
}

close.addEventListener('click', () => window.close());
void load().catch(() => { message.textContent = 'The local preview could not be loaded.'; });
