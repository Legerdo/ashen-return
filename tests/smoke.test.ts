import { describe, expect, it } from 'vitest';

describe('toolchain smoke', () => {
  it('runs vitest in strict TS', () => {
    const v: number = 1 + 1;
    expect(v).toBe(2);
  });
});
