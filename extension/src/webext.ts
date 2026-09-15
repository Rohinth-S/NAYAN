type ExtensionApi = typeof chrome;

export const ext = ((globalThis as typeof globalThis & { browser?: ExtensionApi }).browser ??
  (globalThis as typeof globalThis & { chrome: ExtensionApi }).chrome) as ExtensionApi;

export function runtimeUrl(path: string): string {
  return ext.runtime.getURL(path);
}
