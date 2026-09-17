import type { SanitizedDomPreview, SanitizedElement } from './types';

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function addMetric(parent: HTMLElement, label: string, value: string): void {
  const wrapper = createElement('div');
  const term = createElement('dt');
  term.textContent = label;
  const description = createElement('dd');
  description.textContent = value;
  wrapper.append(term, description);
  parent.append(wrapper);
}

function rounded(value: number): string {
  return String(Math.round(value));
}

function formatBounds(element: SanitizedElement): string {
  const { x, y, width, height } = element.bounds;
  return `x ${rounded(x)} · y ${rounded(y)} · ${rounded(width)} × ${rounded(height)} px`;
}

function stateLabels(element: SanitizedElement): string[] {
  const labels: string[] = [];
  if (element.state.editable) labels.push('editable');
  if (element.state.required) labels.push('required');
  if (element.state.checked) labels.push('checked');
  if (element.state.disabled) labels.push('disabled');
  return labels.length > 0 ? labels : ['ready'];
}

function renderElement(parent: HTMLOListElement, element: SanitizedElement): void {
  const row = createElement('li', 'dom-element-row');
  const header = createElement('div', 'dom-element-header');
  const id = createElement('code', 'dom-element-id');
  id.textContent = `#${element.id}`;
  const role = createElement('span', 'dom-element-role');
  role.textContent = element.role;
  header.append(id, role);

  const label = createElement('p', 'dom-element-label');
  label.textContent = element.label || 'No safe label retained';

  const metadata = createElement('div', 'dom-element-metadata');
  const bounds = createElement('span');
  bounds.textContent = formatBounds(element);
  metadata.append(bounds);
  for (const state of stateLabels(element)) {
    const chip = createElement('span', 'dom-state-chip');
    chip.textContent = state;
    metadata.append(chip);
  }

  row.append(header, label, metadata);
  parent.append(row);
}

function safePayload(preview: SanitizedDomPreview): Readonly<Record<string, unknown>> {
  return {
    snapshotId: preview.snapshotId,
    documentId: preview.documentId,
    page: {
      originAlias: preview.originAlias,
      title: preview.title,
    },
    task: preview.task,
    elements: preview.elements.map((element) => ({
      id: element.id,
      role: element.role,
      label: element.label,
      bounds: element.bounds,
      state: element.state,
    })),
    privacy: {
      grade: preview.grade,
      detectorBackend: preview.detectorBackend,
      redactionCount: preview.redactionCount,
      ...(preview.registryDigest ? { registryDigest: preview.registryDigest } : {}),
    },
    redactionKinds: preview.redactionKinds,
  };
}

/**
 * Render the local proof view using textContent for every value. The caller
 * passes data derived from SanitizedObservation, never RawDomSnapshot.
 */
export function renderSanitizedDomPreview(root: HTMLElement, preview: SanitizedDomPreview): void {
  root.replaceChildren();

  const proof = createElement('div', 'dom-proof-banner');
  const proofMark = createElement('span', 'dom-proof-mark');
  proofMark.textContent = '✓';
  const proofCopy = createElement('span');
  proofCopy.textContent = 'Exact sanitized DOM fields paired with the redacted image above. This is the only DOM view eligible for the reasoning request.';
  proof.append(proofMark, proofCopy);

  const meta = createElement('dl', 'dom-proof-meta');
  addMetric(meta, 'Elements', String(preview.elementCount));
  addMetric(meta, 'Image masks', String(preview.redactionCount));
  addMetric(meta, 'Privacy grade', `Grade ${preview.grade}`);
  addMetric(meta, 'Detector', preview.detectorBackend);
  addMetric(meta, 'Origin alias', preview.originAlias);
  addMetric(meta, 'Snapshot', preview.snapshotId);
  if (preview.registryDigest) addMetric(meta, 'Policy digest', preview.registryDigest);

  const context = createElement('div', 'dom-proof-context');
  const task = createElement('div', 'dom-proof-field');
  const taskLabel = createElement('span');
  taskLabel.textContent = 'Sanitized task';
  const taskValue = createElement('code');
  taskValue.textContent = preview.task || 'No task retained in local preview';
  task.append(taskLabel, taskValue);
  const title = createElement('div', 'dom-proof-field');
  const titleLabel = createElement('span');
  titleLabel.textContent = 'Sanitized page title';
  const titleValue = createElement('code');
  titleValue.textContent = preview.title || 'No title retained';
  title.append(titleLabel, titleValue);
  context.append(task, title);

  const elementSection = createElement('section', 'dom-elements-section');
  const elementHeading = createElement('div', 'dom-elements-heading');
  const heading = createElement('h3');
  heading.textContent = 'Interactive structure sent to the server';
  const count = createElement('span');
  count.textContent = `${preview.elementCount} element${preview.elementCount === 1 ? '' : 's'}`;
  elementHeading.append(heading, count);
  const list = createElement('ol', 'dom-element-list');
  if (preview.elements.length === 0) {
    const empty = createElement('li', 'dom-element-empty');
    empty.textContent = 'No visible interactive elements were retained in this snapshot.';
    list.append(empty);
  } else {
    for (const element of preview.elements) renderElement(list, element);
  }
  elementSection.append(elementHeading, list);

  const omissions = createElement('p', 'dom-proof-omissions');
  omissions.textContent = 'Omitted locally: raw input values, CSS selectors, DOM references, cookies, real URL, and the raw DOM snapshot.';

  const details = createElement('details', 'dom-proof-json');
  const summary = createElement('summary');
  summary.textContent = 'View the sanitized DOM payload';
  const pre = createElement('pre');
  pre.textContent = JSON.stringify(safePayload(preview), null, 2);
  details.append(summary, pre);

  root.append(proof, meta, context, elementSection, omissions, details);
}
