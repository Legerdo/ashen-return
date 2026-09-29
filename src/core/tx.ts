/**
 * Transaction ledger: a stable transaction id can only ever be committed once.
 * Stored as an array inside saved state; checked through a Set cache for speed.
 */
export interface TxLedgerState {
  committed: string[];
}

const MAX_LEDGER = 50_000;

const cache = new WeakMap<TxLedgerState, Set<string>>();

function setOf(ledger: TxLedgerState): Set<string> {
  let s = cache.get(ledger);
  if (!s || s.size !== ledger.committed.length) {
    s = new Set(ledger.committed);
    cache.set(ledger, s);
  }
  return s;
}

export function txCommitted(ledger: TxLedgerState, txId: string): boolean {
  return setOf(ledger).has(txId);
}

export function markTx(ledger: TxLedgerState, txId: string): void {
  const s = setOf(ledger);
  if (s.has(txId)) return;
  ledger.committed.push(txId);
  s.add(txId);
  if (ledger.committed.length > MAX_LEDGER) {
    const removed = ledger.committed.splice(0, ledger.committed.length - MAX_LEDGER);
    for (const r of removed) s.delete(r);
  }
}

export type TxOutcome<T> =
  | { ok: true; applied: true; value: T }
  | { ok: true; applied: false; reason: 'duplicate' }
  | { ok: false; applied: false; reason: string };

export class TxError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'TxError';
  }
}

/** Fail a transaction with a user-facing reason code (localization key). */
export function fail(code: string): never {
  throw new TxError(code);
}

/**
 * Copy-on-write transaction over a JSON-safe state object:
 *   duplicate check → clone → mutate draft → mark tx → return new state.
 * If mutate throws, the original state is untouched (nothing partially applied).
 */
export function runTx<S extends { ledger: TxLedgerState }, T>(
  state: S,
  txId: string,
  mutate: (draft: S) => T,
): { outcome: TxOutcome<T>; next: S } {
  if (txCommitted(state.ledger, txId)) {
    return { outcome: { ok: true, applied: false, reason: 'duplicate' }, next: state };
  }
  const draft = structuredClone(state);
  try {
    const value = mutate(draft);
    markTx(draft.ledger, txId);
    return { outcome: { ok: true, applied: true, value }, next: draft };
  } catch (e) {
    if (e instanceof TxError) return { outcome: { ok: false, applied: false, reason: e.code }, next: state };
    throw e;
  }
}
