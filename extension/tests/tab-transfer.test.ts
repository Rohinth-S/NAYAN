import { describe, expect, it } from 'vitest';
import { normalizedTransferLabel, transferLabelKey, transferLabelMatches } from '../src/tab-transfer';

describe('local tab transfer label policy', () => {
  it('normalizes labels without making values part of the key', () => {
    expect(normalizedTransferLabel('  Work  Email ')).toBe('work email');
    expect(transferLabelKey('Home address')).toBe('address');
  });

  it('matches safe aliases but does not confuse name with username', () => {
    expect(transferLabelMatches('Email address', 'Work email')).toBe(true);
    expect(transferLabelMatches('Phone', 'Mobile number')).toBe(true);
    expect(transferLabelMatches('Name', 'Username')).toBe(false);
    expect(transferLabelMatches('Address', 'City')).toBe(false);
  });
});
