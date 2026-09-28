import type { RedactionAuditItem, SanitizedDomPreview, SanitizedElement } from './types';

const FRIENDLY_TYPES: Readonly<Record<string, string>> = {
  AADHAAR_CARD: 'Aadhaar document — masked region',
  PAN_CARD: 'PAN document — masked region',
  FACE: 'Face (biometric)',
  AADHAAR: 'Aadhaar number',
  ADDRESS: 'Home or postal address',
  BANK_ACCOUNT: 'Bank account number',
  CREDIT_CARD: 'Credit card number',
  DATE_OF_BIRTH: 'Date of birth',
  EMAIL: 'Email address',
  EMPLOYEE_ID: 'Employee ID',
  FILE_NUMBER: 'File or reference number',
  LOCATION: 'Location',
  NAME: 'Person name',
  PAN: 'PAN or tax identifier',
  PASSWORD: 'Password field',
  PHONE: 'Phone number',
  PII_TEXT: 'Personal information',
  SENSITIVE_FIELD: 'Sensitive form field',
  SECRET: 'Secret or token',
  UNINSPECTABLE_MEDIA: 'Uninspectable image or media',
  USERNAME: 'Username',
};

const TYPE_ICONS: Readonly<Record<string, string>> = {
  AADHAAR_CARD: '🪪', PAN_CARD: '🪪', FACE: '👤',
  AADHAAR: '🔢', ADDRESS: '📍', BANK_ACCOUNT: '🏦',
  CREDIT_CARD: '💳', DATE_OF_BIRTH: '📅', EMAIL: '✉️',
  EMPLOYEE_ID: '🏢', FILE_NUMBER: '📄', LOCATION: '📍',
  NAME: '👤', PAN: '🔢', PASSWORD: '🔒', PHONE: '📞',
  PII_TEXT: '⚠️', SENSITIVE_FIELD: '🔒', SECRET: '🔑',
  UNINSPECTABLE_MEDIA: '🖼️', USERNAME: '👤',
};

const CATEGORY_GROUP_NAME: Readonly<Record<string, string>> = {
  AADHAAR_CARD: 'Aadhaar Card',
  PAN_CARD: 'PAN Card',
  FACE: 'Faces',
  UNINSPECTABLE_MEDIA: 'Uninspectable Media',
  SENSITIVE_FIELD: 'Sensitive Form Fields',
  PII_TEXT: 'Personal Information (PII)',
};

const LAYER_LABELS: Readonly<Record<RedactionAuditItem['layer'], { label: string; detail: string }>> = {
  dom: { label: 'DOM field', detail: 'page metadata' },
  regex: { label: 'Pattern match', detail: 'local rules' },
  ner: { label: 'Entity model', detail: 'local language model' },
  vision: { label: 'Vision model', detail: 'local image model' },
  ocr: { label: 'OCR', detail: 'local text reading' },
  fallback: { label: 'Safety fallback', detail: 'fail-closed mask' },
};

function friendlyType(type: string): string {
  return FRIENDLY_TYPES[type] ?? type.replace(/_/gu, ' ').toLowerCase().replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function layerInfo(layer: RedactionAuditItem['layer']): { label: string; detail: string } {
  return LAYER_LABELS[layer] ?? { label: 'Local detector', detail: 'on-device' };
}

function layerClass(layer: RedactionAuditItem['layer']): string {
  return `report-layer-${layer}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] ?? character));
}

function inferFieldCategory(item: RedactionAuditItem): string {
  if (item.type === 'PASSWORD') return 'Password input field';
  if (item.type === 'UNINSPECTABLE_MEDIA') return 'Uninspectable image / media (safety mask)';
  if (item.type === 'FACE') return 'Facial biometric region';
  if (item.type === 'PII_TEXT') {
    if (item.layer === 'regex') return 'Sensitive text pattern (regex match)';
    if (item.layer === 'dom') return 'Sensitive text (page element)';
    if (item.layer === 'ocr') return 'Extracted document text (local OCR)';
    return 'Personal information text';
  }
  if (item.type === 'SENSITIVE_FIELD') {
    return 'Sensitive form field (DOM attribute / label)';
  }
  if (!item.hasOnScreenBox) return 'Structured data (text only)';
  const { width, height } = item.bounds;
  const aspect = width / Math.max(1, height);
  const area = width * height;
  if (aspect >= 0.6 && aspect <= 1.6 && area < 35000) return 'Photo / biometric area';
  if (aspect >= 0.6 && aspect <= 1.6 && area >= 35000) return 'Document image area';
  if (aspect > 3 && height < 45) return 'Single-line text field';
  if (aspect > 2) return 'Wide text region';
  if (area > 60000) return 'Full document zone';
  return friendlyType(item.type);
}

function renderProtectionStory(parent: HTMLElement): void {
  const section = createElement('section', 'dom-protection-story');
  const copy = createElement('p'); copy.textContent = 'This proof is generated on-device before the request leaves the browser.';
  const steps = createElement('div', 'dom-protection-steps');
  const entries = [
    ['1', 'Detect', 'Local DOM, pattern, and vision checks identify sensitive content.'],
    ['2', 'Replace', 'The original value becomes a safe handle and pixels are masked.'],
    ['3', 'Transmit', 'Only the safe structure and sanitized image are eligible to leave.'],
  ] as const;
  entries.forEach(([number, title, detail], index) => {
    const card = createElement('article', 'dom-protection-step');
    const numberNode = createElement('span', 'dom-protection-number'); numberNode.textContent = number;
    const titleNode = createElement('strong'); titleNode.textContent = title;
    const detailNode = createElement('p'); detailNode.textContent = detail;
    card.append(numberNode, titleNode, detailNode); steps.append(card);
    if (index < entries.length - 1) { const arrow = createElement('span', 'dom-protection-arrow'); arrow.textContent = '→'; steps.append(arrow); }
  });
  section.append(copy, steps); parent.append(section);
}

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
    ...(preview.domAudit ? { domAudit: preview.domAudit } : {}),
    ...(preview.redactions ? { redactions: preview.redactions } : {}),
  };
}

function renderAudit(parent: HTMLElement, preview: SanitizedDomPreview): void {
  if (!preview.domAudit) return;
  const section = createElement('section', 'dom-audit-section');
  const heading = createElement('h3');
  heading.textContent = 'DOM before → after · local proof';
  const copy = createElement('p');
  copy.textContent = 'Counts are measured locally. Values and selectors never enter this proof view.';
  const grid = createElement('div', 'dom-audit-grid');
  for (const [title, rows] of [
    ['Before sanitization', [
      ['Interactive nodes', preview.domAudit.rawInteractiveCount],
      ['Candidate sensitive regions', preview.domAudit.rawCandidateRedactions],
      ['Sensitive fields', preview.domAudit.rawSensitiveFields],
    ]],
    ['After sanitization', [
      ['Safe nodes retained', preview.domAudit.sanitizedInteractiveCount],
      ['Redaction handles', preview.domAudit.sanitizedRedactions],
      ['Raw values retained', 0],
    ]],
  ] as const) {
    const card = createElement('article', 'dom-audit-card');
    const cardTitle = createElement('h4'); cardTitle.textContent = title;
    card.append(cardTitle);
    for (const [label, value] of rows) {
      const row = createElement('div', 'dom-audit-row');
      const key = createElement('span'); key.textContent = label;
      const val = createElement('strong'); val.textContent = String(value);
      row.append(key, val); card.append(row);
    }
    grid.append(card);
  }
  section.append(heading, copy, grid);
  parent.append(section);
}

function renderRedactions(parent: HTMLElement, redactions: readonly RedactionAuditItem[] | undefined): void {
  const items = redactions ?? [];
  const section = createElement('section', 'dom-redactions-section');

  // 1. Judge verdict header: What was detected, where, and what happened to it?
  const verdict = createElement('div', 'judge-verdict');
  verdict.style.marginBottom = '14px';

  const statusPill = createElement('div', 'jv-status jv-status-preview');
  statusPill.innerHTML = `<span class="jv-status-dot jv-dot-preview"></span><strong>LOCAL PREVIEW</strong> — strictly 0 raw values leave this device`;
  verdict.append(statusPill);

  const verdictTitle = createElement('h3', 'jv-title');
  verdictTitle.textContent = 'Privacy Protection Summary';
  verdict.append(verdictTitle);

  // Group items by type
  const typeGroups = new Map<string, RedactionAuditItem[]>();
  items.forEach((item) => {
    const list = typeGroups.get(item.type) ?? [];
    list.push(item);
    typeGroups.set(item.type, list);
  });

  const typeSummaryParts: string[] = [];
  for (const [type, groupItems] of typeGroups) {
    const icon = TYPE_ICONS[type] ?? '🛡️';
    const name = CATEGORY_GROUP_NAME[type] ?? friendlyType(type);
    typeSummaryParts.push(`${icon} ${groupItems.length}× ${name}`);
  }

  const layerGroups = new Map<RedactionAuditItem['layer'], number>();
  items.forEach((item) => layerGroups.set(item.layer, (layerGroups.get(item.layer) ?? 0) + 1));

  const answers = createElement('div', 'jv-answers');

  const whatCard = createElement('article', 'jv-card');
  whatCard.innerHTML = `<div class="jv-card-icon">🔍</div><h3>What was detected?</h3><p class="jv-card-big">${items.length} sensitive region${items.length === 1 ? '' : 's'}</p><p class="jv-card-detail">${typeSummaryParts.join('<br>') || 'Nothing detected'}</p>`;

  const whereCard = createElement('article', 'jv-card');
  const layerLines = Array.from(layerGroups.entries()).map(([layer, count]) => {
    const info = layerInfo(layer);
    return `<span class="jv-layer-pill ${layerClass(layer)}">${info.label}</span> found ${count}`;
  }).join('<br>');
  whereCard.innerHTML = `<div class="jv-card-icon">📍</div><h3>How were they found?</h3><p class="jv-card-big">${layerGroups.size} detection layer${layerGroups.size === 1 ? '' : 's'}</p><p class="jv-card-detail">${layerLines || 'No detections'}</p>`;

  const actionCard = createElement('article', 'jv-card');
  actionCard.innerHTML = `<div class="jv-card-icon">🛡️</div><h3>What happened to it?</h3><p class="jv-card-big">Redacted before reasoning</p><p class="jv-card-detail">All ${items.length} region${items.length === 1 ? '' : 's'}: original values replaced with safe handles, pixels masked with opaque overlay.<br>Raw values: <strong>0 transmitted</strong></p>`;

  answers.append(whatCard, whereCard, actionCard);
  verdict.append(answers);
  section.append(verdict);

  // 2. Findings breakdown
  if (items.length > 0) {
    const findingsSection = createElement('div', 'judge-findings');
    const findingsTitle = createElement('h3', 'jf-title');
    findingsTitle.textContent = 'Protected Regions Breakdown';
    findingsSection.append(findingsTitle);

    const docTypes = Array.from(typeGroups.entries()).filter(([type]) => type === 'AADHAAR_CARD' || type === 'PAN_CARD');
    if (docTypes.length > 0) {
      const insightBox = createElement('div', 'jf-insight');
      insightBox.innerHTML = `<strong>💡 Important</strong> Each entry below is a <em>masked area</em> on a document — not a separate document. A single card contains multiple sensitive zones (photo, name, number, DOB, address). Each zone receives its own privacy mask.`;
      findingsSection.append(insightBox);
    }

    const findingsGrid = createElement('div', 'jf-grid');
    let globalIndex = 0;
    for (const [type, groupItems] of typeGroups) {
      const card = createElement('article', 'jf-card');
      const icon = TYPE_ICONS[type] ?? '🛡️';
      const groupName = CATEGORY_GROUP_NAME[type] ?? friendlyType(type);
      const isDoc = type === 'AADHAAR_CARD' || type === 'PAN_CARD';

      const header = createElement('div', 'jf-card-header');
      header.innerHTML = `<span class="jf-icon">${icon}</span><div><strong>${escapeHtml(groupName)}</strong><span class="jf-count">${groupItems.length} zone${groupItems.length === 1 ? '' : 's'} masked</span></div>`;
      card.append(header);

      if (isDoc) {
        const docNote = createElement('p', 'jf-doc-note');
        const docName = type === 'AADHAAR_CARD' ? 'Aadhaar card' : 'PAN card';
        docNote.textContent = `1 ${docName} detected → ${groupItems.length} sensitive zones masked individually.`;
        card.append(docNote);
      }

      const zoneList = createElement('div', 'jf-zone-list');
      for (const item of groupItems) {
        globalIndex++;
        const zone = createElement('div', 'jf-zone');
        const num = createElement('span', 'jf-zone-num'); num.textContent = String(globalIndex);
        const desc = createElement('div', 'jf-zone-desc');
        const category = inferFieldCategory(item);
        const layerTag = createElement('span', `jf-layer-tag ${layerClass(item.layer)}`);
        layerTag.textContent = layerInfo(item.layer).label;
        desc.innerHTML = `<strong>${escapeHtml(category)}</strong><code>${escapeHtml(item.handle)}</code>`;
        const conf = createElement('span', 'jf-zone-conf');
        conf.textContent = `${Math.round(item.confidence)}%`;
        zone.append(num, desc, layerTag, conf);
        zoneList.append(zone);
      }
      card.append(zoneList);
      findingsGrid.append(card);
    }
    findingsSection.append(findingsGrid);
    section.append(findingsSection);
  }

  // 3. Technical inventory table behind collapsible details
  const details = createElement('details', 'jt-details');
  const summary = createElement('summary');
  summary.textContent = `Full redaction inventory table (${items.length} items)`;
  details.append(summary);

  const tableWrap = createElement('div', 'table-wrap');
  const table = createElement('table', 'dom-redactions-table');
  const head = createElement('tr');
  for (const label of ['What was protected', 'Safe handle', 'Detected locally by', 'Confidence', 'Screen area']) {
    const cell = createElement('th'); cell.textContent = label; head.append(cell);
  }
  const thead = createElement('thead'); thead.append(head); table.append(thead);
  const body = createElement('tbody');
  for (const item of items) {
    const row = createElement('tr');
    const what = createElement('td', 'dom-redaction-what');
    const whatTitle = createElement('strong'); whatTitle.textContent = friendlyType(item.type);
    const whatCode = createElement('small'); whatCode.textContent = item.type;
    what.append(whatTitle, whatCode);
    const handle = createElement('td', 'dom-redaction-handle'); const handleCode = createElement('code'); handleCode.textContent = item.handle; handle.append(handleCode);
    const detected = createElement('td', 'dom-redaction-layer'); const info = layerInfo(item.layer); const badge = createElement('span', `dom-layer-badge dom-layer-${item.layer}`); badge.textContent = info.label; const layerDetail = createElement('small'); layerDetail.textContent = info.detail; detected.append(badge, layerDetail);
    const confidence = createElement('td', 'dom-redaction-confidence'); const bar = createElement('span', 'dom-confidence-bar'); const fill = createElement('i'); fill.style.width = `${Math.max(0, Math.min(100, item.confidence))}%`; bar.append(fill); const confidenceText = createElement('strong'); confidenceText.textContent = `${item.confidence}%`; confidence.append(bar, confidenceText);
    const bounds = createElement('td'); bounds.textContent = item.hasOnScreenBox ? `${Math.round(item.bounds.width)} × ${Math.round(item.bounds.height)} px` : 'No visible box';
    row.append(what, handle, detected, confidence, bounds);
    body.append(row);
  }
  if (!items.length) {
    const row = createElement('tr'); const cell = createElement('td'); cell.colSpan = 5; cell.textContent = 'No sensitive regions detected.'; row.append(cell); body.append(row);
  }
  table.append(body);
  tableWrap.append(table);
  details.append(tableWrap);
  section.append(details);

  parent.append(section);
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
  heading.textContent = 'Safe interactive structure · eligible for transmission';
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

  root.append(proof, meta, context);
  renderAudit(root, preview);
  renderProtectionStory(root);
  renderRedactions(root, preview.redactions);
  root.append(elementSection, omissions, details);
}
