/**
 * Deterministic counter-based id allocation. Counters are part of saved state so ids stay unique across reloads.
 */
export interface IdCounterState {
  prefix: string;
  next: number;
}

export function allocId(state: IdCounterState, kind: string): string {
  const n = state.next++;
  return `${state.prefix}-${kind}-${n.toString(36)}`;
}

export function newCounter(prefix: string, next = 1): IdCounterState {
  return { prefix, next };
}
