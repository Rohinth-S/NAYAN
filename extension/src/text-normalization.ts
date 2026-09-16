/** Classification-only normalization. Callers mask the original whole region;
 * normalized offsets must never be applied to source text. */
export function normalizeForDetection(text: string): string {
  return text.normalize('NFKC')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, '')
    .replace(/[०-९٠-٩۰-۹]/gu, digit => {
      const code = digit.charCodeAt(0);
      return String(code - (code >= 0x966 ? 0x966 : code >= 0x6f0 ? 0x6f0 : 0x660));
    })
    .replace(/[‐‑‒–—−]/gu, '-')
    .replace(/\s*([@.])\s*/gu, '$1')
    .replace(/(?<=\d)\s+(?=\d)/gu, '');
}
