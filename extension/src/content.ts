import { identityFindings, sanitizeIdentityValues, type IdentityValue } from './identity-values';
import { classifySensitiveField, classifySensitiveTextLabel, findingsForGrade, inputValueNeedsMask, isSensitiveField, isSensitiveTextLabel, mergeBounds, pseudoContentNeedsMask } from './privacy';
import { classifyDocumentType, classifyMediaElement, type DocumentMediaType, type MediaKind } from './media-policy';
import { categoryForFinding, isPrivacyGrade, type PrivacyCategory, type PrivacyGrade } from './privacy-policy';
import { ScrollDriftGuard } from './scroll-drift-guard';
import { captureDocumentSource, DOCUMENT_SOURCE_PIXEL_BUDGET, type LocalDocumentImage } from './document-source';
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
let destructiveActionInFlight = false;
let pendingApproval: Promise<boolean> | null = null;
const scrollDriftGuard = new ScrollDriftGuard();

new MutationObserver(() => {
  documentRevision += 1;
}).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
window.addEventListener('scroll', () => { documentRevision += 1; }, { capture: true, passive: true });
window.addEventListener('resize', () => { documentRevision += 1; }, { passive: true });
window.addEventListener('orientationchange', () => { documentRevision += 1; }, { passive: true });
window.visualViewport?.addEventListener('resize', () => { documentRevision += 1; }, { passive: true });
window.visualViewport?.addEventListener('scroll', () => { documentRevision += 1; }, { passive: true });

function opaqueElementId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `e_${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`;
}

function visible(element: Element): boolean {
  if (element.closest('[data-sih-agent-ui="true"]')) return false;
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
    const base = labels?.length
      ? Array.from(labels).map((label) => label.innerText).join(' ')
      : element.getAttribute('placeholder') ?? element.getAttribute('name') ?? element.getAttribute('id') ?? '';
    // Expose only boolean progress markers for page-declared public fields.
    // Values and selected option text may contain user data, so they never
    // enter the sanitized label.
    if (element.getAttribute('data-public-field') === 'true') {
      const hasValue = element instanceof HTMLSelectElement
        ? Boolean(element.value && element.selectedOptions.length > 0)
        : 'value' in element && Boolean((element as HTMLInputElement | HTMLTextAreaElement).value);
      return `${base} [public]${hasValue ? ' [filled]' : ''}`;
    }
    return base;
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

type LocalRedaction = {
  kind: RedactionKind;
  source: 'dom' | 'regex';
  bounds: Bounds;
  fieldLabel?: string;
};

type LocalMediaHint = {
  bounds: Bounds;
  kind: MediaKind;
  documentType?: DocumentMediaType;
  localImage?: LocalDocumentImage;
};

/** Map a privacy category to a human-readable field label for [REDACTED:*] placeholders. */
function categoryToFieldLabel(category: PrivacyCategory): string {
  switch (category) {
    case 'credential': return 'PASSWORD';
    case 'government-id': return 'GOVERNMENT_ID';
    case 'financial': return 'FINANCIAL';
    case 'biometric': return 'BIOMETRIC';
    case 'contact': return 'CONTACT';
    case 'location': return 'ADDRESS';
    case 'date-of-birth': return 'DATE_OF_BIRTH';
    case 'network': return 'NETWORK';
    case 'account-id': return 'ACCOUNT_ID';
    case 'name': return 'NAME';
    case 'username': return 'USERNAME';
    case 'professional-id': return 'EMPLOYEE_ID';
    default: return 'PII';
  }
}

/** Return only a canonical category name. Raw labels and values never leave this function. */
function semanticFieldLabel(label: string, category: PrivacyCategory): string {
  const normalized = label.replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').trim().toLowerCase();
  if (/\b(?:aadhaar|aadhar)\b/u.test(normalized)) return 'AADHAAR_NUMBER';
  if (/\bpan\b/u.test(normalized)) return 'PAN';
  if (/\bpassport\b/u.test(normalized)) return 'PASSPORT_NUMBER';
  if (/\b(?:e-?mail)\b/u.test(normalized)) return 'EMAIL';
  if (/\b(?:phone|mobile|telephone|contact number)\b/u.test(normalized)) return 'PHONE_NUMBER';
  if (/\b(?:card number|credit card|debit card)\b/u.test(normalized)) return 'CARD_NUMBER';
  if (/\b(?:bank account|account number)\b/u.test(normalized)) return 'BANK_ACCOUNT';
  if (/\b(?:cvv|cvc|security code)\b/u.test(normalized)) return 'CVV';
  return categoryToFieldLabel(category);
}

function findingFieldLabel(kind: string): string {
  const explicit: Readonly<Record<string, string>> = {
    SECRET: 'PASSWORD',
    AADHAAR: 'AADHAAR_NUMBER',
    PAN: 'PAN',
    PASSPORT: 'PASSPORT_NUMBER',
    CARD: 'CARD_NUMBER',
    BANK_ACCOUNT: 'BANK_ACCOUNT',
    EMAIL: 'EMAIL',
    PHONE: 'PHONE_NUMBER',
    ADDRESS: 'ADDRESS',
    DOB: 'DATE_OF_BIRTH',
    NAME: 'NAME',
    USERNAME: 'USERNAME',
    EMPLOYEE_ID: 'EMPLOYEE_ID',
    ACCOUNT_ID: 'ACCOUNT_ID',
  };
  return explicit[kind] ?? categoryToFieldLabel(categoryForFinding(kind));
}

function valueOnlyFindingRange(text: string, finding: { start: number; end: number; kind: string }): { start: number; end: number } {
  const labelledKinds = new Set(['SECRET', 'BANK_ACCOUNT', 'UPI', 'DOB', 'PASSPORT', 'NAME', 'USERNAME', 'EMPLOYEE_ID', 'ACCOUNT_ID', 'ADDRESS']);
  if (!labelledKinds.has(finding.kind)) return { start: finding.start, end: finding.end };
  const matched = text.slice(finding.start, finding.end);
  const delimiter = matched.search(/[:=]/u);
  if (delimiter < 0) return { start: finding.start, end: finding.end };
  const suffix = matched.slice(delimiter + 1);
  const leadingWhitespace = suffix.length - suffix.trimStart().length;
  const valueStart = finding.start + delimiter + 1 + leadingWhitespace;
  return valueStart < finding.end ? { start: valueStart, end: finding.end } : { start: finding.start, end: finding.end };
}

function collectFieldRedactions(knownValues: readonly string[], privacyGrade: PrivacyGrade): LocalRedaction[] {
  const redactions: LocalRedaction[] = [];
  for (const element of document.querySelectorAll('input, textarea, select, [contenteditable="true"]')) {
    if (!visible(element)) continue;
    const field = element as HTMLInputElement;
    const fieldMetadata = {
      type: field.type,
      autocomplete: field.autocomplete,
      name: field.getAttribute('name') ?? undefined,
      id: field.id || undefined,
      placeholder: field.getAttribute('placeholder') ?? undefined,
      ariaLabel: field.getAttribute('aria-label') ?? undefined,
    };
    const kind = isSensitiveField(fieldMetadata, privacyGrade);
    const category = classifySensitiveField(fieldMetadata);
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
    if (bounds) {
      const fieldLabel = category ? semanticFieldLabel(labelOf(element), category) : undefined;
      redactions.push({ kind: kind ?? 'sensitive-field', source: 'dom', bounds, ...(fieldLabel ? { fieldLabel } : {}) });
    }
  }
  return redactions;
}

function collectIdentityValues(): IdentityValue[] {
  const values: IdentityValue[] = [];
  const add = (category: PrivacyCategory | null, value: string) => {
    if ((category !== 'name' && category !== 'date-of-birth') || value.trim().length < 3 || value.length > 200) return;
    if (values.length < 256 && !values.some(item => item.category === category && item.value === value)) values.push({ category, value });
  };
  for (const term of document.querySelectorAll('dt')) {
    const value = term.nextElementSibling;
    if (value?.tagName === 'DD') add(classifySensitiveTextLabel(term.textContent ?? ''), value.textContent ?? '');
  }
  for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) {
    if (['password', 'hidden'].includes(field.type)) continue;
    add(classifySensitiveField({ type: field.type, autocomplete: field.autocomplete, name: field.name, id: field.id })
      ?? classifySensitiveTextLabel(labelOf(field)), field.value);
  }
  return values;
}

function collectTextRedactions(knownValues: readonly string[], privacyGrade: PrivacyGrade, identityValues: readonly IdentityValue[]): LocalRedaction[] {
  const redactions: LocalRedaction[] = [];
  // Definition lists commonly display profile values outside form controls.
  // Keep the public label but replace the associated sensitive value.
  for (const term of document.querySelectorAll('dt')) {
    const value = term.nextElementSibling;
    if (!value || value.tagName !== 'DD' || !visible(value) || !isSensitiveTextLabel(term.textContent ?? '', privacyGrade)) continue;
    const bounds = clippedBounds(value.getBoundingClientRect());
    // Derive a field-specific label from the <dt> text so the image renderer
    // can show [REDACTED:NAME] instead of generic [REDACTED:PII].
    const category = classifySensitiveTextLabel(term.textContent ?? '');
    const fieldLabel = category ? semanticFieldLabel(term.textContent ?? '', category) : undefined;
    if (bounds) redactions.push({ kind: 'pii-text', source: 'dom', bounds, ...(fieldLabel ? { fieldLabel } : {}) });
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
    for (const finding of [...findingsForGrade(text, knownValues, privacyGrade), ...identityFindings(text, identityValues, privacyGrade)]) {
      const valueRange = valueOnlyFindingRange(text, finding);
      const range = document.createRange();
      range.setStart(node, valueRange.start);
      range.setEnd(node, valueRange.end);
      for (const rect of Array.from(range.getClientRects())) {
        const bounds = clippedBounds(rect);
        if (bounds) redactions.push({
          kind: 'pii-text',
          source: 'regex',
          bounds,
          fieldLabel: findingFieldLabel(finding.kind),
        });
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

/**
 * Returns true when an element is a text container — it has at least one
 * direct child that is a text node or a standard text element. Such elements
 * should not be treated as uninspectable media even when they carry decorative
 * CSS-generated content (badges, counters, labels) via ::before/::after.
 */
function isTextContainer(element: Element): boolean {
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && (child.textContent?.trim().length ?? 0) > 2) return true;
    if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = (child as Element).tagName;
      if (['DT', 'DD', 'SPAN', 'P', 'LABEL', 'STRONG', 'EM', 'SMALL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(tag)) return true;
    }
  }
  return false;
}

function collectMediaRedactions(): { redactions: LocalRedaction[]; hints: LocalMediaHint[] } {
  const candidates = new Set<Element>();
  for (const element of document.querySelectorAll('img, picture, canvas, video, svg, object, embed, input[type="image"]')) candidates.add(element);
  const allBodyElements = Array.from(document.querySelectorAll('body *'));
  const styled = allBodyElements.slice(0, 2_000);
  for (const element of styled) {
    const htmlElement = element as Element;
    const tag = htmlElement.tagName.toLowerCase();
    const hasBackground = /url\(/iu.test(getComputedStyle(htmlElement).backgroundImage);
    const before = getComputedStyle(htmlElement, '::before');
    const after = getComputedStyle(htmlElement, '::after');
    const hasPseudoBackground = /url\(/iu.test(before.backgroundImage) || /url\(/iu.test(after.backgroundImage);
    const hasPseudoContent = pseudoContentNeedsMask(before.content, after.content);
    // Elements that carry only decorative CSS-generated text (badges, labels,
    // counters) but are otherwise normal text containers should NOT be treated
    // as uninspectable media. They are already covered by collectTextRedactions
    // and collectFieldRedactions, which redact only the sensitive values while
    // preserving the field labels. Treating them as media would produce a
    // full-box [REDACTED:MEDIA] overlay hiding both labels and values.
    const isOnlyPseudoContent = hasPseudoContent && !hasBackground && !hasPseudoBackground && !tag.includes('-') && !htmlElement.shadowRoot;
    if (isOnlyPseudoContent && isTextContainer(htmlElement)) continue;
    if (hasBackground || hasPseudoBackground || hasPseudoContent || tag.includes('-') || htmlElement.shadowRoot) {
      candidates.add(htmlElement);
    }
  }
  const redactions: LocalRedaction[] = [];
  const hints: LocalMediaHint[] = [];
  let sourcePixelsRemaining = DOCUMENT_SOURCE_PIXEL_BUDGET;
  for (const element of candidates) {
    if (!visible(element)) continue;
    const bounds = clippedBounds(element.getBoundingClientRect());
    if (!bounds) continue;
    const kind = classifyMediaElement(element);
    // Public object pixels are preserved only after an explicit page opt-in.
    // classifyMediaElement never infers this state from an ordinary alt string.
    if (kind === 'object') continue;
    redactions.push({ kind: 'uninspectable-media', source: 'dom', bounds, ...(kind === 'person' ? { fieldLabel: 'FACE' } : {}) });
    if (kind === 'document') {
      const localImage = captureDocumentSource(element, bounds, sourcePixelsRemaining);
      if (localImage) sourcePixelsRemaining -= localImage.width * localImage.height;
      hints.push({ bounds, kind, documentType: classifyDocumentType(element), ...(localImage ? { localImage } : {}) });
    } else if (kind === 'person') {
      hints.push({ bounds, kind });
    }
  }
  if (allBodyElements.length > 2_000) {
    redactions.push({ kind: 'uninspectable-media', source: 'dom', bounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight } });
  }
  return { redactions, hints };
}

function captureDom(snapshotId: string, knownValues: readonly string[], privacyGrade: PrivacyGrade): RawDomSnapshot {
  currentSnapshotId = snapshotId;
  lastExecutedActionKey = '';
  currentElements = new Map();
  const identityValues = collectIdentityValues();
  const elements: RawElement[] = [];
  for (const element of interactiveElements()) {
    const bounds = clippedBounds(element.getBoundingClientRect());
    if (!bounds) continue;
    const id = opaqueElementId();
    currentElements.set(id, element);
    elements.push({ id, role: roleOf(element), label: sanitizeIdentityValues(labelOf(element), identityValues, privacyGrade), bounds, state: stateOf(element) });
  }
  const media = collectMediaRedactions();
  const redactions = [
    ...collectFieldRedactions(knownValues, privacyGrade),
    ...collectTextRedactions(knownValues, privacyGrade, identityValues),
    ...collectFrameRedactions(),
    ...media.redactions,
  ];
  const merged: LocalRedaction[] = [];
  for (const group of ['password', 'sensitive-field', 'pii-text', 'uninspectable-frame'] as const) {
    const matching = redactions.filter((item) => item.kind === group);
    const buckets = new Map<string, LocalRedaction[]>();
    for (const item of matching) {
      const key = `${item.source}:${item.fieldLabel ?? ''}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(item);
      buckets.set(key, bucket);
    }
    for (const bucket of buckets.values()) {
      const source = bucket.some((item) => item.source === 'regex') ? 'regex' : 'dom';
      const fieldLabel = bucket[0]?.fieldLabel;
      for (const bounds of mergeBounds(bucket.map((item) => item.bounds))) {
        merged.push({ kind: group, source, bounds, ...(fieldLabel ? { fieldLabel } : {}) });
      }
    }
  }
  // Keep media regions independent. Merging an identity document with its
  // portrait overlay turns a small face into a whole-card MEDIA mask and also
  // destroys the exact geometry needed by local document OCR.
  for (const item of redactions.filter((candidate) => candidate.kind === 'uninspectable-media')) {
    if (!merged.some(existing => existing.kind === item.kind
      && Math.abs(existing.bounds.x - item.bounds.x) < 0.5
      && Math.abs(existing.bounds.y - item.bounds.y) < 0.5
      && Math.abs(existing.bounds.width - item.bounds.width) < 0.5
      && Math.abs(existing.bounds.height - item.bounds.height) < 0.5)) {
      merged.push(item);
    }
  }
  return {
    documentId,
    documentRevision,
    origin: location.origin,
    title: sanitizeIdentityValues(document.title, identityValues, privacyGrade),
    viewport: { width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY },
    elements,
    ...((typeof __PERCEPTION_ENABLED__ !== 'undefined' && __PERCEPTION_ENABLED__) ? { textRegions: collectPerceptionText() } : {}),
    ...(media.hints.length ? { mediaHints: media.hints } : {}),
    redactions: merged,
  };
}

declare const __PERCEPTION_ENABLED__: boolean;
function collectPerceptionText(): Array<{ text: string; bounds: Bounds }> {
  const regions: Array<{ text: string; bounds: Bounds }> = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let characters = 0;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName) || !visible(parent)) continue;
    const bounds = clippedBounds(parent.getBoundingClientRect());
    const text = node.textContent?.trim() ?? '';
    if (!bounds || !text) continue;
    characters += text.length;
    if (regions.length >= 128 || characters > 24_000 || text.length > 1500) throw new Error('Local perception text budget exceeded');
    regions.push({ text, bounds });
  }
  return regions;
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('Input cannot be edited');
  setter.call(element, value);
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

type PublicTaskField = 'preferredName' | 'workEmail' | 'phoneNumber' | 'city' | 'benefitPlan' | 'startDate';

/**
 * The demo's public-field shortcut stays entirely in the content script. It
 * accepts values only from the user's task and only writes to controls that
 * explicitly opt in with data-public-field="true". Private, credential, and
 * unknown controls are never included in this path.
 */
function extractPublicTaskFields(task: string): Map<PublicTaskField, string> {
  const markers: Array<{ key: PublicTaskField; start: number; end: number }> = [];
  const markerPattern = /\b(preferred\s+name|work\s+email|phone(?:\s+number)?|city|benefit\s+plan|coverage\s+start\s+date)\b\s*(?:(?:is|equals?)\s+|[:=]\s*)?/giu;
  for (const match of task.matchAll(markerPattern)) {
    if (match.index === undefined || !match[1]) continue;
    const label = match[1].toLocaleLowerCase().replace(/\s+/gu, ' ');
    const key: PublicTaskField = label === 'preferred name'
      ? 'preferredName'
      : label === 'work email'
        ? 'workEmail'
        : label.startsWith('phone')
          ? 'phoneNumber'
          : label === 'city'
            ? 'city'
            : label === 'benefit plan'
              ? 'benefitPlan'
              : 'startDate';
    markers.push({ key, start: match.index, end: match.index + match[0].length });
  }
  const values = new Map<PublicTaskField, string>();
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    if (!marker) continue;
    const next = markers[index + 1]?.start ?? task.length;
    let value = task.slice(marker.end, next).trim();
    value = value
      .replace(/^[,;:\s]+/u, '')
      .replace(/,?\s+(?:then|and then)\s+(?:check|submit|confirm)\b[\s\S]*$/iu, '')
      .replace(/[\s,;.]+$/u, '')
      .trim();
    if (value && value.length <= 200 && !values.has(marker.key)) values.set(marker.key, value);
  }
  return values;
}

function publicFieldKey(element: Element): PublicTaskField | null {
  if (element.getAttribute('data-public-field') !== 'true') return null;
  const metadata = [element.getAttribute('name'), element.getAttribute('id'), labelOf(element)]
    .filter(Boolean).join(' ').toLocaleLowerCase().replace(/[_-]+/gu, ' ');
  if (/preferred\s+name|\bname\b/u.test(metadata)) return 'preferredName';
  if (/work\s+email|\bemail\b/u.test(metadata)) return 'workEmail';
  if (/phone|mobile|telephone/u.test(metadata)) return 'phoneNumber';
  if (/\bcity\b|locality/u.test(metadata)) return 'city';
  if (/benefit\s+plan/u.test(metadata)) return 'benefitPlan';
  if (/coverage\s+start|start\s+date/u.test(metadata)) return 'startDate';
  return null;
}

function setNativeSelectValue(element: HTMLSelectElement, value: string): void {
  const normalized = value.trim().toLocaleLowerCase();
  const option = Array.from(element.options).find((candidate) =>
    candidate.value.trim().toLocaleLowerCase() === normalized
    || candidate.text.trim().toLocaleLowerCase() === normalized,
  );
  if (!option) throw new Error('Requested public option is unavailable');
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Select cannot be edited');
  setter.call(element, option.value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillPublicFieldsFromTask(task: string): string {
  const requested = extractPublicTaskFields(task);
  if (requested.size === 0) return 'No explicit public field values found; continuing with the agent planner.';
  const filled: PublicTaskField[] = [];
  const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    'input[data-public-field="true"], textarea[data-public-field="true"], select[data-public-field="true"]',
  );
  for (const field of fields) {
    const key = publicFieldKey(field);
    const value = key ? requested.get(key) : undefined;
    if (!key || value === undefined || !visible(field)) continue;
    if ('disabled' in field && field.disabled) continue;
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      if (field.readOnly) continue;
      setNativeValue(field, value);
    } else {
      setNativeSelectValue(field, value);
    }
    if (!filled.includes(key)) filled.push(key);
  }
  if (filled.length > 0) {
    const first = Array.from(fields).find((field) => filled.includes(publicFieldKey(field) as PublicTaskField));
    first?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }
  return filled.length
    ? `Filled ${filled.length} public field${filled.length === 1 ? '' : 's'} locally. Review every value before submission.`
    : 'No matching public fields were available; continuing with the agent planner.';
}

function requireCheckboxTarget(target: Element): HTMLInputElement | Element {
  const isNativeCheckbox = target instanceof HTMLInputElement && target.type === 'checkbox';
  if (!isNativeCheckbox && target.getAttribute('role') !== 'checkbox') throw new Error('Action target is not a checkbox');
  return target;
}

function targetChecked(target: Element): boolean {
  return target instanceof HTMLInputElement ? target.checked : target.getAttribute('aria-checked') === 'true';
}

function dispatchHover(target: Element): void {
  target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
  target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: true, view: window }));
}

function requiresConfirmation(target: Element): boolean {
  // Checking a required consent box is preparation, not the irreversible
  // submission itself. The explicit confirmation belongs to the terminal
  // submit/confirm control after the fields are visible for review.
  if (target instanceof HTMLInputElement && target.type === 'checkbox' || target.getAttribute('role') === 'checkbox') return false;
  const label = labelOf(target).toLowerCase();
  return ['delete', 'remove', 'submit', 'pay', 'checkout', 'buy', 'confirm'].some(term => label.includes(term))
    || (target as HTMLButtonElement | HTMLInputElement).type === 'submit';
}

function requestPageApproval(label: string): Promise<boolean> {
  if (pendingApproval) return pendingApproval;
  const host = document.createElement('div');
  host.dataset.sihAgentUi = 'true';
  host.style.setProperty('all', 'initial');
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .card {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 2147483647;
        width: min(360px, calc(100vw - 40px));
        box-sizing: border-box;
        padding: 18px;
        border: 1px solid rgba(255, 255, 255, .18);
        border-radius: 16px;
        background: linear-gradient(145deg, #1d1d1d, #0c0c0c);
        color: #f8fbff;
        box-shadow: 0 24px 64px rgba(0, 0, 0, .58), 0 0 0 1px rgba(255, 255, 255, .04);
        font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .eyebrow { margin: 0 0 7px; color: #8f8f94; font-size: 11px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
      h2 { margin: 0 0 8px; font-size: 17px; line-height: 1.2; }
      p { margin: 0 0 14px; color: #b1b1b6; }
      .label { color: #fff; font-weight: 650; }
      .actions { display: flex; gap: 9px; justify-content: flex-end; }
      button { border: 1px solid rgba(255, 255, 255, .14); border-radius: 10px; cursor: pointer; font: inherit; font-weight: 700; padding: 10px 14px; transition: background .15s ease, transform .15s ease; }
      button:focus-visible { outline: 3px solid rgba(79, 134, 255, .7); outline-offset: 2px; }
      button:hover { transform: translateY(-1px); }
      .cancel { background: #303037; color: #e3e3e8; }
      .cancel:hover { background: #424249; }
      .approve { background: #4f86ff; color: #fff; }
      .approve:hover { background: #6796ff; }
      @media (max-width: 520px) { .card { right: 10px; bottom: 10px; width: calc(100vw - 20px); } }
    </style>
    <section class="card" role="dialog" aria-labelledby="agent-confirm-title" aria-describedby="agent-confirm-copy" aria-modal="false">
      <p class="eyebrow">Private Browser Agent</p>
      <h2 id="agent-confirm-title">Review before submitting</h2>
      <p id="agent-confirm-copy">Review every populated field on this page. The agent is ready to click <span class="label"></span>.</p>
      <div class="actions"><button class="cancel" type="button">Cancel</button><button class="approve" type="button">Approve submission</button></div>
    </section>`;
  const labelNode = shadow.querySelector('.label');
  if (labelNode) labelNode.textContent = label;
  const cancel = shadow.querySelector<HTMLButtonElement>('.cancel');
  const approve = shadow.querySelector<HTMLButtonElement>('.approve');
  const promise = new Promise<boolean>((resolve) => {
    const finish = (approved: boolean) => {
      host.remove();
      resolve(approved);
    };
    cancel?.addEventListener('click', () => finish(false), { once: true });
    approve?.addEventListener('click', () => finish(true), { once: true });
  });
  pendingApproval = promise;
  void promise.then(() => {
    if (pendingApproval === promise) pendingApproval = null;
  });
  (document.documentElement ?? document.body).append(host);
  return promise;
}

async function confirmDestructiveAction(target: Element, autoApproveIrreversible: boolean): Promise<boolean> {
  if (!requiresConfirmation(target)) return true;
  if (destructiveActionInFlight) return false;
  if (autoApproveIrreversible && isSyntheticLocalDemo()) {
    destructiveActionInFlight = true;
    return true;
  }
  const label = labelOf(target);
  if (!await requestPageApproval(label)) {
    throw new Error('User rejected irreversible action');
  }
  if (destructiveActionInFlight) return false;
  destructiveActionInFlight = true;
  return true;
}

function isSyntheticLocalDemo(): boolean {
  return location.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)
    && location.port === '8765'
    && /^\/demo(?:\/|$)/u.test(location.pathname);
}

async function executeAction(command: Extract<ContentCommand, { type: 'EXECUTE_ACTION' }>): Promise<string> {
  if (command.snapshotId !== currentSnapshotId) throw new Error('Snapshot is stale');
  if (command.documentId !== documentId || command.documentRevision !== documentRevision) throw new Error('Document changed after capture');
  const action: AgentAction = command.action;
  const actionKey = `${command.snapshotId}:${JSON.stringify(action)}`;
  if (actionKey === lastExecutedActionKey) throw new Error('Duplicate action rejected');
  // Reserve the key while the asynchronous action is in flight so concurrent
  // duplicate messages cannot both mutate the page. A failed action releases
  // the reservation, allowing a safe retry when no mutation was committed.
  lastExecutedActionKey = actionKey;
  try {
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
        target.scrollBy({ top, behavior: 'auto' });
      } else window.scrollBy({ top, behavior: 'auto' });
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
      if (!await confirmDestructiveAction(target, command.autoApproveIrreversible === true)) return 'Submission already approved; waiting for the page result';
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
        try {
          setNativeSelectValue(target, action.text ?? '');
        } catch (error) {
          // A local public-field pass may already have selected the option;
          // the model cannot see the option text at strict privacy grades.
          // Preserve that verified local choice instead of failing on a
          // redundant/opaque option token.
          const current = target.selectedOptions[0];
          if (target.value && current && !/^choose\b|^select\b/iu.test(current.text.trim())) return 'Select already set';
          throw error;
        }
      } else throw new Error('Action target is not editable');
      return 'Entered text';
    }
    if (action.type === 'select') {
      if (!(target instanceof HTMLSelectElement)) throw new Error('Action target is not a select');
      if (target.disabled) throw new Error('Action target is not editable');
      setNativeSelectValue(target, action.option ?? '');
      return 'Selected option';
    }
    if (action.type === 'focus') {
      target.focus();
      return 'Focused element';
    }
    if (action.type === 'hover') {
      dispatchHover(target);
      return 'Hovered element';
    }
    if (action.type === 'doubleClick') {
      const control = target as HTMLButtonElement | HTMLInputElement;
      if ('disabled' in control && Boolean(control.disabled) || target.getAttribute('aria-disabled') === 'true') {
        throw new Error('Action target is disabled');
      }
      if (!await confirmDestructiveAction(target, command.autoApproveIrreversible === true)) return 'Submission already approved; waiting for the page result';
      target.focus();
      target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      return 'Double-clicked element';
    }
    if (action.type === 'check' || action.type === 'uncheck') {
      const checkbox = requireCheckboxTarget(target);
      if ('disabled' in checkbox && Boolean((checkbox as HTMLInputElement).disabled) || checkbox.getAttribute('aria-disabled') === 'true') {
        throw new Error('Action target is disabled');
      }
      const shouldBeChecked = action.type === 'check';
      if (targetChecked(checkbox) === shouldBeChecked) return shouldBeChecked ? 'Checkbox already checked' : 'Checkbox already unchecked';
      checkbox.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
      (checkbox as HTMLElement).click();
      return shouldBeChecked ? 'Checked checkbox' : 'Unchecked checkbox';
    }
    throw new Error('Unsupported action');
  } catch (error) {
    if (lastExecutedActionKey === actionKey) lastExecutedActionKey = '';
    throw error;
  }
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
    if (command.type === 'SET_SCROLL_GUARD') {
      if (command.active) scrollDriftGuard.activate();
      else scrollDriftGuard.deactivate();
      return { ok: true, scrollDrift: scrollDriftGuard.state };
    }
    if (command.type === 'GET_SCROLL_DRIFT') {
      return { ok: true, scrollDrift: scrollDriftGuard.state };
    }
    if (command.type === 'CAPTURE_DOM') {
      if (!isPrivacyGrade(command.privacyGrade)) throw new Error('Invalid privacy grade');
      return { ok: true, snapshot: captureDom(command.snapshotId, command.knownValues, command.privacyGrade) };
    }
    if (command.type === 'FILL_PUBLIC_FIELDS') return { ok: true, result: fillPublicFieldsFromTask(command.task) };
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
