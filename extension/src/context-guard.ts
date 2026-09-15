export type TabContext = Readonly<{
  id: number;
  windowId: number;
  origin: string;
}>;

/** A capture or action may continue only in the exact browser context pinned by the user. */
export function sameTabContext(expected: TabContext, actual: TabContext): boolean {
  return expected.id === actual.id &&
    expected.windowId === actual.windowId &&
    expected.origin === actual.origin;
}
