/**
 * DOM input layer. Produces per-tick intent; never touches game state directly.
 * Browser defaults are blocked only while the game frame has focus, and only for bound keys.
 * Held fire is released immediately on blur, pointer leave and visibility loss.
 */
export type Action =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'sprint'
  | 'dodge'
  | 'crouch'
  | 'reload'
  | 'fireMode'
  | 'interact'
  | 'inventory'
  | 'weapon1'
  | 'weapon2'
  | 'weapon3'
  | 'quick1'
  | 'quick2'
  | 'quick3'
  | 'quick4'
  | 'melee'
  | 'throw'
  | 'map'
  | 'pause'
  | 'debug';

export const ACTIONS: Action[] = ['up', 'down', 'left', 'right', 'sprint', 'dodge', 'crouch', 'reload', 'fireMode', 'interact', 'inventory', 'weapon1', 'weapon2', 'weapon3', 'quick1', 'quick2', 'quick3', 'quick4', 'melee', 'throw', 'map', 'pause'];

export const DEFAULT_BINDINGS: Record<Action, string[]> = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  dodge: ['Space'],
  crouch: ['KeyC'],
  reload: ['KeyR'],
  fireMode: ['KeyB'],
  interact: ['KeyE'],
  inventory: ['Tab'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  weapon3: ['Digit3'],
  quick1: ['Digit4'],
  quick2: ['Digit5'],
  quick3: ['Digit6'],
  quick4: ['Digit7'],
  melee: ['KeyV'],
  throw: ['KeyG'],
  map: ['KeyM'],
  pause: ['Escape'],
  debug: ['F3'],
};

/** Browser-reserved keys we never bind (Ctrl/Meta combos are always passed through). */
export const RESERVED_CODES = new Set(['F5', 'F11', 'F12', 'MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight']);

export function isBindable(code: string): boolean {
  return !RESERVED_CODES.has(code) && code.length > 0;
}

export class InputManager {
  bindings: Record<Action, string[]>;
  private held = new Set<string>();
  private presses = new Set<Action>();
  mouseLeft = false;
  mouseRight = false;
  private leftPressed = false;
  /** Left button still physically held after a forced release: ignored until it is let go. */
  private leftBlocked = false;
  cursorClient: { x: number; y: number } | null = null;
  /** When true (DOM panel open), game actions other than panel toggles are ignored. */
  uiCapture = false;
  /**
   * When true (title screen, or a dialog other than the inventory is open) the Tab key is left to DOM focus
   * navigation instead of toggling the inventory. Maintained by the UI every frame.
   */
  tabNavigates = false;
  aimToggleMode = false;
  private adsToggled = false;
  onToggle: ((a: Action) => void) | null = null;
  private readonly listeners: [EventTarget, string, EventListener, AddEventListenerOptions?][] = [];

  constructor(
    private readonly frame: HTMLElement,
    bindings?: Record<Action, string[]>,
  ) {
    this.bindings = bindings ? { ...DEFAULT_BINDINGS, ...bindings } : { ...DEFAULT_BINDINGS };
  }

  private on<K extends string>(t: EventTarget, type: K, fn: (e: Event) => void, opts?: AddEventListenerOptions): void {
    t.addEventListener(type, fn as EventListener, opts);
    this.listeners.push([t, type, fn as EventListener, opts]);
  }

  actionFor(code: string): Action | null {
    for (const a of Object.keys(this.bindings) as Action[]) if (this.bindings[a].includes(code)) return a;
    return null;
  }

  private frameFocused(): boolean {
    const ae = document.activeElement;
    return ae === this.frame || ae === document.body || ae === null;
  }

  attach(): void {
    this.on(window, 'keydown', (ev) => {
      const e = ev as KeyboardEvent;
      if (e.ctrlKey || e.metaKey || e.altKey) return; // never hijack browser shortcuts
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
      const a = this.actionFor(e.code);
      if (!a) return;
      // Keyboard focus navigation: on the title screen and inside dialogs Tab moves between controls; inside the
      // inventory (which Tab itself toggles) Shift+Tab navigates and plain Tab closes it (game convention).
      if (e.code === 'Tab' && (this.tabNavigates || (this.uiCapture && e.shiftKey))) return;
      const toggleKey = a === 'inventory' || a === 'map' || a === 'pause' || a === 'debug';
      const focused = this.frameFocused();
      if (!focused && !toggleKey) return;
      if (focused || toggleKey) e.preventDefault();
      if (e.repeat) return;
      if (toggleKey) {
        this.onToggle?.(a);
        return;
      }
      if (this.uiCapture) return;
      this.held.add(e.code);
      this.presses.add(a);
    });
    this.on(window, 'keyup', (ev) => {
      const e = ev as KeyboardEvent;
      this.held.delete(e.code);
    });
    this.on(window, 'blur', () => this.releaseAll());
    this.on(document, 'visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
    // Mouse buttons are tracked from the `buttons` bitmask: a second button pressed while another is held (fire while
    // aiming) arrives as a chorded pointermove, not as a pointerdown (Pointer Events spec).
    this.on(this.frame, 'pointermove', (ev) => {
      const e = ev as PointerEvent;
      this.cursorClient = { x: e.clientX, y: e.clientY };
      if (!this.uiCapture) this.applyButtons(e.buttons, false);
    });
    this.on(this.frame, 'pointerdown', (ev) => {
      const e = ev as PointerEvent;
      this.cursorClient = { x: e.clientX, y: e.clientY };
      if (document.activeElement !== this.frame) this.frame.focus({ preventScroll: true });
      if (this.uiCapture) return;
      this.applyButtons(e.buttons, false);
      e.preventDefault();
    });
    // Releases are honoured anywhere (the cursor may have left the game frame for a UI panel).
    this.on(window, 'pointermove', (ev) => this.applyButtons((ev as PointerEvent).buttons, true));
    this.on(window, 'pointerup', (ev) => this.applyButtons((ev as PointerEvent).buttons, true));
    this.on(this.frame, 'pointerleave', () => {
      this.leftBlocked = this.leftBlocked || this.mouseLeft;
      this.mouseLeft = false;
    });
    this.on(this.frame, 'contextmenu', (e) => e.preventDefault());
  }

  detach(): void {
    for (const [t, type, fn, opts] of this.listeners) t.removeEventListener(type, fn, opts);
    this.listeners.length = 0;
  }

  /** Apply a pointer `buttons` bitmask (1 = left, 2 = right). releaseOnly: only clear buttons that are no longer held. */
  private applyButtons(buttons: number, releaseOnly: boolean): void {
    const left = (buttons & 1) !== 0;
    const right = (buttons & 2) !== 0;
    if (!left) this.leftBlocked = false;
    if (releaseOnly) {
      if (!left) this.mouseLeft = false;
      if (!right) this.mouseRight = false;
      return;
    }
    // After a forced release (blur, pointer leave, panel) fire needs a fresh press, never a silent resume.
    const effLeft = left && !this.leftBlocked;
    if (effLeft && !this.mouseLeft) this.leftPressed = true;
    if (right && !this.mouseRight && this.aimToggleMode) this.adsToggled = !this.adsToggled;
    this.mouseLeft = effLeft;
    this.mouseRight = right;
  }

  releaseAll(): void {
    this.leftBlocked = this.leftBlocked || this.mouseLeft;
    this.held.clear();
    this.presses.clear();
    this.mouseLeft = false;
    this.mouseRight = false;
    this.leftPressed = false;
  }

  isHeld(a: Action): boolean {
    if (this.uiCapture) return false;
    for (const c of this.bindings[a]) if (this.held.has(c)) return true;
    return false;
  }

  consume(a: Action): boolean {
    if (!this.presses.has(a)) return false;
    this.presses.delete(a);
    return !this.uiCapture;
  }

  consumeFirePress(): boolean {
    const p = this.leftPressed;
    this.leftPressed = false;
    return p && !this.uiCapture;
  }

  fireHeld(): boolean {
    return this.mouseLeft && !this.uiCapture;
  }

  adsHeld(): boolean {
    if (this.uiCapture) return false;
    return this.aimToggleMode ? this.adsToggled : this.mouseRight;
  }

  clearEdges(): void {
    this.presses.clear();
    this.leftPressed = false;
  }
}
