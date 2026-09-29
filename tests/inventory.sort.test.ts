import { describe, expect, it } from 'vitest';
import { createContent } from '../src/content/core';
import { runTx } from '../src/core/tx';
import { KIND_ORDER, validateStore } from '../src/inventory/store';
import { sortHomeContainer, toggleFavorite } from '../src/progression/actions';
import { grantItems, newProfile, STASH, type ProfileState } from '../src/progression/profile';

/**
 * A07 (f) — stash sort (INV-UI "sort"): only positions/rotation change, every item keeps its single owner and quantity,
 * the order is deterministic, favorite-locked items stay in their cell, and an impossible re-pack changes nothing.
 */

const content = createContent();
const NOW = 1_700_000_000_000;

function stocked(seed: string): ProfileState {
  const p = newProfile(content, 1, 'Sort', seed, NOW);
  const tx = `setup:${seed}`;
  for (const [def, qty] of [
    ['core.mat.scrap', 7],
    ['core.med.bandage', 3],
    ['core.weapon.sm9', 1],
    ['core.ammo.9.fmj', 90],
    ['core.armor.vest2', 1],
    ['core.mat.wire', 4],
    ['core.val.watch', 2],
    ['core.throw.frag', 2],
    ['core.weapon.ar556', 1],
    ['core.mat.cloth', 5],
  ] as [string, number][])
    grantItems(p, content, def, qty, tx);
  return p;
}

const snapshot = (p: ProfileState) =>
  Object.values(p.store.items)
    .map((i) => `${i.instanceId}|${i.definitionId}|${i.quantity}|${i.ownerContainerId}|${i.containedItems.join(',')}`)
    .sort();

describe('A07 (f) stash sort', () => {
  it('re-packs by kind → size → id, moving only grid positions; ownership, quantities and nesting are unchanged', () => {
    const p0 = stocked('sort-a');
    const r = runTx(p0, 'sort:1', (d) => sortHomeContainer(d, content, STASH));
    expect(r.outcome.ok && r.outcome.applied).toBe(true);
    const p1 = r.next;
    expect(validateStore(p1.store, content)).toEqual([]);
    expect(snapshot(p1)).toEqual(snapshot(p0));
    const ids = p1.store.containers[STASH]!.items;
    const kinds = ids.map((id) => KIND_ORDER.indexOf(content.item(p1.store.items[id]!.definitionId).kind));
    expect(kinds).toEqual([...kinds].sort((a, b) => a - b));
    // Row-major packing starting at the top-left cell.
    expect(p1.store.items[ids[0]!]!.gridPosition).toEqual({ x: 0, y: 0 });
    // Deterministic and idempotent: sorting again moves nothing.
    const again = runTx(p1, 'sort:2', (d) => sortHomeContainer(d, content, STASH));
    expect(again.outcome.ok && again.outcome.applied && again.outcome.value).toBe(0);
    const other = runTx(stocked('sort-a'), 'sort:1', (d) => sortHomeContainer(d, content, STASH)).next;
    const layout = (p: ProfileState) => p.store.containers[STASH]!.items.map((id) => `${p.store.items[id]!.definitionId}@${JSON.stringify(p.store.items[id]!.gridPosition)}r${p.store.items[id]!.rotation}`);
    expect(layout(other)).toEqual(layout(p1));
  });

  it('favorite-locked items keep their cell; the rest packs around them', () => {
    let p = stocked('sort-fav');
    const watch = p.store.containers[STASH]!.items.find((id) => p.store.items[id]!.definitionId === 'core.val.watch')!;
    p = runTx(p, 'fav', (d) => toggleFavorite(d, watch)).next;
    const cell = { ...p.store.items[watch]!.gridPosition! };
    const r = runTx(p, 'sort', (d) => sortHomeContainer(d, content, STASH));
    expect(r.outcome.ok).toBe(true);
    expect(r.next.store.items[watch]!.gridPosition).toEqual(cell);
    expect(validateStore(r.next.store, content)).toEqual([]);
  });

  it('when the packed layout cannot fit, the sort is refused and nothing moves', () => {
    const p = stocked('sort-full');
    // Shrink the grid under the existing layout (as a too-small container would be) so no fresh packing can fit.
    p.store.containers[STASH]!.h = 1;
    const before = JSON.stringify(p.store);
    const r = runTx(p, 'sort', (d) => sortHomeContainer(d, content, STASH));
    expect(r.outcome).toEqual({ ok: false, applied: false, reason: 'inv.err.no_space' });
    expect(r.next).toBe(p);
    expect(JSON.stringify(p.store)).toBe(before);
  });

  it('only home grids can be sorted', () => {
    const p = stocked('sort-access');
    expect(runTx(p, 'sort', (d) => sortHomeContainer(d, content, 'eq:player:primary1')).outcome).toEqual({ ok: false, applied: false, reason: 'inv.err.no_access' });
  });
});
