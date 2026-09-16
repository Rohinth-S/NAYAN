/**
 * Approach B: Step 0 Abort Gate — scroll-drift guard.
 *
 * A passive debounced scroll listener that invalidates the current SoM
 * (Set-of-Marks) registry when the viewport changes during a VLM network
 * call. This closes the mid-flight race condition between VLM target
 * resolution and click dispatch that Approach A left unaddressed.
 *
 * The guard is activated when a reasoning request begins and deactivated
 * when the response arrives. If a scroll event is detected during the
 * active window, the guard marks the registry as drifted, which causes
 * the orchestrator to discard the stale action and re-capture.
 */

import type { ScrollDriftState } from './types';

const DEFAULT_DEBOUNCE_MS = 350;

export class ScrollDriftGuard {
  private drifted = false;
  private lastDriftTimestamp: number | null = null;
  private debounceMs: number;
  private active = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollHandler: (() => void) | null = null;

  constructor(debounceMs = DEFAULT_DEBOUNCE_MS) {
    this.debounceMs = debounceMs;
  }

  /** Current state snapshot for status reporting. */
  get state(): ScrollDriftState {
    return {
      drifted: this.drifted,
      lastDriftTimestamp: this.lastDriftTimestamp,
      debounceMs: this.debounceMs,
    };
  }

  /** Whether the viewport has drifted since the guard was activated. */
  get hasDrifted(): boolean {
    return this.drifted;
  }

  /**
   * Activate the guard before a VLM network call begins.
   * Resets drift state and attaches a passive scroll listener.
   */
  activate(): void {
    this.drifted = false;
    this.lastDriftTimestamp = null;
    this.active = true;

    if (this.scrollHandler) return; // Already attached.

    this.scrollHandler = () => {
      if (!this.active) return;

      // Debounce: wait for scroll to settle before marking drift.
      // This avoids false positives from micro-scrolls or browser
      // auto-scroll during input focus.
      if (this.debounceTimer !== null) {
        clearTimeout(this.debounceTimer);
      }

      this.debounceTimer = setTimeout(() => {
        if (!this.active) return;
        this.drifted = true;
        this.lastDriftTimestamp = Date.now();
        this.debounceTimer = null;
      }, this.debounceMs);
    };

    // Passive listener: does not block scroll performance.
    // Capture phase: catches scroll events from nested elements.
    if (typeof window !== 'undefined') {
      window.addEventListener('scroll', this.scrollHandler, {
        capture: true,
        passive: true,
      });
    }
  }

  /**
   * Deactivate the guard after a VLM response arrives.
   * The drift state is preserved for the orchestrator to inspect.
   */
  deactivate(): void {
    this.active = false;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Fully reset the guard and remove listeners.
   * Call when the agent run ends or is cancelled.
   */
  dispose(): void {
    this.active = false;
    this.drifted = false;
    this.lastDriftTimestamp = null;

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.scrollHandler && typeof window !== 'undefined') {
      window.removeEventListener('scroll', this.scrollHandler, { capture: true });
      this.scrollHandler = null;
    }
  }
}
