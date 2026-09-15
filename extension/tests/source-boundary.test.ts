import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('source-level network boundary', () => {
  it('keeps the explicit reasoning fetch in egress.ts only', async () => {
    const source = resolve(import.meta.dirname, '..', 'src');
    const files = (await readdir(source)).filter((name) => name.endsWith('.ts'));
    const fetchOwners: string[] = [];
    for (const name of files) {
      const content = await readFile(join(source, name), 'utf8');
      if (/\bfetch\s*\(/u.test(content)) fetchOwners.push(name);
    }
    expect(fetchOwners).toEqual(['egress.ts']);
  });

  it('does not declare a static all-pages content script', async () => {
    const buildScript = await readFile(resolve(import.meta.dirname, '..', 'scripts', 'build.mjs'), 'utf8');
    expect(buildScript).not.toContain('content_scripts');
    expect(buildScript).toContain("'activeTab'");
  });
});
