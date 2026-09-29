import { runTx, type TxOutcome } from '../core/tx';
import type { ProfileState } from '../progression/profile';
import type { SaveStore } from '../save/saveStore';
import type { SimState } from '../world/state';

/**
 * All profile mutations go through run(): duplicate check → copy-on-write draft → IndexedDB commit → swap.
 * If persisting fails (quota, crash) the in-memory profile is NOT advanced, so memory and disk never diverge.
 * Commits are serialized so two clicks cannot interleave.
 */
export class ProfileService {
  private queue: Promise<unknown> = Promise.resolve();
  onChange: (() => void) | null = null;
  lastError: string | null = null;

  constructor(
    private readonly store: SaveStore,
    public profile: ProfileState,
  ) {}

  get slotId(): number {
    return this.profile.slotId;
  }

  run<T>(txId: string, mutate: (draft: ProfileState) => T, opts: { raid?: SimState | null | ((value: T, draft: ProfileState) => SimState | null); pinRaid?: boolean } = {}): Promise<TxOutcome<T>> {
    const job = this.queue.then(async () => {
      const { outcome, next } = runTx(this.profile, txId, mutate);
      if (!outcome.ok || !outcome.applied) return outcome;
      const raid = typeof opts.raid === 'function' ? opts.raid(outcome.value, next) : opts.raid;
      try {
        await this.store.commit(next.slotId, next, raid, txId, opts.pinRaid ? { pinRaid: true } : {});
      } catch (e) {
        this.lastError = String(e);
        const quota = e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');
        return { ok: false, applied: false, reason: quota ? 'save.err.quota' : 'save.err.write' } as TxOutcome<T>;
      }
      this.profile = next;
      this.onChange?.();
      return outcome;
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** Non-transactional checkpoint (same data, new snapshot) — e.g. raid progress or settings. */
  checkpoint(raid: SimState | null | undefined): Promise<boolean> {
    const job = this.queue.then(async () => {
      try {
        await this.store.commit(this.profile.slotId, structuredClone(this.profile), raid, `checkpoint:${Date.now()}`);
        return true;
      } catch (e) {
        this.lastError = String(e);
        return false;
      }
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** Mutate transient counters that are not resource transfers (play time, craft timers, settings). */
  touch(fn: (p: ProfileState) => void): void {
    fn(this.profile);
  }
}
