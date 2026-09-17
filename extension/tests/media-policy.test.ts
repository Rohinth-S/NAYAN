import { describe, expect, it } from 'vitest';
import { mediaPolicyInternals } from '../src/media-policy';

function media(attributes: Record<string, string> = {}, explicit: string | null = null) {
  return {
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
    hasAttribute(name: string) {
      return name in attributes;
    },
    querySelectorAll() {
      return [] as Element[];
    },
    ...(explicit ? { dataset: { privacyMediaKind: explicit } } : {}),
  } as unknown as Element;
}

describe('local media policy', () => {
  it('preserves an explicitly classified public object', () => {
    expect(mediaPolicyInternals.classifyMediaElement(media({
      'data-privacy-media-kind': 'object',
      alt: 'Synthetic public product image with no personal information',
    }))).toBe('object');
  });

  it('preserves an explicitly classified animal fixture without treating it as a person', () => {
    expect(mediaPolicyInternals.classifyMediaElement(media({
      'data-privacy-media-kind': 'object',
      alt: 'Realistic synthetic cat photograph with no personal information',
    }))).toBe('object');
  });

  it('routes an Aadhaar-style fixture to document OCR', () => {
    const fixture = media({
      alt: 'Synthetic Aadhaar-style identity document',
    });
    expect(mediaPolicyInternals.classifyMediaElement(fixture)).toBe('document');
    expect(mediaPolicyInternals.classifyDocumentType(fixture)).toBe('aadhaar-card');
  });

  it('uses an explicit credit-card hint for local document classification', () => {
    expect(mediaPolicyInternals.classifyDocumentType(media({
      'data-privacy-media-kind': 'document',
      'data-privacy-document-type': 'credit-card',
    }))).toBe('credit-card');
  });

  it('routes a portrait to full-image biometric masking', () => {
    expect(mediaPolicyInternals.classifyMediaElement(media({
      alt: 'Synthetic person portrait for biometric masking',
    }))).toBe('person');
  });

  it('keeps ambiguous media fail-closed', () => {
    expect(mediaPolicyInternals.classifyMediaElement(media())).toBe('unknown');
  });

  it('does not infer that an unmarked product image is safe', () => {
    expect(mediaPolicyInternals.classifyMediaElement(media({
      alt: 'A public product illustration with no personal information',
    }))).toBe('unknown');
  });
});
