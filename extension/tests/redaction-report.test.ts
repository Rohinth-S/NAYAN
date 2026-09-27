import { describe, expect, it } from 'vitest';
import { buildDomAudit, buildRedactionAudit, buildRedactionReport, formatLatency, renderProtectionOverview } from '../src/redaction-report';
import { SCHEMA_VERSION, type RawDomSnapshot, type SanitizedObservation } from '../src/types';

const raw: RawDomSnapshot = {
  documentId: 'doc-1', documentRevision: 2, origin: 'https://example.test', title: 'Demo',
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
  elements: [{ id: 'FIELD_1', role: 'textbox', label: 'Email', bounds: { x: 1, y: 2, width: 100, height: 20 }, state: { disabled: false, checked: false, editable: true, required: true } }],
  redactions: [{ kind: 'pii-text', source: 'dom', fieldLabel: 'EMAIL', bounds: { x: 1, y: 2, width: 100, height: 20 } }],
};

const observation: SanitizedObservation = {
  schemaVersion: SCHEMA_VERSION, snapshotId: 'snap-1', documentId: 'doc-1',
  page: { origin: 'origin-alias', title: '[REDACTED:EMAIL]' }, task: 'Submit',
  elements: [], image: { mime: 'image/png', dataBase64: 'AA==', width: 1, height: 1 },
  redactions: [{ kind: 'pii-text', source: 'dom', bounds: { x: 1, y: 2, width: 100, height: 20 } }],
  privacy: { grade: 3, detectorBackend: 'wasm', visualFallback: 'none', rawImageRetained: false, redactionMode: 'semantic' },
};

describe('local redaction audit report', () => {
  it('explains repeated document categories as masks and distinguishes preview from transmission', () => {
    const report = buildRedactionReport({ rawDom: raw, observation, maskedAreaPercentage: 12, imageSha256: 'test', transmissionMode: 'sanitized-visual' });
    const masks = buildRedactionAudit(Array.from({ length: 6 }, (_, index) => ({ kind: 'aadhaar-card' as const, source: 'ocr' as const, bounds: { x: 1, y: index * 20, width: 100, height: 18 } })));
    const html = renderProtectionOverview({ ...report, redactions: masks });
    expect(html).toContain('6 masked regions on the screenshot');
    expect(html).toContain('NOT 6 separate documents');
    expect(html.match(/class="protection-mask"/gu)).toHaveLength(6);
    expect(html).toContain('Not 6 separate Aadhaar cards');
    expect(html).toContain('No reasoning request recorded');
    expect(html).toContain('masked screenshot');
    const sent = renderProtectionOverview({ ...report, transmissionMode: 'structure-only', networkRequests: 1 });
    expect(sent).toContain('opaque black image');
    expect(sent).toContain('1 reasoning request(s) recorded');
    expect(sent).not.toContain('Exact bytes sent');
  });

  it('maps redactions to safe handles without original values', () => {
    const items = buildRedactionAudit(observation.redactions);
    expect(items[0]).toMatchObject({ handle: '[PII_TEXT_1]', type: 'PII_TEXT', layer: 'dom', confidence: 100, placeholder: '[REDACTED:PII_TEXT]' });
    expect(JSON.stringify(items)).not.toContain('EMAIL');
  });

  it('proves before and after counts while omitting selectors and values', () => {
    const audit = buildDomAudit(raw, observation);
    expect(audit).toMatchObject({ rawInteractiveCount: 1, rawCandidateRedactions: 1, sanitizedInteractiveCount: 0, sanitizedRedactions: 1, valuesOmitted: true, selectorsOmitted: true });
  });

  it('builds a local report with latency and policy counters', () => {
    const report = buildRedactionReport({ rawDom: raw, observation, maskedAreaPercentage: 12.5, imageSha256: 'sha256:test', transmissionMode: 'sanitized-visual', actionsExecuted: 2, actionsBlocked: 1, networkRequests: 1, latency: { totalMs: 123 } });
    expect(report).toMatchObject({ redactionCount: 1, maskedAreaPercentage: 12.5, actionsExecuted: 2, actionsBlocked: 1, networkRequests: 1, latency: { totalMs: 123 }, redactions: [{ type: 'EMAIL' }] });
    expect(JSON.stringify(report)).not.toContain('alice@example.test');
  });

  it('labels measured and unexecuted latency stages clearly', () => {
    expect(formatLatency(12.6)).toBe('13 ms');
    expect(formatLatency(0)).toBe('—');
    expect(formatLatency(Number.NaN)).toBe('—');
  });
});
