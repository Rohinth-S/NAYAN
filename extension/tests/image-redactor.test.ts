import { describe, expect, it } from 'vitest';
import { imageRedactorInternals } from '../src/image-redactor';

describe('opaque mask geometry', () => {
  it('covers every receiver crop pixel for fractional bounds', () => {
    const source = { x: 10.75, y: 20.25, width: 4.5, height: 3.1 };
    const mask = imageRedactorInternals.integerMaskBounds(source, 100, 100);
    expect(mask).toEqual({ x: 10, y: 20, width: 6, height: 4 });
    expect(mask.x).toBeLessThanOrEqual(Math.floor(source.x));
    expect(mask.x + mask.width).toBeGreaterThanOrEqual(Math.ceil(source.x + source.width));
    expect(mask.y + mask.height).toBeGreaterThanOrEqual(Math.ceil(source.y + source.height));
  });

  it('clips expanded masks at image boundaries', () => {
    expect(imageRedactorInternals.integerMaskBounds({ x: 98.8, y: 99.2, width: 5, height: 5 }, 100, 100))
      .toEqual({ x: 98, y: 99, width: 2, height: 1 });
  });
});

describe('semantic placeholder labels', () => {
  it('uses category-only labels that never include source content', () => {
    expect(imageRedactorInternals.placeholderFor('password')).toBe('[REDACTED:PASSWORD]');
    expect(imageRedactorInternals.placeholderFor('face')).toBe('[REDACTED:FACE]');
    expect(imageRedactorInternals.placeholderFor('pii-text')).toBe('[REDACTED:PII]');
    expect(imageRedactorInternals.placeholderFor('uninspectable-media')).toBe('[REDACTED:MEDIA]');
  });
  it('blocks non-uniform screenshot scaling that would shift redaction boxes', () => {
    expect(imageRedactorInternals.uniformViewportScale(1.25, 1.25)).toBe(true);
    expect(imageRedactorInternals.uniformViewportScale(1, 0.84)).toBe(false);
    expect(imageRedactorInternals.uniformViewportScale(0, 1)).toBe(false);
  });
});
