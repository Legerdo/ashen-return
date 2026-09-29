/** Human-readable key names for KeyboardEvent.code values (current bindings, so rebinding updates every hint). */
const NAMED: Record<string, string> = {
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  Space: 'Space',
  Tab: 'Tab',
  Escape: 'Esc',
  Enter: 'Enter',
  Backspace: 'Backspace',
  CapsLock: 'Caps',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
};

export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num${code.slice(6)}`;
  return NAMED[code] ?? code;
}

export function primaryKey(bindings: Record<string, string[]>, action: string): string {
  const c = bindings[action]?.[0];
  return c ? keyLabel(c) : '—';
}

export interface KeyHint {
  keys: string;
  label: string;
}

export interface HintContext {
  mode: 'base' | 'raid' | 'tutorial';
  /** A weapon is usable here (raid / tutorial, or the shooting range in the shelter). */
  armed: boolean;
  aimToggle: boolean;
  /** Training sims reload from an unlimited reserve, so the hold-R top-up hint is irrelevant there. */
  training: boolean;
}

/** The compact always-visible control strip, most important first (the strip clips the tail on narrow screens). */
export function controlHints(bindings: Record<string, string[]>, c: HintContext): KeyHint[] {
  const k = (a: string) => primaryKey(bindings, a);
  const move = [k('up'), k('left'), k('down'), k('right')].join('');
  const out: KeyHint[] = [{ keys: move, label: '이동' }];
  if (c.armed) {
    out.push({ keys: '좌클릭', label: '사격' }, { keys: '우클릭', label: c.aimToggle ? '조준(토글)' : '조준' }, { keys: k('reload'), label: c.training ? '장전' : '장전 · 길게 낱탄' });
  }
  out.push({ keys: `${k('weapon1')}/${k('weapon2')}/${k('weapon3')}`, label: '무기 교체' });
  out.push({ keys: k('interact'), label: '상호작용' }, { keys: k('sprint'), label: '달리기' }, { keys: k('dodge'), label: '구르기' }, { keys: k('crouch'), label: '앉기' });
  if (c.armed) out.push({ keys: k('melee'), label: '근접' }, { keys: k('throw'), label: '투척' }, { keys: k('fireMode'), label: '발사 모드' });
  if (c.mode !== 'base') out.push({ keys: `${k('quick1')}~${k('quick4')}`, label: '퀵슬롯' });
  out.push({ keys: k('inventory'), label: c.mode === 'base' ? '창고·성장' : '가방' }, { keys: k('map'), label: '지도' }, { keys: k('pause'), label: '메뉴' });
  return out;
}
