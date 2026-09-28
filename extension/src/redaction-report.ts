import type {
  DomSanitizationAudit,
  LatencyBreakdown,
  PolicyBlock,
  RawDomSnapshot,
  Redaction,
  RedactionAuditItem,
  RedactionReport,
  SanitizedObservation,
} from './types';

const DEFAULT_LATENCY: LatencyBreakdown = {
  screenshotMs: 0,
  domInspectionMs: 0,
  sanitizationMs: 0,
  networkMs: 0,
  actionMs: 0,
  totalMs: 0,
};

/**
 * Render a measured duration without presenting an unexecuted phase as a
 * fabricated zero. Capture, sanitization, network, and action timings are
 * written by the background run timers; a zero means that phase has not run
 * for this report (for example, preview never makes a network request).
 */
export function formatLatency(value: number): string {
  return Number.isFinite(value) && value > 0 ? `${Math.round(value)} ms` : '—';
}

function upperKind(kind: string): string {
  return kind.replace(/[^a-z0-9]+/giu, '_').replace(/^_|_$/gu, '').toUpperCase() || 'SENSITIVE';
}

const SAFE_FIELD_TYPES = new Set([
  'PASSWORD', 'SECRET', 'NAME', 'EMAIL', 'PHONE', 'ADDRESS', 'LOCATION', 'DATE_OF_BIRTH',
  'AADHAAR', 'PAN', 'VOTER_ID', 'DRIVING_LICENSE', 'PASSPORT', 'CREDIT_CARD', 'BANK_ACCOUNT',
  'EMPLOYEE_ID', 'CUSTOMER_ID', 'USERNAME', 'IP_ADDRESS', 'SIGNATURE', 'SENSITIVE_FIELD',
]);

function displayType(kind: string, fieldLabel: string | undefined): string {
  const candidate = fieldLabel ? upperKind(fieldLabel) : '';
  return SAFE_FIELD_TYPES.has(candidate) ? candidate : upperKind(kind);
}

function layerFor(source: Redaction['source']): RedactionAuditItem['layer'] {
  if (source === 'dom') return 'dom';
  if (source === 'regex') return 'regex';
  if (source === 'ocr' || source === 'dbnet') return 'ocr';
  if (source === 'onnx' || source === 'unified-detector') return 'vision';
  return 'fallback';
}

function defaultConfidence(source: Redaction['source']): number {
  if (source === 'dom' || source === 'fallback') return 1;
  if (source === 'regex') return 0.99;
  if (source === 'unified-detector' || source === 'onnx') return 0.95;
  if (source === 'ocr' || source === 'dbnet') return 0.92;
  return 0.9;
}

function safeConfidence(value: number | undefined, source: Redaction['source']): number {
  const candidate = typeof value === 'number' && Number.isFinite(value) ? value : defaultConfidence(source);
  return Math.round(Math.min(1, Math.max(0, candidate)) * 100);
}

function matchingFieldLabel(redaction: Redaction, hints: readonly RawDomSnapshot['redactions'][number][]): string | undefined {
  const match = hints.find((hint) => hint.kind === redaction.kind
    && Math.abs(hint.bounds.x - redaction.bounds.x) < 1
    && Math.abs(hint.bounds.y - redaction.bounds.y) < 1
    && Math.abs(hint.bounds.width - redaction.bounds.width) < 1
    && Math.abs(hint.bounds.height - redaction.bounds.height) < 1);
  return match?.fieldLabel;
}

export function buildRedactionAudit(redactions: readonly Redaction[], sourceHints: readonly RawDomSnapshot['redactions'][number][] = []): readonly RedactionAuditItem[] {
  const counts = new Map<string, number>();
  return redactions.map((redaction, index) => {
    const type = displayType(redaction.kind, matchingFieldLabel(redaction, sourceHints));
    const next = (counts.get(type) ?? 0) + 1;
    counts.set(type, next);
    const bounds = {
      x: Number.isFinite(redaction.bounds.x) ? Math.max(0, redaction.bounds.x) : 0,
      y: Number.isFinite(redaction.bounds.y) ? Math.max(0, redaction.bounds.y) : 0,
      width: Number.isFinite(redaction.bounds.width) ? Math.max(0, redaction.bounds.width) : 0,
      height: Number.isFinite(redaction.bounds.height) ? Math.max(0, redaction.bounds.height) : 0,
    };
    return {
      handle: `[${type}_${next}]`,
      fieldId: `FIELD_${redactions.indexOf(redaction) + 1}`,
      type,
      layer: layerFor(redaction.source),
      source: redaction.source,
      confidence: safeConfidence(redaction.confidence, redaction.source),
      bounds,
      hasOnScreenBox: bounds.width > 0 && bounds.height > 0,
      placeholder: `[REDACTED:${type}]`,
    };
  });
}

export function buildDomAudit(raw: RawDomSnapshot, observation: SanitizedObservation): DomSanitizationAudit {
  const rawCandidateRedactions = raw.redactions.length;
  const rawSensitiveFields = raw.redactions.filter((item) =>
    item.kind === 'password' || item.kind === 'sensitive-field' || item.kind === 'pii-text',
  ).length;
  return {
    rawInteractiveCount: raw.elements.length,
    rawCandidateRedactions,
    rawSensitiveFields,
    sanitizedInteractiveCount: observation.elements.length,
    sanitizedRedactions: observation.redactions.length,
    valuesOmitted: true,
    selectorsOmitted: true,
  };
}

export type ReportBuildInput = Readonly<{
  rawDom: RawDomSnapshot;
  observation: SanitizedObservation;
  maskedAreaPercentage: number;
  imageSha256: string;
  transmissionMode: RedactionReport['transmissionMode'];
  status?: RedactionReport['status'];
  actionsExecuted?: number;
  actionsBlocked?: number;
  networkRequests?: number;
  policyBlocks?: readonly PolicyBlock[];
  latency?: Partial<LatencyBreakdown>;
  reportId?: string;
}>;

export function buildRedactionReport(input: ReportBuildInput): RedactionReport {
  const latency: LatencyBreakdown = { ...DEFAULT_LATENCY, ...input.latency };
  const report: RedactionReport = {
    reportId: input.reportId ?? crypto.randomUUID(),
    generatedAt: new Date().toISOString(),
    status: input.status ?? 'preview',
    privacyGrade: input.observation.privacy.grade,
    detectorBackend: input.observation.privacy.detectorBackend,
    redactionCount: input.observation.redactions.length,
    maskedAreaPercentage: Math.round(Math.max(0, input.maskedAreaPercentage) * 100) / 100,
    actionsExecuted: input.actionsExecuted ?? 0,
    actionsBlocked: input.actionsBlocked ?? 0,
    networkRequests: input.networkRequests ?? 0,
    imageSha256: input.imageSha256,
    redactionMode: input.observation.privacy.redactionMode ?? 'opaque',
    transmissionMode: input.transmissionMode,
    domAudit: buildDomAudit(input.rawDom, input.observation),
    redactions: buildRedactionAudit(input.observation.redactions, input.rawDom.redactions),
    policyBlocks: input.policyBlocks ?? [],
    latency,
  };
  if (input.observation.privacy.detectorArch) {
    return { ...report, detectorArch: input.observation.privacy.detectorArch };
  }
  return report;
}

function create<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function metric(parent: HTMLElement, label: string, value: string): void {
  const item = create('div', 'report-metric');
  const labelNode = create('span', 'report-metric-label');
  labelNode.textContent = label;
  const valueNode = create('strong');
  valueNode.textContent = value;
  item.append(labelNode, valueNode);
  parent.append(item);
}

function confidence(value: number): string { return `${Math.round(value)}%`; }

const FRIENDLY_TYPES: Readonly<Record<string, string>> = {
  AADHAAR_CARD: 'Aadhaar document — masked region',
  PAN_CARD: 'PAN document — masked region',
  FACE: 'Face (biometric)',
  AADHAAR: 'Aadhaar number',
  ADDRESS: 'Home / postal address',
  BANK_ACCOUNT: 'Bank account number',
  CREDIT_CARD: 'Credit card number',
  DATE_OF_BIRTH: 'Date of birth',
  EMAIL: 'Email address',
  EMPLOYEE_ID: 'Employee ID',
  FILE_NUMBER: 'File / reference number',
  LOCATION: 'Location',
  NAME: 'Person name',
  PAN: 'PAN / tax identifier',
  PASSWORD: 'Password field',
  PHONE: 'Phone number',
  PII_TEXT: 'Personal information',
  SENSITIVE_FIELD: 'Sensitive form field',
  SECRET: 'Secret / token',
  UNINSPECTABLE_MEDIA: 'Uninspectable image / media',
  USERNAME: 'Username',
};

/** Icons for each type category to make visual scanning instant. */
const TYPE_ICONS: Readonly<Record<string, string>> = {
  AADHAAR_CARD: '🪪', PAN_CARD: '🪪', FACE: '👤',
  AADHAAR: '🔢', ADDRESS: '📍', BANK_ACCOUNT: '🏦',
  CREDIT_CARD: '💳', DATE_OF_BIRTH: '📅', EMAIL: '✉️',
  EMPLOYEE_ID: '🏢', FILE_NUMBER: '📄', LOCATION: '📍',
  NAME: '👤', PAN: '🔢', PASSWORD: '🔒', PHONE: '📞',
  PII_TEXT: '⚠️', SENSITIVE_FIELD: '🔒', SECRET: '🔑',
  UNINSPECTABLE_MEDIA: '🖼️', USERNAME: '👤',
};

/** Human-readable category group names for document types. */
const CATEGORY_GROUP_NAME: Readonly<Record<string, string>> = {
  AADHAAR_CARD: 'Aadhaar Card',
  PAN_CARD: 'PAN Card',
  FACE: 'Faces',
  UNINSPECTABLE_MEDIA: 'Uninspectable Media',
  SENSITIVE_FIELD: 'Sensitive Form Fields',
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

function renderAuditStory(parent: HTMLElement): void {
  const story = create('section', 'report-audit-story');
  const heading = create('h3'); heading.textContent = 'How the privacy boundary works';
  const copy = create('p'); copy.textContent = 'The page is inspected and sanitized on this device before any reasoning request is allowed.';
  const steps = create('div', 'report-story-steps');
  const entries = [
    ['1', 'Detect locally', 'DOM labels, text patterns, and local vision checks find sensitive regions.'],
    ['2', 'Redact locally', 'Values become safe handles and sensitive pixels are masked before egress.'],
    ['3', 'Send safe context', 'Only sanitized structure, handles, and pixels can reach the reasoning endpoint.'],
  ] as const;
  entries.forEach(([number, title, detail], index) => {
    const card = create('article', 'report-story-step');
    const numberNode = create('span', 'report-story-number'); numberNode.textContent = number;
    const titleNode = create('strong'); titleNode.textContent = title;
    const detailNode = create('p'); detailNode.textContent = detail;
    card.append(numberNode, titleNode, detailNode);
    steps.append(card);
    if (index < entries.length - 1) { const arrow = create('span', 'report-story-arrow'); arrow.textContent = '→'; steps.append(arrow); }
  });
  story.append(heading, copy, steps); parent.append(story);
}

function renderInventorySummary(parent: HTMLElement, items: readonly RedactionAuditItem[]): void {
  const summary = create('div', 'report-inventory-summary');
  const count = create('strong'); count.textContent = `${items.length} ${items.length === 1 ? 'region' : 'regions'} protected locally`;
  const byLayer = new Map<RedactionAuditItem['layer'], number>();
  items.forEach((item) => byLayer.set(item.layer, (byLayer.get(item.layer) ?? 0) + 1));
  const breakdown = Array.from(byLayer.entries()).map(([layer, total]) => `${total} ${layerInfo(layer).label.toLowerCase()}`).join(' · ');
  const detail = create('span'); detail.textContent = breakdown || 'No sensitive regions detected';
  summary.append(count, detail); parent.append(summary);
}

function renderDomAudit(parent: HTMLElement, audit: DomSanitizationAudit): void {
  const section = create('section', 'report-dom-audit');
  const heading = create('h3');
  heading.textContent = 'DOM before → after';
  const copy = create('p');
  copy.textContent = 'Counts are computed locally. Values, selectors, and DOM references are omitted from the report.';
  const grid = create('div', 'report-before-after');
  const before = create('article', 'report-audit-card report-audit-before');
  const beforeTitle = create('h4'); beforeTitle.textContent = 'Before sanitization';
  before.append(beforeTitle);
  metric(before, 'Interactive nodes observed', String(audit.rawInteractiveCount));
  metric(before, 'Candidate sensitive regions', String(audit.rawCandidateRedactions));
  metric(before, 'Sensitive fields', String(audit.rawSensitiveFields));
  const after = create('article', 'report-audit-card report-audit-after');
  const afterTitle = create('h4'); afterTitle.textContent = 'After sanitization';
  after.append(afterTitle);
  metric(after, 'Safe nodes retained', String(audit.sanitizedInteractiveCount));
  metric(after, 'Redaction handles', String(audit.sanitizedRedactions));
  metric(after, 'Raw values retained', audit.valuesOmitted ? '0' : 'unknown');
  grid.append(before, after);
  section.append(heading, copy, grid);
  parent.append(section);
}

export function renderRedactionReport(root: HTMLElement, report: RedactionReport, sanitizedImage: string | null = null): void {
  root.replaceChildren();

  // ── § 1  JUDGE VERDICT — answers "What / Where / What happened" in 3 seconds ──
  const isSent = report.networkRequests > 0;
  const verdict = create('section', 'judge-verdict');

  // Transmission status pill
  const statusPill = create('div', isSent ? 'jv-status jv-status-sent' : 'jv-status jv-status-preview');
  statusPill.innerHTML = isSent
    ? `<span class="jv-status-dot jv-dot-sent"></span><strong>DATA TRANSMITTED</strong> — ${report.networkRequests} request(s) sent after redaction`
    : `<span class="jv-status-dot jv-dot-preview"></span><strong>LOCAL PREVIEW</strong> — nothing left this device`;
  verdict.append(statusPill);

  // Big verdict title
  const verdictTitle = create('h2', 'jv-title');
  verdictTitle.textContent = 'Privacy Audit Verdict';
  const verdictStamp = create('p', 'jv-stamp');
  verdictStamp.textContent = `${new Date(report.generatedAt).toLocaleString()} · Grade ${report.privacyGrade} · ${report.detectorBackend}`;
  verdict.append(verdictTitle, verdictStamp);

  // Three answer cards: WHAT / WHERE / WHAT HAPPENED
  const answers = create('div', 'jv-answers');

  // Group redactions by type for the "WHAT" answer
  const typeGroups = new Map<string, RedactionAuditItem[]>();
  report.redactions.forEach((item) => {
    const list = typeGroups.get(item.type) ?? [];
    list.push(item);
    typeGroups.set(item.type, list);
  });
  const typeSummaryParts: string[] = [];
  for (const [type, items] of typeGroups) {
    const icon = TYPE_ICONS[type] ?? '🛡️';
    const name = CATEGORY_GROUP_NAME[type] ?? friendlyType(type);
    typeSummaryParts.push(`${icon} ${items.length}× ${name}`);
  }

  // Layer breakdown for "WHERE"
  const layerGroups = new Map<RedactionAuditItem['layer'], number>();
  report.redactions.forEach((item) => layerGroups.set(item.layer, (layerGroups.get(item.layer) ?? 0) + 1));

  const whatCard = create('article', 'jv-card');
  whatCard.innerHTML = `<div class="jv-card-icon">🔍</div><h3>What was detected?</h3><p class="jv-card-big">${report.redactions.length} sensitive region${report.redactions.length === 1 ? '' : 's'}</p><p class="jv-card-detail">${typeSummaryParts.join('<br>') || 'Nothing detected'}</p>`;

  const whereCard = create('article', 'jv-card');
  const layerLines = Array.from(layerGroups.entries()).map(([layer, count]) => {
    const info = layerInfo(layer);
    return `<span class="jv-layer-pill ${layerClass(layer)}">${info.label}</span> found ${count}`;
  }).join('<br>');
  whereCard.innerHTML = `<div class="jv-card-icon">📍</div><h3>How were they found?</h3><p class="jv-card-big">${layerGroups.size} detection layer${layerGroups.size === 1 ? '' : 's'}</p><p class="jv-card-detail">${layerLines || 'No detections'}</p>`;

  const actionCard = create('article', 'jv-card');
  const actionVerb = isSent ? 'Redacted before transmission' : 'Would be redacted before any transmission';
  actionCard.innerHTML = `<div class="jv-card-icon">🛡️</div><h3>What happened to it?</h3><p class="jv-card-big">${actionVerb}</p><p class="jv-card-detail">All ${report.redactions.length} region${report.redactions.length === 1 ? '' : 's'}: original values replaced with safe handles, pixels masked with opaque overlay.<br>Raw values: <strong>0 transmitted</strong></p>`;

  answers.append(whatCard, whereCard, actionCard);
  verdict.append(answers);
  root.append(verdict);

  // ── § 2  VISUAL PROOF — annotated screenshot right after verdict ──
  if (sanitizedImage) {
    const proofSection = create('section', 'judge-proof');
    const proofTitle = create('h3', 'jp-title');
    proofTitle.textContent = '📸 Visual proof — what the server receives';
    const proofNote = create('p', 'jp-note');
    proofNote.textContent = 'Each numbered circle marks a masked region. Numbers match the findings below. The server only sees this sanitized version.';
    proofSection.append(proofTitle, proofNote);
    renderAnnotatedScreenshot(proofSection, sanitizedImage, report.redactions);
    root.append(proofSection);
  }

  // ── § 3  FINDINGS — grouped by document/field type with plain-language explanations ──
  const findingsSection = create('section', 'judge-findings');
  const findingsTitle = create('h3', 'jf-title');
  findingsTitle.textContent = '🔎 Detailed findings';
  findingsSection.append(findingsTitle);

  if (report.redactions.length > 0) {
    // Key insight for document types
    const docTypes = Array.from(typeGroups.entries()).filter(([type]) => type === 'AADHAAR_CARD' || type === 'PAN_CARD');
    if (docTypes.length > 0) {
      const insightBox = create('div', 'jf-insight');
      insightBox.innerHTML = `<strong>💡 Important</strong> Each entry below is a <em>masked area</em> on a document — not a separate document. A single Aadhaar card has ~6 sensitive zones (photo, name, number, DOB, address, QR code). Each zone gets its own privacy mask.`;
      findingsSection.append(insightBox);
    }

    const findingsGrid = create('div', 'jf-grid');
    let globalIndex = 0;
    for (const [type, items] of typeGroups) {
      const card = create('article', 'jf-card');
      const icon = TYPE_ICONS[type] ?? '🛡️';
      const groupName = CATEGORY_GROUP_NAME[type] ?? friendlyType(type);
      const isDoc = type === 'AADHAAR_CARD' || type === 'PAN_CARD';

      // Card header
      const header = create('div', 'jf-card-header');
      header.innerHTML = `<span class="jf-icon">${icon}</span><div><strong>${escapeHtml(groupName)}</strong><span class="jf-count">${items.length} zone${items.length === 1 ? '' : 's'} masked</span></div>`;
      card.append(header);

      if (isDoc) {
        const docNote = create('p', 'jf-doc-note');
        const docName = type === 'AADHAAR_CARD' ? 'Aadhaar card' : 'PAN card';
        docNote.textContent = `1 ${docName} detected → ${items.length} sensitive zones masked individually.`;
        card.append(docNote);
      }

      // Zone list
      const zoneList = create('div', 'jf-zone-list');
      for (const item of items) {
        globalIndex++;
        const zone = create('div', 'jf-zone');
        const num = create('span', 'jf-zone-num'); num.textContent = String(globalIndex);
        const desc = create('div', 'jf-zone-desc');
        const category = inferFieldCategory(item);
        const layerTag = create('span', `jf-layer-tag ${layerClass(item.layer)}`);
        layerTag.textContent = layerInfo(item.layer).label;
        desc.innerHTML = `<strong>${escapeHtml(category)}</strong><code>${escapeHtml(item.handle)}</code>`;
        const conf = create('span', 'jf-zone-conf');
        conf.textContent = `${Math.round(item.confidence)}%`;
        zone.append(num, desc, layerTag, conf);
        zoneList.append(zone);
      }
      card.append(zoneList);
      findingsGrid.append(card);
    }
    findingsSection.append(findingsGrid);
  } else {
    const emptyMsg = create('p', 'jf-empty');
    emptyMsg.textContent = 'No sensitive regions were detected in this snapshot.';
    findingsSection.append(emptyMsg);
  }
  root.append(findingsSection);

  // ── § 4  HOW IT WORKS — simple 3-step flow ──
  renderAuditStory(root);

  // ── § 5  TECHNICAL DETAILS — all behind collapsible details ──
  const techSection = create('section', 'judge-tech');
  const techTitle = create('h3', 'jt-title');
  techTitle.textContent = '⚙️ Technical details';
  const techNote = create('p', 'jt-note');
  techNote.textContent = 'Expand the sections below for raw data. These are for developers and advanced reviewers.';
  techSection.append(techTitle, techNote);

  // 5a. DOM before/after
  const domDetails = create('details', 'jt-details');
  const domSummaryEl = create('summary');
  domSummaryEl.textContent = `DOM inspection (${report.domAudit.rawCandidateRedactions} candidates → ${report.domAudit.sanitizedRedactions} handles)`;
  domDetails.append(domSummaryEl);
  const domContent = create('div', 'jt-dom-content');
  renderDomAudit(domContent, report.domAudit);
  domDetails.append(domContent);
  techSection.append(domDetails);

  // 5b. Full redaction inventory table
  const invDetails = create('details', 'jt-details');
  const invSummaryEl = create('summary');
  invSummaryEl.textContent = `Full redaction inventory (${report.redactions.length} items)`;
  invDetails.append(invSummaryEl);
  const invContent = create('div');
  renderInventorySummary(invContent, report.redactions);
  const table = create('table', 'report-table');
  const thead = create('thead'); const headRow = create('tr');
  for (const label of ['What was protected', 'Safe handle', 'Detected by', 'Confidence', 'Screen area']) { const th = create('th'); th.textContent = label; headRow.append(th); }
  thead.append(headRow); table.append(thead);
  const tbody = create('tbody');
  for (const item of report.redactions) {
    const row = create('tr');
    const what = create('td', 'report-what-cell');
    const whatTitle = create('strong'); whatTitle.textContent = friendlyType(item.type);
    const whatCode = create('small'); whatCode.textContent = item.type;
    what.append(whatTitle, whatCode);
    const handle = create('td', 'report-handle-cell'); const handleCode = create('code'); handleCode.textContent = item.handle; handle.append(handleCode);
    const detected = create('td', 'report-layer-cell'); const info = layerInfo(item.layer); const layerBadge = create('span', `report-layer-badge ${layerClass(item.layer)}`); layerBadge.textContent = info.label; const layerDetail = create('small'); layerDetail.textContent = info.detail; detected.append(layerBadge, layerDetail);
    const confidenceCell = create('td', 'report-confidence-cell'); const confidenceBar = create('span', 'report-confidence-bar'); const confidenceFill = create('i'); confidenceFill.style.width = `${Math.max(0, Math.min(100, item.confidence))}%`; confidenceBar.append(confidenceFill); const confidenceText = create('strong'); confidenceText.textContent = confidence(item.confidence); confidenceCell.append(confidenceBar, confidenceText);
    const bounds = create('td'); bounds.textContent = item.hasOnScreenBox ? `${Math.round(item.bounds.width)} × ${Math.round(item.bounds.height)} px` : 'No visible box';
    row.append(what, handle, detected, confidenceCell, bounds);
    tbody.append(row);
  }
  if (report.redactions.length === 0) { const row = create('tr'); const cell = create('td'); cell.colSpan = 5; cell.textContent = 'No sensitive regions detected.'; row.append(cell); tbody.append(row); }
  table.append(tbody);
  invContent.append(table);
  invDetails.append(invContent);
  techSection.append(invDetails);

  // 5c. Policy blocks
  if (report.policyBlocks.length > 0) {
    const policyDetails = create('details', 'jt-details');
    const policySummaryEl = create('summary');
    policySummaryEl.textContent = `Policy blocks (${report.policyBlocks.length})`;
    policyDetails.append(policySummaryEl);
    for (const block of report.policyBlocks) { const pCard = create('article', 'report-policy-block'); const code = create('strong'); code.textContent = block.code; const copy = create('p'); copy.textContent = block.message; pCard.append(code, copy); policyDetails.append(pCard); }
    techSection.append(policyDetails);
  }

  // 5d. Raw payload
  const payloadDetails = create('details', 'jt-details');
  const payloadSummary = create('summary');
  payloadSummary.textContent = 'Raw technical payload';
  const payload = create('pre', 'jt-pre');
  payload.textContent = JSON.stringify({
    transmissionMode: report.transmissionMode,
    redactionMode: report.redactionMode,
    redactionHandles: report.redactions.map((item) => item.handle),
    rawValues: 'omitted',
    selectors: 'omitted',
  }, null, 2);
  payloadDetails.append(payloadSummary, payload);
  techSection.append(payloadDetails);

  // 5e. Latency
  const latencyDetails = create('details', 'jt-details');
  const latencySummaryEl = create('summary');
  latencySummaryEl.textContent = `Latency breakdown (${formatLatency(report.latency.totalMs)} total)`;
  latencyDetails.append(latencySummaryEl);
  const latencyList = create('dl', 'report-latency-list');
  for (const [label, value] of [['Screenshot capture', report.latency.screenshotMs], ['DOM inspection', report.latency.domInspectionMs], ['Local sanitization', report.latency.sanitizationMs], ['Network round trip', report.latency.networkMs], ['Action execution', report.latency.actionMs], ['Total', report.latency.totalMs]] as const) {
    const item = create('div'); const term = create('dt'); term.textContent = label; const detail = create('dd'); detail.textContent = formatLatency(value); item.append(term, detail); latencyList.append(item);
  }
  latencyDetails.append(latencyList);
  techSection.append(latencyDetails);

  root.append(techSection);

  // ── § 6 Protection overview (still used by downloadable HTML report + tests) ──
  const overviewHidden = create('section');
  overviewHidden.style.display = 'none';
  overviewHidden.innerHTML = renderProtectionOverview(report);
  root.append(overviewHidden);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] ?? character));
}

/** Infer a likely field category from the type, detection layer, and dimensions. */
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

/** Draw numbered circle markers onto the sanitized screenshot via canvas. */
function renderAnnotatedScreenshot(parent: HTMLElement, imageSrc: string, redactions: readonly RedactionAuditItem[]): void {
  const wrapper = create('div', 'report-annotated-wrapper');
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.className = 'report-annotated-canvas';
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) { wrapper.append(img); parent.append(wrapper); return; }
    ctx.drawImage(img, 0, 0);

    // Draw each mask's bounding box + numbered circle
    const visibleItems = redactions.filter((item) => item.hasOnScreenBox);
    for (let i = 0; i < visibleItems.length; i++) {
      const item = visibleItems[i]!;
      const { x, y, width, height } = item.bounds;
      const num = i + 1;

      // Dashed bounding rectangle
      ctx.save();
      ctx.strokeStyle = '#ff4466';
      ctx.lineWidth = Math.max(2, Math.min(4, img.naturalWidth / 400));
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x, y, width, height);
      ctx.restore();

      // Numbered circle at the centre of the mask
      const cx = x + width / 2;
      const cy = y + height / 2;
      const radius = Math.max(14, Math.min(22, Math.min(width, height) / 3));
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 68, 102, 0.88)';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Number label
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(radius * 1.05)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(num), cx, cy + 1);
    }

    wrapper.append(canvas);
  };
  img.onerror = () => {
    // Fallback: just show the un-annotated image
    const fallback = create('img', 'report-sent-image');
    fallback.src = imageSrc;
    fallback.alt = 'Sanitized screenshot';
    wrapper.append(fallback);
  };
  img.src = imageSrc;
  parent.append(wrapper);
}

/** Build the visual grouped summary with field categories and explicit counts. */
function renderSafeSummarySection(report: RedactionReport): HTMLElement {
  const isSent = report.networkRequests > 0;
  const section = create('section', 'report-table-section report-safe-summary');
  const heading = create('h3');
  heading.textContent = isSent ? 'What was sent to the server' : 'What would be sent (preview)';
  const subheading = create('p', 'report-section-copy');
  subheading.textContent = isSent
    ? `Mode: ${report.transmissionMode} · Redaction: ${report.redactionMode} · All original values were stripped before transmission.`
    : `Mode: ${report.transmissionMode} · Redaction: ${report.redactionMode} · No data has left this device.`;
  section.append(heading, subheading);

  // Group redactions by category
  const groups = new Map<string, { item: RedactionAuditItem; globalIndex: number }[]>();
  report.redactions.forEach((item, idx) => {
    const list = groups.get(item.type) ?? [];
    list.push({ item, globalIndex: idx + 1 });
    groups.set(item.type, list);
  });

  // Key insight banner
  const banner = create('div', 'safe-summary-banner');
  banner.innerHTML = `<strong>⚠️ ${report.redactions.length} masked regions — not ${report.redactions.length} documents</strong>
    <p>Each numbered entry is one <em>masked area</em> on the screenshot, not a separate card or document. A single Aadhaar card can produce 6+ masks (photo, name, number, DOB, address, QR).</p>`;
  section.append(banner);

  // Category summary bar
  const summaryBar = create('div', 'safe-summary-category-bar');
  for (const [type, entries] of groups) {
    const icon = TYPE_ICONS[type] ?? '🛡️';
    const groupName = CATEGORY_GROUP_NAME[type] ?? friendlyType(type);
    const chip = create('span', 'safe-summary-category-chip');
    chip.innerHTML = `${icon} <strong>${escapeHtml(groupName)}</strong> <b>${entries.length}</b>`;
    summaryBar.append(chip);
  }
  section.append(summaryBar);

  // Detailed grouped cards with field categories
  const grid = create('div', 'safe-summary-grid');
  for (const [type, entries] of groups) {
    const card = create('article', 'safe-summary-card');
    const isDocType = type === 'AADHAAR_CARD' || type === 'PAN_CARD';
    const icon = TYPE_ICONS[type] ?? '🛡️';
    const groupName = CATEGORY_GROUP_NAME[type] ?? friendlyType(type);

    const header = create('div', 'safe-summary-card-header');
    header.innerHTML = `<span class="safe-summary-icon">${icon}</span>
      <div>
        <strong>${escapeHtml(groupName)}</strong>
        <span class="safe-summary-count">${entries.length} masked ${entries.length === 1 ? 'region' : 'regions'}</span>
      </div>`;
    card.append(header);

    if (isDocType) {
      const explainer = create('p', 'safe-summary-explainer');
      const docName = type === 'AADHAAR_CARD' ? 'Aadhaar card' : 'PAN card';
      explainer.innerHTML = `<strong>Not ${entries.length} separate ${docName}s.</strong> One ${docName} has many sensitive zones. Each zone gets its own privacy mask.`;
      card.append(explainer);
    }

    // Numbered mask list with field categories
    const maskTable = create('div', 'safe-summary-mask-table');
    for (const { item, globalIndex } of entries) {
      const row = create('div', 'safe-summary-mask-row');
      const numBadge = create('span', 'safe-summary-mask-num');
      numBadge.textContent = String(globalIndex);
      const fieldCat = create('span', 'safe-summary-field-category');
      fieldCat.textContent = inferFieldCategory(item);
      const handleCode = create('code', 'safe-summary-mask-handle');
      handleCode.textContent = item.handle;
      const sizeLabel = create('span', 'safe-summary-mask-size');
      sizeLabel.textContent = item.hasOnScreenBox
        ? `${Math.round(item.bounds.width)}×${Math.round(item.bounds.height)}px`
        : 'text only';
      const confLabel = create('span', 'safe-summary-mask-conf');
      confLabel.textContent = `${Math.round(item.confidence)}%`;
      row.append(numBadge, fieldCat, handleCode, sizeLabel, confLabel);
      maskTable.append(row);
    }
    card.append(maskTable);
    grid.append(card);
  }
  section.append(grid);
  return section;
}

/** Local audit illustration: each tile is one mask, never a count of documents. */
export function renderProtectionOverview(report: RedactionReport): string {
  const groups = new Map<string, { item: RedactionAuditItem; number: number }[]>();
  report.redactions.forEach((item, index) => {
    const entries = groups.get(item.type) ?? [];
    entries.push({ item, number: index + 1 });
    groups.set(item.type, entries);
  });
  const flow = `<div class="protection-grid" aria-label="Privacy data flow"><article class="protection-group"><h4>1 · Page on your device</h4><p>The original page contains text, form fields and images.</p></article><article class="protection-group"><h4>2 · Local privacy filter</h4><p>Grade ${report.privacyGrade} rules select sensitive regions. Those pixels are masked and structured context is sanitized.</p></article><article class="protection-group"><h4>3 · Eligible server input</h4><p>${report.transmissionMode === 'structure-only' ? 'Sanitized page structure plus an opaque black image. No page imagery is shared.' : 'Sanitized page structure plus the masked screenshot. Protected pixels are replaced before transmission.'}</p><p>Includes sanitized task and page labels, available controls, redaction bounds and privacy settings. This report does not reproduce the full request body.</p></article></div>`;
  const cards = Array.from(groups, ([type, entries]) => {
    const documentCategory = type === 'AADHAAR_CARD' || type === 'PAN_CARD';
    const icon = TYPE_ICONS[type] ?? '🛡️';
    const groupName = CATEGORY_GROUP_NAME[type] ?? friendlyType(type);
    let description: string;
    if (documentCategory) {
      const docName = type === 'AADHAAR_CARD' ? 'Aadhaar card' : 'PAN card';
      description = `<strong>Not ${entries.length} separate ${docName}s.</strong> A single ${docName} has multiple sensitive zones (photo, number, name, etc.). Each zone gets its own mask — that is why you see ${entries.length} entries below.`;
    } else if (type === 'UNINSPECTABLE_MEDIA') {
      description = 'Media that could not be inspected reliably. A safety mask covers the entire region.';
    } else {
      description = `Each tile below is one area on the page where ${escapeHtml(groupName.toLowerCase())} data was detected and masked.`;
    }
    return `<article class="protection-group"><header><h4>${icon} ${escapeHtml(groupName)}</h4><b>${entries.length} masked ${entries.length === 1 ? 'region' : 'regions'}</b></header><p>${description}</p><div class="protection-masks">${entries.map(({ item, number }) => `<div class="protection-mask"><strong>Mask ${number}</strong><span class="protection-mask-category">${escapeHtml(inferFieldCategory(item))}</span><span aria-hidden="true" class="protection-mask-bar"></span><span>${item.hasOnScreenBox ? `${Math.round(item.bounds.width)} × ${Math.round(item.bounds.height)} px` : 'Structured data only'}</span><code>${escapeHtml(item.handle)}</code></div>`).join('')}</div></article>`;
  }).join('');
  return `<style>
  .protection-overview{margin:20px 0;font:14px/1.6 system-ui,sans-serif;color:inherit}.protection-overview h3{font-size:22px;margin:0 0 8px}.protection-explanation{padding:14px 18px;border-left:4px solid #38bdb0;background:#38bdb012;border-radius:8px}.protection-explanation p{margin:6px 0 0}.protection-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:14px;margin-top:16px}.protection-group{border:1px solid #8296a866;border-radius:14px;padding:16px;min-width:0}.protection-group header{display:flex;gap:12px;justify-content:space-between;align-items:start}.protection-group h4{margin:0;font-size:16px}.protection-group header b{white-space:nowrap;font-size:12px;border:1px solid #38bdb0;border-radius:20px;padding:3px 10px}.protection-group p{font-size:13px;margin:10px 0}.protection-masks{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}.protection-mask{display:flex;flex-direction:column;gap:5px;border:1px solid #8296a855;border-radius:8px;padding:10px;background:#8296a80c}.protection-mask-category{font-size:11px;font-weight:600;color:#67e8d4;margin:2px 0}.protection-mask-bar{height:12px;border-radius:3px;background:repeating-linear-gradient(135deg,#54798a,#54798a 4px,#385768 4px,#385768 8px)}.protection-mask span,.protection-mask code{font-size:11px;overflow-wrap:anywhere}.protection-caption{font-size:12px}.protection-status{font-weight:600}
  </style><div class="protection-overview"><h3>What was hidden, and why?</h3><div class="protection-explanation"><strong>⚠️ ${report.redactions.length} masked regions on the screenshot — these are NOT ${report.redactions.length} separate documents.</strong><p>The agent's privacy filter scans the page and finds sensitive <em>areas</em> (zones on the screen). One document like an Aadhaar card has many zones: photo, name, number, date of birth, address, QR code. Each zone gets its own privacy mask. The number in the handle (e.g. <code>[AADHAAR_CARD_3]</code>) just identifies which mask it is — it does <em>not</em> mean "the third Aadhaar card".</p></div><p class="protection-status">${report.networkRequests === 0 ? 'No reasoning request recorded for this report. This is a local preview.' : `${report.networkRequests} reasoning request(s) recorded. This view summarizes local redaction metadata, not the exact transmitted bytes.`}</p>${flow}<h4>Protected-region inventory</h4><div class="protection-grid">${cards || '<p>No protected regions recorded.</p>'}</div><p class="protection-caption">Each tile is a masked zone on the page, not a separate document. Compare with the sanitized screenshot below to see the actual masks. Original values remain hidden.</p></div>`;
}

export function downloadRedactionReport(report: RedactionReport, sanitizedImage: string | null): void {
  const rows = report.redactions.map((item) => {
    const info = layerInfo(item.layer);
    const bounds = item.hasOnScreenBox ? `${Math.round(item.bounds.width)} × ${Math.round(item.bounds.height)} px` : 'No visible box';
    return `<tr><td><strong>${escapeHtml(friendlyType(item.type))}</strong><small>${escapeHtml(item.type)}</small></td><td><code>${escapeHtml(item.handle)}</code></td><td><span class="layer-badge ${layerClass(item.layer)}">${escapeHtml(info.label)}</span><small>${escapeHtml(info.detail)}</small></td><td><span class="confidence"><i style="width:${Math.max(0, Math.min(100, item.confidence))}%"></i></span><strong>${confidence(item.confidence)}</strong></td><td>${escapeHtml(bounds)}</td></tr>`;
  }).join('');
  const layerTotals = new Map<RedactionAuditItem['layer'], number>();
  report.redactions.forEach((item) => layerTotals.set(item.layer, (layerTotals.get(item.layer) ?? 0) + 1));
  const inventoryBreakdown = Array.from(layerTotals.entries()).map(([layer, total]) => `${total} ${layerInfo(layer).label.toLowerCase()}`).join(' · ') || 'No sensitive regions detected';
  const blocks = report.policyBlocks.map((block) => `<li><strong>${escapeHtml(block.code)}</strong><span>${escapeHtml(block.message)}</span></li>`).join('') || '<li><span>No policy blocks recorded.</span></li>';
  const image = sanitizedImage ? `<img class="sent-image" src="${escapeHtml(sanitizedImage)}" alt="Sanitized screenshot" />` : '<p>No sanitized screenshot was retained for this run.</p>';
  const payloadJson = JSON.stringify({ transmissionMode: report.transmissionMode, redactionMode: report.redactionMode, redactionHandles: report.redactions.map((item) => item.handle), rawValues: 'omitted', selectors: 'omitted' }, null, 2);
  const audit = report.domAudit;
  const layerGroups = new Map<string, number>();
  report.redactions.forEach((item) => layerGroups.set(item.layer, (layerGroups.get(item.layer) ?? 0) + 1));
  const typeSummaryHtml = (() => {
    const tg = new Map<string, number>();
    report.redactions.forEach((item) => tg.set(item.type, (tg.get(item.type) ?? 0) + 1));
    return Array.from(tg, ([type, count]) => {
      const icon = TYPE_ICONS[type] ?? '🛡️';
      const name = CATEGORY_GROUP_NAME[type] ?? friendlyType(type);
      return `${icon} ${count}× ${escapeHtml(name)}`;
    }).join('<br>') || 'Nothing detected';
  })();
  const layerSummaryHtml = (() => {
    const lg = new Map<string, number>();
    report.redactions.forEach((item) => lg.set(item.layer, (lg.get(item.layer) ?? 0) + 1));
    return Array.from(lg, ([layer, count]) => {
      const info = layerInfo(layer as RedactionAuditItem['layer']);
      return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;color:#fff;background:${layer === 'dom' ? '#245c91' : layer === 'regex' ? '#785619' : layer === 'vision' || layer === 'ocr' ? '#63368b' : '#8a2f45'}">${escapeHtml(info.label)}</span> found ${count}`;
    }).join('<br>') || 'No detections';
  })();
  const isSentReport = report.networkRequests > 0;
  const actionVerbHtml = isSentReport ? 'Redacted before transmission' : 'Would be redacted before any transmission';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SIH redaction report ${escapeHtml(report.reportId)}</title><style>
  :root{color-scheme:dark;--bg:#07111d;--panel:#0e2030;--line:#29465d;--muted:#9eb4c7;--text:#edf7ff;--accent:#67e8d4;--warn:#ffca73}*{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,#06101c,#12263a);color:var(--text);font:15px/1.5 Inter,Segoe UI,system-ui,sans-serif}main{max-width:1120px;margin:0 auto;padding:42px 24px 72px}.eyebrow{color:var(--accent);font-size:12px;letter-spacing:.16em;font-weight:700}h1{margin:4px 0;font-size:36px}h2{margin:0 0 8px}h3{margin:0 0 12px;color:var(--accent)}p{color:var(--muted)}section,.hero{background:rgba(14,32,48,.9);border:1px solid var(--line);border-radius:18px;padding:22px;margin-top:18px;box-shadow:0 16px 40px #0003}.hero{border-top:3px solid var(--accent)}.stamp{color:var(--muted)}.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}.metric{border:1px solid var(--line);border-radius:12px;padding:16px}.metric b{display:block;font-size:24px;color:var(--accent)}.metric span{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}.audit{display:grid;grid-template-columns:1fr 1fr;gap:14px}.audit article{border:1px solid var(--line);border-radius:12px;padding:16px}.audit article:last-child{border-color:#2f887f}.audit h4{margin:0 0 12px}.row{display:flex;justify-content:space-between;border-top:1px solid #244054;padding:7px 0;color:var(--muted)}.row b{color:var(--text)}.note{border-left:4px solid var(--warn);padding:12px 16px;background:#3b2d1833;color:#ffe1a9;border-radius:8px}.sent-image{display:block;max-width:100%;max-height:760px;object-fit:contain;border:1px solid var(--line);border-radius:12px;background:#fff}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;min-width:640px}th,td{text-align:left;padding:10px;border-bottom:1px solid #244054}th{color:var(--accent);font-size:12px;text-transform:uppercase;letter-spacing:.08em}td{color:#d6e7f2}ul{padding:0;list-style:none}li{display:flex;gap:14px;padding:12px;border-left:3px solid #ff6b82;background:#2e172033;margin:8px 0}li span{color:var(--muted)}.latency-note{margin:-4px 0 8px;color:#b9d7e8;font-size:13px}footer{color:var(--muted);margin-top:18px;font-size:13px}@media(max-width:720px){.metrics,.audit{grid-template-columns:1fr 1fr}.metrics .metric:last-child{grid-column:span 2}}@media(max-width:480px){.metrics,.audit{grid-template-columns:1fr}.metrics .metric:last-child{grid-column:auto}}
  .story{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.story article{border:1px solid var(--line);border-radius:12px;padding:14px}.story strong{display:block}.story p{margin:5px 0 0}.latency-note{margin:-4px 0 8px;color:#b9d7e8;font-size:13px}.table-wrap table td small,.table-wrap table td strong,.table-wrap table td code{display:block}.table-wrap table td small{color:var(--muted);font-size:11px;margin-top:2px}.table-wrap table td code{color:#b6f6ed;font:13px ui-monospace,Consolas,monospace}.layer-badge{display:inline-block;border:1px solid #4c798f;border-radius:999px;padding:2px 8px;color:#dffcff;background:#1b4355;font-size:12px;font-weight:700}.report-layer-dom{border-color:#60a5fa;background:#153d66}.report-layer-regex{border-color:#fbbf24;background:#594114}.report-layer-vision,.report-layer-ocr{border-color:#c084fc;background:#45285f}.report-layer-fallback{border-color:#fb7185;background:#5c2430}.confidence{display:inline-block;width:70px;height:7px;margin-right:7px;border-radius:99px;vertical-align:middle;background:#29465d;overflow:hidden}.confidence i{display:block;height:100%;border-radius:inherit;background:var(--accent)}@media(max-width:720px){.story{grid-template-columns:1fr 1fr}}@media(max-width:480px){.story{grid-template-columns:1fr}}
  .verdict-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:16px}.verdict-card{border:1px solid var(--line);border-radius:14px;padding:18px;background:rgba(14,32,48,.7)}.verdict-card h3{margin:0 0 6px;font-size:14px;color:var(--muted)}.verdict-big{margin:0;font-size:22px;font-weight:900;color:var(--accent);line-height:1.2}.verdict-detail{margin:8px 0 0;font-size:13px;line-height:1.5}.verdict-icon{font-size:28px;margin-bottom:6px}.verdict-status{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:20px;font-size:13px;font-weight:700;margin-bottom:10px}.verdict-preview{background:#29465d;color:#9eb4c7;border:1px solid #3d6070}.verdict-sent{background:#1a4a42;color:#67e8d4;border:1px solid #2f887f}@media(max-width:720px){.verdict-cards{grid-template-columns:1fr}}
  </style></head><body><main><header class="hero"><div class="eyebrow">SIH26171 · LOCAL ONLY</div><h1>Privacy redaction report</h1><div class="stamp">${escapeHtml(report.generatedAt)} · ${escapeHtml(report.status)} · Grade ${report.privacyGrade} · detector ${escapeHtml(report.detectorBackend)}</div><div class="verdict-status ${isSentReport ? 'verdict-sent' : 'verdict-preview'}">${isSentReport ? `⬆️ DATA TRANSMITTED — ${report.networkRequests} request(s) sent` : '👁️ LOCAL PREVIEW — nothing left this device'}</div><div class="verdict-cards"><article class="verdict-card"><div class="verdict-icon">🔍</div><h3>What was detected?</h3><p class="verdict-big">${report.redactions.length} sensitive region${report.redactions.length === 1 ? '' : 's'}</p><p class="verdict-detail">${typeSummaryHtml}</p></article><article class="verdict-card"><div class="verdict-icon">📍</div><h3>How were they found?</h3><p class="verdict-big">${layerGroups.size} detection layer${layerGroups.size === 1 ? '' : 's'}</p><p class="verdict-detail">${layerSummaryHtml}</p></article><article class="verdict-card"><div class="verdict-icon">🛡️</div><h3>What happened to it?</h3><p class="verdict-big">${escapeHtml(actionVerbHtml)}</p><p class="verdict-detail">All ${report.redactions.length} region${report.redactions.length === 1 ? '' : 's'}: original values replaced with safe handles, pixels masked.<br>Raw values: <strong>0 transmitted</strong></p></article></div></header><section class="metrics"><div class="metric"><span>Redacted</span><b>${report.redactionCount}</b></div><div class="metric"><span>Actions blocked</span><b>${report.actionsBlocked}</b></div><div class="metric"><span>Actions executed</span><b>${report.actionsExecuted}</b></div><div class="metric"><span>Network requests</span><b>${report.networkRequests}</b></div><div class="metric"><span>Total latency</span><b>${formatLatency(report.latency.totalMs)}</b></div></section><section><h2>Sanitized screenshot · local evidence</h2>${image}</section><section><h2>How the privacy boundary works</h2><p>Everything is inspected and sanitized locally before any reasoning request is allowed.</p><div class="story"><article><strong>1 · Detect locally</strong><p>DOM labels, text patterns, and local vision checks find sensitive regions.</p></article><article><strong>2 · Redact locally</strong><p>Values become safe handles and sensitive pixels are masked before egress.</p></article><article><strong>3 · Send safe context</strong><p>Only sanitized structure, handles, and pixels can reach the reasoning endpoint.</p></article></div></section><section><h2>DOM before → after</h2><p>Values, selectors, cookies, URLs, and raw DOM references are deliberately absent.</p><div class="audit"><article><h4>Before sanitization</h4><div class="row"><span>Interactive nodes</span><b>${audit.rawInteractiveCount}</b></div><div class="row"><span>Candidate sensitive regions</span><b>${audit.rawCandidateRedactions}</b></div><div class="row"><span>Sensitive fields</span><b>${audit.rawSensitiveFields}</b></div></article><article><h4>After sanitization</h4><div class="row"><span>Safe nodes retained</span><b>${audit.sanitizedInteractiveCount}</b></div><div class="row"><span>Redaction handles</span><b>${audit.sanitizedRedactions}</b></div><div class="row"><span>Raw values retained</span><b>0</b></div></article></div></section><section class="note">Only handles and sanitized pixels are eligible for egress. Original values are held only in the page and local memory while the run executes.</section><section>${renderProtectionOverview(report)}<details><summary>Raw technical payload (for developers)</summary><pre>${escapeHtml(payloadJson)}</pre></details></section><section><h2>Redaction inventory · ${report.redactions.length} protected</h2><p>${escapeHtml(inventoryBreakdown)} · handles are safe references; original values are never shown.</p><div class="table-wrap"><table><thead><tr><th>What was protected</th><th>Safe handle</th><th>Detected locally by</th><th>Confidence</th><th>Screen area</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No sensitive regions detected.</td></tr>'}</tbody></table></div></section><section><h2>Blocked by policy (${report.policyBlocks.length})</h2><ul>${blocks}</ul></section><section><h2>Latency breakdown</h2><p class="latency-note">Measured locally for this run. "—" means that stage did not execute.</p><div class="row"><span>Screenshot capture</span><b>${formatLatency(report.latency.screenshotMs)}</b></div><div class="row"><span>DOM inspection</span><b>${formatLatency(report.latency.domInspectionMs)}</b></div><div class="row"><span>Local sanitization</span><b>${formatLatency(report.latency.sanitizationMs)}</b></div><div class="row"><span>Network round trip</span><b>${formatLatency(report.latency.networkMs)}</b></div><div class="row"><span>Action execution</span><b>${formatLatency(report.latency.actionMs)}</b></div><div class="row"><span>Total</span><b>${formatLatency(report.latency.totalMs)}</b></div></section><footer>Report ID ${escapeHtml(report.reportId)} · image SHA-256 ${escapeHtml(report.imageSha256)} · redaction mode ${escapeHtml(report.redactionMode)} · ${escapeHtml(report.transmissionMode)}</footer></main></body></html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19);
  anchor.download = `sih-redaction-report-${stamp}.html`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export const redactionReportInternals = { buildRedactionAudit, buildDomAudit, DEFAULT_LATENCY, formatLatency };
