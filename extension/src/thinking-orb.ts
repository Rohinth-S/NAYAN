import {
  MODE_FRAMES,
  paintFrame,
  resolvePreset,
  STATE_TO_MODE,
  type ModeFrame,
  type OrbSize,
  type OrbState,
} from 'thinking-orbs/engine';

export type { OrbSize, OrbState };

export const ORB_STATES: readonly OrbState[] = [
  'working',
  'searching',
  'solving',
  'listening',
  'connecting',
  'weaving',
  'composing',
  'breathing',
  'shaping',
] as const;

export const ORB_LABELS: Record<OrbState, string> = {
  working: 'Working…',
  searching: 'Searching…',
  solving: 'Solving…',
  listening: 'Listening…',
  connecting: 'Connecting…',
  weaving: 'Weaving…',
  composing: 'Composing…',
  breathing: 'Standing by…',
  shaping: 'Sanitizing…',
};

export type ThinkingOrbOptions = {
  state?: OrbState | undefined;
  size?: number | undefined;
  theme?: ('auto' | 'dark' | 'light') | undefined;
  speed?: number | undefined;
  paused?: boolean | undefined;
  color?: string | undefined;
  ariaLabel?: string | undefined;
};

export interface ThinkingOrbInstance {
  readonly canvas: HTMLCanvasElement;
  getState(): OrbState;
  setState(nextState: OrbState): void;
  getSize(): number;
  setSize(nextSize: number): void;
  setPaused(paused: boolean): void;
  destroy(): void;
}

function parseTint(color?: string): { r: number; g: number; b: number } | undefined {
  if (!color) return undefined;
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex && hex[1]) {
    let h = hex[1];
    if (h.length === 3) h = h.replace(/./g, (c) => c + c);
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const fn = color.trim().match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (fn && fn[1] && fn[2] && fn[3]) {
    return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]) };
  }
  return undefined;
}

function resolveDarkTheme(theme: 'auto' | 'dark' | 'light', el: HTMLElement | null): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  let curr = el;
  while (curr) {
    const attr = curr.getAttribute('data-theme');
    if (attr === 'dark') return true;
    if (attr === 'light') return false;
    if (curr.classList.contains('dark')) return true;
    if (curr.classList.contains('light')) return false;
    curr = curr.parentElement;
  }
  return typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)').matches : true;
}

/**
 * Creates an animated Thinking Orb canvas using Jakub Antalik's thinking-orbs engine.
 * Supports auto light/dark, shared clock, reduced-motion, and intersection-based pausing.
 */
export function createThinkingOrb(options: ThinkingOrbOptions = {}): ThinkingOrbInstance {
  const canvas = document.createElement('canvas');
  canvas.classList.add('thinking-orb-canvas');
  canvas.setAttribute('role', 'img');

  let state: OrbState = options.state ?? 'working';
  let size: number = options.size ?? 64;
  let theme: 'auto' | 'dark' | 'light' = options.theme ?? 'auto';
  let speed: number = options.speed ?? 1;
  let paused: boolean = options.paused ?? false;
  let color: string | undefined = options.color;
  let ariaLabel: string | undefined = options.ariaLabel;

  canvas.setAttribute('aria-label', ariaLabel ?? ORB_LABELS[state]);

  let rafId = 0;
  let running = false;
  let isVisible = true;
  let isDestroyed = false;

  const ctx = canvas.getContext('2d');

  function updateAria(): void {
    canvas.setAttribute('aria-label', ariaLabel ?? ORB_LABELS[state]);
  }

  function resize(): void {
    const dpr = Math.min(2, typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
  }

  function renderFrame(timeSeconds: number): void {
    if (!ctx || isDestroyed) return;
    const dpr = Math.min(2, typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1);
    const dark = resolveDarkTheme(theme, canvas);
    const tint = parseTint(color);
    // The engine only has 20/32/64px presets; smaller UI indicators still
    // render at their requested size using the nearest supported density.
    const presetSize: OrbSize = size < 26 ? 20 : size < 48 ? 32 : 64;
    const { mode, speed: baseSpeed, opts } = resolvePreset(state, presetSize);
    const frameFn = MODE_FRAMES[mode] as ModeFrame;
    const effSpeed = baseSpeed * speed;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    paintFrame(ctx, frameFn(size, timeSeconds * effSpeed, opts), dark, tint);
  }

  function tick(): void {
    if (!running || paused || isDestroyed) return;
    renderFrame(performance.now() / 1000);
    rafId = requestAnimationFrame(tick);
  }

  function start(): void {
    if (running || paused || isDestroyed) return;
    running = true;
    rafId = requestAnimationFrame(tick);
  }

  function stop(): void {
    running = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  // Reduced motion check
  const prefersReduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  resize();

  if (prefersReduced) {
    renderFrame(0.6);
  } else {
    renderFrame(performance.now() / 1000);
    start();
  }

  // Visibility & Intersection observers for performance
  let io: IntersectionObserver | null = null;
  if (!prefersReduced && typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      isVisible = entry.isIntersecting;
      if (isVisible && document.visibilityState !== 'hidden') {
        start();
      } else {
        stop();
      }
    });
    io.observe(canvas);
  }

  const onVisChange = () => {
    if (document.visibilityState === 'hidden') {
      stop();
    } else if (isVisible && !paused && !prefersReduced) {
      start();
    }
  };
  document.addEventListener('visibilitychange', onVisChange);

  return {
    canvas,
    getState: () => state,
    setState: (nextState: OrbState) => {
      if (state === nextState) return;
      state = nextState;
      updateAria();
      if (prefersReduced) {
        renderFrame(0.6);
      }
    },
    getSize: () => size,
    setSize: (nextSize: number) => {
      if (size === nextSize) return;
      size = nextSize;
      resize();
      if (prefersReduced) {
        renderFrame(0.6);
      }
    },
    setPaused: (nextPaused: boolean) => {
      paused = nextPaused;
      if (paused) stop();
      else if (isVisible && !prefersReduced) start();
    },
    destroy: () => {
      isDestroyed = true;
      stop();
      io?.disconnect();
      document.removeEventListener('visibilitychange', onVisChange);
    },
  };
}

/**
 * Custom web component `<thinking-orb>`:
 * Attributes:
 * - state: 'working' | 'searching' | 'solving' | 'listening' | 'connecting' | 'weaving' | 'composing' | 'breathing' | 'shaping'
 * - size: number (default: 64, or 20 for inline)
 * - theme: 'auto' | 'dark' | 'light'
 * - speed: number
 * - color: string
 */
export class ThinkingOrbElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['state', 'size', 'theme', 'speed', 'color', 'paused'];
  }

  private orbInstance: ThinkingOrbInstance | null = null;

  connectedCallback(): void {
    if (this.orbInstance) return;
    const state = (this.getAttribute('state') as OrbState) || 'working';
    const size = parseInt(this.getAttribute('size') || '64', 10) || 64;
    const theme = (this.getAttribute('theme') as 'auto' | 'dark' | 'light') || 'auto';
    const speed = parseFloat(this.getAttribute('speed') || '1') || 1;
    const color = this.getAttribute('color') || undefined;
    const paused = this.hasAttribute('paused');

    this.orbInstance = createThinkingOrb({
      state,
      size,
      theme,
      speed,
      color,
      paused,
    });

    this.replaceChildren(this.orbInstance.canvas);
  }

  disconnectedCallback(): void {
    this.orbInstance?.destroy();
    this.orbInstance = null;
  }

  attributeChangedCallback(name: string, _oldVal: string | null, newVal: string | null): void {
    if (!this.orbInstance) return;
    if (name === 'state' && newVal) {
      this.orbInstance.setState(newVal as OrbState);
    } else if (name === 'size' && newVal) {
      this.orbInstance.setSize(parseInt(newVal, 10) || 64);
    } else if (name === 'paused') {
      this.orbInstance.setPaused(newVal !== null);
    }
  }

  get state(): OrbState {
    return this.orbInstance?.getState() ?? ((this.getAttribute('state') as OrbState) || 'working');
  }

  set state(value: OrbState) {
    this.setAttribute('state', value);
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('thinking-orb')) {
  customElements.define('thinking-orb', ThinkingOrbElement);
}

/**
 * Maps agent execution phase to an evocative Thinking Orb state.
 */
export function agentPhaseToOrbState(phase: string): OrbState {
  switch (phase) {
    case 'idle':
      return 'breathing';
    case 'capturing':
      return 'searching';
    case 'sanitizing':
      return 'shaping';
    case 'reasoning':
      return 'solving';
    case 'executing':
      return 'working';
    case 'done':
      return 'breathing';
    case 'blocked':
      return 'listening';
    case 'error':
      return 'shaping';
    default:
      return 'breathing';
  }
}
