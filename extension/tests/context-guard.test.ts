import { describe, expect, it } from 'vitest';
import { sameTabContext, type TabContext } from '../src/context-guard';

const pinned: TabContext = { id: 7, windowId: 3, origin: 'https://portal.example' };

describe('run context guard', () => {
  it('allows the exact tab, window, and origin pinned by the user', () => {
    expect(sameTabContext(pinned, { ...pinned })).toBe(true);
  });

  const contextChanges: { actual: TabContext; description: string }[] = [
    { actual: { ...pinned, id: 8 }, description: 'tab switch' },
    { actual: { ...pinned, windowId: 4 }, description: 'window switch' },
    { actual: { ...pinned, origin: 'https://attacker.example' }, description: 'cross-origin navigation' },
  ];

  it.each(contextChanges)('rejects a $description context change', ({ actual }) => {
    expect(sameTabContext(pinned, actual)).toBe(false);
  });
});
