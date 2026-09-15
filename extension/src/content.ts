import { findingsForGrade, inputValueNeedsMask, isSensitiveField, isSensitiveTextLabel, mergeBounds, pseudoContentNeedsMask } from './privacy';
import { isPrivacyGrade, type PrivacyGrade } from './privacy-policy';
import type {
  AgentAction,
  Bounds,
  ContentCommand,
  ContentResponse,
  ElementRole,
  RawDomSnapshot,
  RawElement,
  RedactionKind,
} from './types';
import { ext } from './webext';

declare global {
  interface Window {
    __SIH_PRIVACY_AGENT_CONTENT__?: boolean;
  }
}

const documentId = crypto.randomUUID();
let documentRevision = 0;
let currentSnapshotId = '';
let currentElements = new Map<string, Element>();
let lastExecutedActionKey = '';

new MutationObserver(() => {
  documentRevision += 1;
}).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
window.addEventListener('scroll', () => { documentRevision += 1; }, { capture: true, passive: true });
window.addEventListener('resize', () => { documentRevision += 1; }, { passive: true });
window.addEventListener('orientationchange', () => { documentRevision += 1; }, { passive: true });

function opaqueElementId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `e_${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`;
}

function visible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  const style = getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
}

function clippedBounds(rect: DOMRect | DOMRectReadOnly): Bounds | null {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function roleOf(element: Element): ElementRole {
  const explicit = element.getAttribute('role');
  if (explicit && ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'option'].includes(explicit)) {
    return explicit as ElementRole;
  }
  if (element instanceof HTMLAnchorElement) return 'link';
  if (element instanceof HTMLButtonElement) return 'button';
  if (element instanceof HTMLTextAreaElement) return 'textbox';
  if (element instanceof HTMLSelectElement) return 'combobox';
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox') return 'checkbox';
    if (element.type === 'radio') return 'radio';
    if (['button', 'submit', 'reset'].includes(element.type)) return 'button';
    return 'textbox';
  }
  if (element.scrollHeight > element.clientHeight + 8) return 'scroll-region';
  return 'other';
}

function labelOf(element: Element): string {
  const aria = element.getAttribute('aria-label');
  if (aria) return aria;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    const labels = element.labels;
    if (labels?.length) return Array.from(labels).map((label) => label.innerText).join(' ');
    return element.getAttribute('placeholder') ?? element.getAttribute('name') ?? element.getAttribute('id') ?? '';
  }
  return (element as HTMLElement).innerText ?? element.getAttribute('title') ?? '';
}

function stateOf(element: Element): RawElement['state'] {
  const form = element as HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement;
  const editable = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || (element as HTMLElement).isContentEditable;
  return {
    disabled: 'disabled' in form ? Boolean(form.disabled) : element.getAttribute('aria-disabled') === 'true',
    checked: element instanceof HTMLInputElement ? element.checked : element.getAttribute('aria-checked') === 'true',
    editable,
    required: 'required' in form ? Boolean(form.required) : element.getAttribute('aria-required') === 'true',
  };
}

function interactiveElements(): Element[] {
  const selectors = [
    'button',
    'a[href]',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="textbox"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="combobox"]',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
  ];
  return Array.from(document.querySelectorAll(selectors.join(','))).filter(visible).slice(0, 500);
}

type LocalRedaction = { kind: RedactionKind; source: 'dom' | 'regex'; bounds: Bounds };

function collectFieldRedactions(knownValues: readonly string[], privacyGrade: PrivacyGrade): LocalRedaction[] {
  const redactions: LocalRedaction[] = [];
  for (const element of document.querySelectorAll('input, textarea, select, [contenteditable="true"]')) {
    if (!visible(element)) continue;
    const field = element as HTMLInputElement;
    const kind = isSensitiveField({
      type: field.type,
      autocomplete: field.autocomplete,
      name: field.getAttribute('name') ?? undefined,
      id: field.id || undefined,
      placeholder: field.getAttribute('placeholder') ?? undefined,
      ariaLabel: field.getAttribute('aria-label') ?? undefined,
    }, privacyGrade);
    const hasVisibleValue =
      (element instanceof HTMLInputElement && inputValueNeedsMask(element.type, element.value, knownValues, privacyGrade)) ||
      (element instanceof HTMLTextAreaElement && inputValueNeedsMask('textarea', element.value, knownValues, privacyGrade)) ||
      (element instanceof HTMLSelectElement && inputValueNeedsMask(
        'select',
        `${element.value} ${Array.from(element.selectedOptions).map((option) => option.text).join(' ')}`.trim(),
        knownValues,
        privacyGrade,
      )) ||
      ((element as HTMLElement).isContentEditable && inputValueNeedsMask(
        'contenteditable',
        element.textContent?.trim() ?? '',
        knownValues,
        privacyGrade,
      ));
    if (!kind && !hasVisibleValue) continue;
    const bounds = clippedBounds(element.getBoundingClientRect());
    if (bounds) redactions.push({ kind: kind ?? 'sensitive-field', source: 'dom', bounds });
  }
  return redactions;
}

function collectTextRedactions(knownValues: readonly string[], privacyGrade: PrivacyGrade): LocalRedaction[] {
  const redactions: LocalRedaction[] = [];
  // Definition lists commonly display profile values outside form controls.
  // Keep the public label but replace the associated sensitive value.
  for (const term of document.querySelectorAll('dt')) {
    const value = term.nextElementSibling;
    if (!value || value.tagName !== 'DD' || !visible(value) || !isSensitiveTextLabel(term.textContent ?? '', privacyGrade)) continue;
    const bounds = clippedBounds(value.getBoundingClientRect());
    if (bounds) redactions.push({ kind: 'pii-text', source: 'dom', bounds });
  }
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !visible(parent) || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
      return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let node: Node | null;
  let inspectedNodes = 0;
  while ((node = walker.nextNode())) {
    inspectedNodes += 1;
    if (inspectedNodes > 5_000) {
      redactions.push({ kind: 'uninspectable-media', source: 'dom', bounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight } });
      break;
    }
    const text = node.textContent ?? '';
    for (const finding of findingsForGrade(text, knownValues, privacyGrade)) {
      const range = document.createRange();
      range.setStart(node, finding.start);
      range.setEnd(node, finding.end);
      for (const rect of Array.from(range.getClientRects())) {
        const bounds = clippedBounds(rect);
        if (bounds) redactions.push({ kind: 'pii-text', source: 'regex', bounds });
      }
      range.detach();
    }
  }
  return redactions;
}

function collectFrameRedactions(): LocalRedaction[] {
  const redactions: LocalRedaction[] = [];
  for (const frame of document.querySelectorAll('iframe, frame')) {
    if (!visible(frame)) continue;
    // Top-frame capture cannot prove that a nested browsing context was inspected.
    // Masking every visible frame also covers cross-origin and sandboxed frames.
    const bounds = clippedBounds(frame.getBoundingClientRect());
    if (bounds) redactions.push({ kind: 'uninspectable-frame', source: 'dom', bounds });
  }
  return redactions;
}

function collectMediaRedactions(): LocalRedaction[] {
  const candidates = new Set<Element>();
  for (const element of document.querySelectorAll('img, picture, canvas, video, svg, object, embed, input[type="image"]')) candidates.add(element);
  const allBodyElements = Array.from(document.querySelectorAll('body *'));
  const styled = [document.documentElement, document.body, ...allBodyElements.slice(0, 2_000)].filter(Boolean);
  for (const element of styled) {
    const htmlElement = element as Element;
    const tag = htmlElement.tagName.toLowerCase();
    const hasBackground = getComputedStyle(htmlElement).backgroundImage !== 'none';
    const before = getComputedStyle(htmlElement, '::before');
    const after = getComputedStyle(htmlElement, '::after');
    const hasPseudoBackground = before.backgroundImage !== 'none' || after.backgroundImage !== 'none';
    if (hasBackground || hasPseudoBackground || pseudoContentNeedsMask(before.content, after.content) || tag.includes('-') || htmlElement.shadowRoot) {
      candidates.add(htmlElement);
    }
  }
  const redactions: LocalRedaction[] = [];
  for (const element of candidates) {
    if (!visible(element)) continue;
    const bounds = clippedBounds(element.getBoundingClientRect());
    if (bounds) redactions.push({ kind: 'uninspectable-media', source: 'dom', bounds });
  }
  if (allBodyElements.length > 2_000) {
    redactions.push({ kind: 'uninspectable-media', source: 'dom', bounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight } });
  }
  return redactions;
}

function captureDom(snapshotId: string, knownValues: readonly string[], privacyGrade: PrivacyGrade): RawDomSnapshot {
  currentSnapshotId = snapshotId;
  lastExecutedActionKey = '';
  currentElements = new Map();
  const elements: RawElement[] = [];
  for (const element of interactiveElements()) {
    const bounds = clippedBounds(element.getBoundingClientRect());
    if (!bounds) continue;
    const id = opaqueElementId();
    currentElements.set(id, element);
    elements.push({ id, role: roleOf(element), label: labelOf(element), bounds, state: stateOf(element) });
  }
  const redactions = [
    ...collectFieldRedactions(knownValues, privacyGrade),
    ...collectTextRedactions(knownValues, privacyGrade),
    ...collectFrameRedactions(),
    ...collectMediaRedactions(),
  ];
  const merged: LocalRedaction[] = [];
  for (const group of ['password', 'sensitive-field', 'pii-text', 'uninspectable-frame', 'uninspectable-media'] as const) {
    const matching = redactions.filter((item) => item.kind === group);
    const source = matching.some((item) => item.source === 'regex') ? 'regex' : 'dom';
    for (const bounds of mergeBounds(matching.map((item) => item.bounds))) merged.push({ kind: group, source, bounds });
  }
  return {
    documentId,
    documentRevision,
    origin: location.origin,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY },
    elements,
    redactions: merged,
  };
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('Input cannot be edited');
  setter.call(element, value);
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function executeAction(command: Extract<ContentCommand, { type: 'EXECUTE_ACTION' }>): Promise<string> {
  if (command.snapshotId !== currentSnapshotId) throw new Error('Snapshot is stale');
  if (command.documentId !== documentId || command.documentRevision !== documentRevision) throw new Error('Document changed after capture');
  const action: AgentAction = command.action;
  const actionKey = `${command.snapshotId}:${JSON.stringify(action)}`;
  if (actionKey === lastExecutedActionKey) throw new Error('Duplicate action rejected');
  lastExecutedActionKey = actionKey;
  if (action.type === 'done') return action.message ?? 'Task complete';
  if (action.type === 'wait') {
    await new Promise((resolve) => setTimeout(resolve, action.milliseconds));
    return 'Waited';
  }
  if (action.type === 'scroll') {
    const amount = action.amount;
    if (amount === undefined) throw new Error('Scroll amount is missing');
    const top = action.direction === 'up' ? -amount : amount;
    const target = action.elementId ? currentElements.get(action.elementId) : undefined;
    if (action.elementId) {
      if (!(target instanceof HTMLElement) || !target.isConnected || !visible(target) || roleOf(target) !== 'scroll-region') {
        throw new Error('Scroll target is unavailable or not a scroll region');
      }
      target.scrollBy({ top, behavior: 'smooth' });
    } else window.scrollBy({ top, behavior: 'smooth' });
    return `Scrolled ${action.direction}`;
  }
  if (!action.elementId) throw new Error('Action target is missing');
  const target = currentElements.get(action.elementId);
  if (!(target instanceof HTMLElement) || !target.isConnected || !visible(target)) throw new Error('Action target is unavailable');
  if (action.type === 'click') {
    const control = target as HTMLButtonElement | HTMLInputElement | HTMLSelectElement;
    if ('disabled' in control && Boolean(control.disabled) || target.getAttribute('aria-disabled') === 'true') throw new Error('Action target is disabled');
    if (target instanceof HTMLAnchorElement && !target.href.startsWith(`${location.origin}/`) && target.origin !== location.origin) {
      throw new Error('Cross-origin navigation is blocked');
    }
    target.focus();
    target.click();
    return 'Clicked element';
  }
  if (action.type === 'input') {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      if (target.disabled || target.readOnly) throw new Error('Action target is not editable');
      setNativeValue(target, action.text ?? '');
    }
    else if (target.isContentEditable) {
      if ((target as HTMLElement).getAttribute('aria-readonly') === 'true') throw new Error('Action target is not editable');
      target.textContent = action.text ?? '';
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: action.text ?? '' }));
    } else if (target instanceof HTMLSelectElement) {
      if (target.disabled) throw new Error('Action target is not editable');
      const option = Array.from(target.options).find((candidate) => candidate.value === action.text || candidate.text === action.text);
      if (!option) throw new Error('Requested option is unavailable');
      target.value = option.value;
      target.dispatchEvent(new Event('change', { bubbles: true }));
    } else throw new Error('Action target is not editable');
    return 'Entered text';
  }
  throw new Error('Unsupported action');
}

async function handleMessage(message: unknown): Promise<ContentResponse> {
  try {
    if (!message || typeof message !== 'object' || !('type' in message)) throw new Error('Invalid content command');
    const command = message as ContentCommand;
    if (command.type === 'PING') return { ok: true, result: 'ready' };
    if (command.type === 'VERIFY_REVISION') {
      return {
        ok: true,
        revision: {
          documentId,
          documentRevision,
          origin: location.origin,
          viewport: { width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY },
        },
      };
    }
    if (command.type === 'CAPTURE_DOM') {
      if (!isPrivacyGrade(command.privacyGrade)) throw new Error('Invalid privacy grade');
      return { ok: true, snapshot: captureDom(command.snapshotId, command.knownValues, command.privacyGrade) };
    }
    if (command.type === 'EXECUTE_ACTION') return { ok: true, result: await executeAction(command) };
    throw new Error('Unsupported content command');
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Content operation failed' };
  }
}

if (!window.__SIH_PRIVACY_AGENT_CONTENT__) {
  window.__SIH_PRIVACY_AGENT_CONTENT__ = true;
  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    void handleMessage(message).then(sendResponse);
    return true;
  });
}
