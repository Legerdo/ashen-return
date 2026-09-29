import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from '../src/presentation/input';
import { controlHints, keyLabel } from '../src/ui/keys';

describe('always-visible control strip', () => {
  it('names keys the way players read them', () => {
    expect(['KeyW', 'Digit4', 'ShiftLeft', 'Escape', 'Tab', 'ArrowUp', 'Numpad5', 'F3'].map(keyLabel)).toEqual(['W', '4', 'Shift', 'Esc', 'Tab', '↑', 'Num5', 'F3']);
  });

  it('raid strip lists movement and combat first, including the hold-R top-up, and ends with the menu key', () => {
    const hints = controlHints(DEFAULT_BINDINGS, { mode: 'raid', armed: true, aimToggle: false, training: false });
    const text = hints.map((h) => `${h.keys} ${h.label}`);
    expect(text.slice(0, 4)).toEqual(['WASD 이동', '좌클릭 사격', '우클릭 조준', 'R 장전 · 길게 낱탄']);
    for (const want of ['1/2/3 무기 교체', 'E 상호작용', 'Shift 달리기', 'Space 구르기', 'C 앉기', 'V 근접', 'G 투척', 'B 발사 모드', '4~7 퀵슬롯', 'Tab 가방', 'M 지도']) expect(text).toContain(want);
    expect(text.indexOf('Space 구르기'), 'dodge right after sprint').toBe(text.indexOf('Shift 달리기') + 1);
    expect(text[4], 'weapon switch right after the combat keys').toBe('1/2/3 무기 교체');
    expect(text[text.length - 1]).toBe('Esc 메뉴');
  });

  it('shelter strip drops weapon keys outside the range, and follows rebinding', () => {
    const base = controlHints(DEFAULT_BINDINGS, { mode: 'base', armed: false, aimToggle: false, training: true }).map((h) => `${h.keys} ${h.label}`);
    expect(base).toEqual(['WASD 이동', '1/2/3 무기 교체', 'E 상호작용', 'Shift 달리기', 'Space 구르기', 'C 앉기', 'Tab 창고·성장', 'M 지도', 'Esc 메뉴']);
    const range = controlHints(DEFAULT_BINDINGS, { mode: 'base', armed: true, aimToggle: true, training: true }).map((h) => `${h.keys} ${h.label}`);
    expect(range).toContain('우클릭 조준(토글)');
    expect(range).toContain('R 장전');
    const rebound = controlHints({ ...DEFAULT_BINDINGS, reload: ['KeyT'], up: ['ArrowUp'], left: ['ArrowLeft'], down: ['ArrowDown'], right: ['ArrowRight'] }, { mode: 'raid', armed: true, aimToggle: false, training: false });
    expect(rebound[0]).toEqual({ keys: '↑←↓→', label: '이동' });
    expect(rebound.find((h) => h.label.startsWith('장전'))!.keys).toBe('T');
  });
});
