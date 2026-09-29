/**
 * A17 — "상점/제작/수리/분해 무한 이익 경로 0" (no infinite-profit path via shop / crafting / repair / dismantle)
 *
 * Rules under test: buy = base × (1.1 − 0.2 × trust/1000) (ammo per round), sell = 0.35 × base × condition × (1 + 0.1 × trust/1000).
 * Everything is exercised through the real transaction bodies (runTx + buyFromTrader / buyFromMarket / sellItems /
 * startCraft → tickCrafting → completeCraft / dismantleItem / repairItem / claimRelief) at trust 0 and 1000.
 */
import { describe, expect, it } from 'vitest';
import { createContent } from '../src/content/core';
import { runTx, type TxOutcome } from '../src/core/tx';
import { completeCraft, dismantleItem, repairAmount, repairItem, startCraft, tickCrafting } from '../src/economy/crafting';
import {
  buyFromMarket,
  buyFromTrader,
  conditionFactor,
  ensureTraderStock,
  generateMarketOffers,
  RELIEF_MODIFIER,
  SELL_RATIO,
  sellItems,
  sellValue,
  stockLines,
  TRUST_PRICE_SWING,
  TRUST_TIERS,
  unitBuyPrice,
} from '../src/economy/trade';
import { countDef, destroyItem, instantiate, validateStore } from '../src/inventory/store';
import { claimRelief, fillMagazine, unequipProfileItem, unloadMagazine, unloadWeapon } from '../src/progression/actions';
import { aggregatePerks, grantItems, homeContainers, newProfile, STASH, type ProfileState } from '../src/progression/profile';

const content = createContent();
const NOW = 1_700_000_000_000;
const TRUSTS = [0, 1000] as const;
const MECH = 'core.trader.mechanic';
const KIT = 'core.tool.repair_kit';
const GUNSMITH = 'core.perk.combat.gunsmith';
const MARKET_GENERATIONS = 200;

/** Every flag that gates a trader line, the black market or a recipe. */
const UNLOCK_FLAGS = [
  ...new Set([
    ...[...content.traders.values()].flatMap((t) => t.stock.map((s) => s.requiresFlag).filter((f): f is string => !!f)),
    ...[...content.markets.values()].map((m) => m.unlockFlag),
    ...[...content.recipes.values()].map((r) => r.requiresFlag).filter((f): f is string => !!f),
  ]),
];
const BUILDINGS = [...new Set([...content.recipes.values()].map((r) => r.requiresBuilding).filter((b): b is string => !!b))];

/** Rich profile at a uniform trust level with every gate open, all craft buildings and an empty stash. */
function shopper(trust: number, seed = 'a17'): ProfileState {
  const p = newProfile(content, 1, 'A17', seed, NOW);
  for (const t of Object.values(p.traders)) t.trust = trust;
  for (const f of UNLOCK_FLAGS) p.flags[f] = true;
  for (const b of BUILDINGS) p.buildings.push({ guid: `a17-${b}`, buildingId: b, x: 0, y: 0, rot: 0 });
  p.currency = 10_000_000;
  for (const id of [...p.store.containers[STASH]!.items]) destroyItem(p.store, id);
  return p;
}

function applied<T>(o: TxOutcome<T>): T {
  if (!o.ok || !o.applied) throw new Error(`expected an applied transaction, got ${JSON.stringify(o)}`);
  return o.value;
}

let nonce = 0;
function mustApply<T>(p: ProfileState, fn: (d: ProfileState) => T): { next: ProfileState; value: T } {
  const { outcome, next } = runTx(p, `a17:${++nonce}`, fn);
  return { next, value: applied(outcome) };
}

function refused<T>(p: ProfileState, fn: (d: ProfileState) => T): string {
  const { outcome, next } = runTx(p, `a17:${++nonce}`, fn);
  expect(next).toBe(p);
  if (outcome.ok) throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
  return outcome.reason;
}

/** Item ids present in `after` but not in `before`. */
function created(before: ProfileState, after: ProfileState): string[] {
  return Object.keys(after.store.items).filter((id) => !before.store.items[id]);
}

/** Total quantity per item definition over the whole profile store. */
function counts(p: ProfileState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of Object.values(p.store.items)) out[it.definitionId] = (out[it.definitionId] ?? 0) + it.quantity;
  return out;
}

function withDelta(base: Record<string, number>, delta: Record<string, number>): Record<string, number> {
  const out = { ...base };
  for (const [k, v] of Object.entries(delta)) {
    out[k] = (out[k] ?? 0) + v;
    if (out[k] === 0) delete out[k];
  }
  return out;
}

/** A trader that buys this item kind (all traders share the same trust in these fixtures). */
function buyerFor(defId: string): string | null {
  const kind = content.item(defId).kind;
  for (const t of content.traders.values()) if (t.buysKinds.includes(kind)) return t.id;
  return null;
}

/** Highest possible per-unit sale price of a fresh (full-condition) unit at this trust, before flooring. */
function unitSellCeiling(defId: string, trust: number): number {
  return SELL_RATIO * content.item(defId).basePrice * (1 + TRUST_PRICE_SWING * Math.min(1, trust / 1000));
}

/** Root items of home storage (sellValue of a root already includes magazines, attachments, rounds and bag contents). */
function homeRoots(p: ProfileState): string[] {
  return homeContainers(p).flatMap((c) => p.store.containers[c]?.items ?? []);
}

/** Liquidation value of everything the player owns in the shelter (home storage + equipped loadout). */
function liquidation(p: ProfileState, trust: number): number {
  const roots = [...homeRoots(p), ...Object.keys(p.store.containers).filter((c) => c.startsWith('eq:player:')).flatMap((c) => p.store.containers[c]!.items)];
  return roots.reduce((s, id) => s + sellValue(p, content, id, trust), 0);
}

/** Sell every home-storage root item created since `before` (grouped by a buying trader). Quest items are unsellable. */
function liquidateNew(before: ProfileState, p: ProfileState): { next: ProfileState; earned: number } {
  const fresh = new Set(created(before, p));
  const groups = new Map<string, string[]>();
  for (const id of homeRoots(p)) {
    if (!fresh.has(id)) continue;
    const d = content.item(p.store.items[id]!.definitionId);
    const buyer = buyerFor(d.id);
    if (!buyer || d.kind === 'quest') continue;
    groups.set(buyer, [...(groups.get(buyer) ?? []), id]);
  }
  let next = p;
  let earned = 0;
  for (const [trader, ids] of groups) {
    const r = mustApply(next, (d) => sellItems(d, content, trader, ids, `sell:${ids.join(',')}`));
    next = r.next;
    earned += r.value.earned;
  }
  return { next, earned };
}

// --- purchase options ------------------------------------------------------------------------------------------

type Source = { kind: 'trader'; traderId: string } | { kind: 'market'; generation: number; offerId: string };
interface Offer {
  itemId: string;
  price: number;
  qty: number;
  via: Source;
}

/** Every purchasable unit at this trust: unlocked trader lines and black-market offers over many generations. */
function allOffers(trust: number, seed = 'a17'): Offer[] {
  const p = shopper(trust, seed);
  const out: Offer[] = [];
  for (const t of content.traders.values()) {
    ensureTraderStock(p, content, t.id);
    for (const l of stockLines(p, content, t.id)) if (!l.locked && l.qty > 0) out.push({ itemId: l.itemId, price: l.price, qty: l.qty, via: { kind: 'trader', traderId: t.id } });
  }
  for (let g = 0; g < MARKET_GENERATIONS; g++) for (const o of generateMarketOffers(p, content, g)) if (o.qty > 0) out.push({ itemId: o.itemId, price: o.price, qty: o.qty, via: { kind: 'market', generation: g, offerId: o.offerId } });
  return out;
}

const cheapestCache = new Map<number, Map<string, Offer>>();

/** Cheapest way to buy each item definition at this trust. */
function cheapest(trust: number): Map<string, Offer> {
  const hit = cheapestCache.get(trust);
  if (hit) return hit;
  const best = new Map<string, Offer>();
  for (const o of allOffers(trust)) {
    const cur = best.get(o.itemId);
    if (!cur || o.price < cur.price || (o.price === cur.price && o.via.kind === 'trader' && cur.via.kind === 'market')) best.set(o.itemId, o);
  }
  cheapestCache.set(trust, best);
  return best;
}

/** Buy through the real transaction of the offer's source (market offers: at the generation that listed them). */
function buy(p: ProfileState, o: Offer, qty: number): { next: ProfileState; paid: number; ids: string[] } {
  const via = o.via;
  let base = p;
  let r: { next: ProfileState; value: { paid: number } };
  if (via.kind === 'trader') r = mustApply(base, (d) => buyFromTrader(d, content, via.traderId, o.itemId, qty, `buy:${via.traderId}:${o.itemId}:${nonce}`));
  else {
    base = structuredClone(p);
    base.generation = via.generation;
    base.market = { generation: -1, offers: [] };
    r = mustApply(base, (d) => buyFromMarket(d, content, via.offerId, qty, `bm:${via.offerId}:${nonce}`));
  }
  return { next: r.next, paid: r.value.paid, ids: created(base, r.next) };
}

// --- (a) buy → sell back ------------------------------------------------------------------------------------------

describe('A17 (a) buy → sell back never profits', () => {
  it.each(TRUSTS)('trust %i: every trader stock line (locked or not) prices above its best possible unit sale', (trust) => {
    let lines = 0;
    for (const t of content.traders.values())
      for (const s of t.stock) {
        const price = unitBuyPrice(content, s.itemId, trust);
        expect(price, `${t.id} ${s.itemId}`).toBe(Math.max(1, Math.round(content.item(s.itemId).basePrice * (1.1 - (0.2 * trust) / 1000))));
        expect(price, `${t.id} ${s.itemId}: buy ${price} vs sell ceiling ${unitSellCeiling(s.itemId, trust)}`).toBeGreaterThan(unitSellCeiling(s.itemId, trust));
        lines++;
      }
    expect(lines).toBe([...content.traders.values()].reduce((n, t) => n + t.stock.length, 0));
  });

  it.each(TRUSTS)('trust %i: real buy → sell of every unlocked trader line, one unit (a single round for ammo) and one full stack', (trust) => {
    let cycles = 0;
    for (const o of allOffers(trust).filter((x) => x.via.kind === 'trader')) {
      const def = content.item(o.itemId);
      for (const qty of [...new Set([1, Math.min(def.stackMax, o.qty)])]) {
        const p = shopper(trust);
        const b = buy(p, o, qty);
        expect(b.paid).toBe(o.price * qty);
        expect(b.ids.length).toBeGreaterThan(0);
        const value = b.ids.reduce((s, id) => s + sellValue(b.next, content, id, trust), 0);
        const buyer = buyerFor(o.itemId);
        expect(buyer, `${o.itemId} has a buyer`).not.toBeNull();
        const sold = mustApply(b.next, (d) => sellItems(d, content, buyer!, b.ids, 'sell'));
        expect(sold.value.earned).toBe(value);
        expect(sold.value.earned, `${o.itemId} ×${qty}: earned ${sold.value.earned} vs paid ${b.paid}`).toBeLessThan(b.paid);
        expect(sold.next.currency).toBeLessThan(p.currency);
        expect(validateStore(sold.next.store, content)).toEqual([]);
        cycles++;
      }
    }
    // trust 0 reaches only the minTrust-0 lines; trust 1000 reaches every line of every trader.
    const expectedLines = [...content.traders.values()].reduce((n, t) => n + t.stock.filter((s) => s.minTrust <= trust).length, 0);
    expect(cycles).toBeGreaterThanOrEqual(expectedLines);
  });

  it(`black market over ${MARKET_GENERATIONS} generations × 3 seeds: every offer costs more than its best unit sale; real buy → sell for the first 12 generations`, () => {
    const seen = new Set<string>();
    for (const seed of ['a17', 'a17-b', 'a17-c']) {
      const p = shopper(1000, seed);
      for (let g = 0; g < MARKET_GENERATIONS; g++) {
        const offers = generateMarketOffers(p, content, g);
        expect(offers.length).toBeGreaterThan(0);
        for (const o of offers) {
          seen.add(o.itemId);
          for (const trust of TRUSTS) expect(o.price, `${seed} gen ${g} ${o.itemId}`).toBeGreaterThan(unitSellCeiling(o.itemId, trust));
        }
      }
    }
    expect([...seen].sort()).toEqual([...new Set(content.market('core.market.black').pool.map((e) => e.itemId))].sort());
    for (const trust of TRUSTS)
      for (const o of allOffers(trust).filter((x) => x.via.kind === 'market' && x.via.generation < 12)) {
        const p = shopper(trust);
        const b = buy(p, o, 1);
        const buyer = buyerFor(o.itemId)!;
        const sold = mustApply(b.next, (d) => sellItems(d, content, buyer, b.ids, 'sell'));
        expect(sold.value.earned, `trust ${trust} ${o.itemId}: earned ${sold.value.earned} vs paid ${b.paid}`).toBeLessThan(b.paid);
      }
  });
});

// --- (b) crafting ---------------------------------------------------------------------------------------------------

const RECIPE_CASES = [...content.recipes.values()].flatMap((r) => TRUSTS.map((t) => [r.id, t] as const));

/** Sell value of `qty` fresh units of a definition as one stack (the real sellValue on a real instance). */
function stackValue(defId: string, qty: number, trust: number): number {
  const p = shopper(trust);
  const ids = grantItems(p, content, defId, qty, 'probe');
  return ids.reduce((s, id) => s + sellValue(p, content, id, trust), 0);
}

describe('A17 (b) crafting: inputs + fee always cost more than the output sells for', () => {
  it.each(RECIPE_CASES)('%s at trust %i: buying every input + fee costs more than the output sells for (spec: 구매→제작→판매 무한 이익 0)', (recipeId, trust) => {
    const r = content.recipe(recipeId);
    const best = cheapest(trust);
    const parts = r.inputs.map((i) => {
      const o = best.get(i.itemId);
      return o ? { itemId: i.itemId, qty: i.qty, how: 'buy', cost: o.price * i.qty } : { itemId: i.itemId, qty: i.qty, how: 'sell value (not buyable)', cost: stackValue(i.itemId, i.qty, trust) };
    });
    const inputCost = parts.reduce((s, x) => s + x.cost, 0);
    const outputValue = stackValue(r.output.itemId, r.output.qty, trust);
    const note = `${recipeId} @${trust}: inputs ${JSON.stringify(parts)} + fee ${r.fee} vs output ${r.output.qty}× ${r.output.itemId} sells for ${outputValue}`;
    if (parts.every((x) => x.how === 'buy')) {
      // A loop that starts from currency: must always lose money.
      expect(inputCost + r.fee, note).toBeGreaterThan(outputValue);
    } else {
      // Some inputs are loot-only at this trust (e.g. antiseptic below trust 100): not a currency loop. Crafting may add
      // a small bounded amount of value to looted materials (spec fee values are fixed), but never more than 10 %.
      expect(outputValue - (inputCost + r.fee), note).toBeLessThanOrEqual(Math.ceil(outputValue * 0.1));
    }
  });

  it.each(RECIPE_CASES)('%s at trust %i: real startCraft → tickCrafting → completeCraft → sell accounting', (recipeId, trust) => {
    const r = content.recipe(recipeId);
    const best = cheapest(trust);
    let p = shopper(trust);
    if (r.requiresFlag) expect(p.flags[r.requiresFlag]).toBe(true);
    if (r.requiresBuilding) expect(p.buildings.map((b) => b.buildingId)).toContain(r.requiresBuilding);
    // Acquire the inputs: buy when possible, otherwise they come from raid loot (valued at their sell price).
    let spent = 0;
    let lootValue = 0;
    for (const i of r.inputs) {
      const o = best.get(i.itemId);
      if (o && o.via.kind === 'trader') {
        const b = buy(p, o, i.qty);
        spent += b.paid;
        p = b.next;
      } else {
        const ids = grantItems(p, content, i.itemId, i.qty, 'loot');
        lootValue += ids.reduce((s, id) => s + sellValue(p, content, id, trust), 0);
      }
    }
    const c0 = p.currency;
    const k0 = counts(p);
    const home0 = Object.fromEntries(r.inputs.map((i) => [i.itemId, countDef(p.store, i.itemId, homeContainers(p))]));
    const start = mustApply(p, (d) => startCraft(d, content, recipeId));
    p = start.next;
    const job = start.value;
    // Fee charged once; inputs reserved (moved out of home storage), not yet destroyed.
    expect(p.currency).toBe(c0 - r.fee);
    expect(counts(p)).toEqual(k0);
    for (const i of r.inputs) expect(countDef(p.store, i.itemId, homeContainers(p))).toBe(home0[i.itemId]! - i.qty);
    expect(countDef(p.store, r.inputs[0]!.itemId, [`craft:${job.jobId}`])).toBe(r.inputs[0]!.qty);
    expect(tickCrafting(p, job.total / 2)).toEqual([]);
    expect(tickCrafting(p, job.total / 2)).toEqual([job.jobId]);
    const done = mustApply(p, (d) => completeCraft(d, content, job.jobId, `craftdone:${job.jobId}`));
    p = done.next;
    const delta: Record<string, number> = { [r.output.itemId]: r.output.qty };
    for (const i of r.inputs) delta[i.itemId] = (delta[i.itemId] ?? 0) - i.qty;
    expect(counts(p)).toEqual(withDelta(k0, delta));
    expect(p.currency).toBe(c0 - r.fee);
    expect(p.crafting.jobs).toEqual([]);
    expect(p.store.containers[`craft:${job.jobId}`]).toBeUndefined();
    expect(validateStore(p.store, content)).toEqual([]);
    const outputValue = done.value.outputIds.reduce((s, id) => s + sellValue(p, content, id, trust), 0);
    if (content.item(r.output.itemId).kind === 'quest') {
      expect(outputValue).toBe(0);
      expect(refused(p, (d) => sellItems(d, content, buyerFor('core.mat.wire')!, done.value.outputIds, 'sell'))).toBe('trade.err.quest_item');
    } else {
      const sold = mustApply(p, (d) => sellItems(d, content, buyerFor(r.output.itemId)!, done.value.outputIds, 'sell'));
      expect(sold.value.earned).toBe(outputValue);
      expect(sold.next.currency).toBe(c0 - r.fee + outputValue);
    }
    // The real run reproduces exactly the numbers the cost comparison above is made of.
    const boughtCost = r.inputs.reduce((s, i) => s + (best.get(i.itemId)?.via.kind === 'trader' ? best.get(i.itemId)!.price * i.qty : 0), 0);
    const lootedCost = r.inputs.reduce((s, i) => s + (best.get(i.itemId)?.via.kind === 'trader' ? 0 : stackValue(i.itemId, i.qty, trust)), 0);
    expect({ spent, lootValue, outputValue }).toEqual({ spent: boughtCost, lootValue: lootedCost, outputValue: stackValue(r.output.itemId, r.output.qty, trust) });
  });
});

// --- (c) dismantle --------------------------------------------------------------------------------------------------

describe('A17 (c) dismantling a bought item returns less than its price', () => {
  it.each(TRUSTS)('trust %i: every buyable item with dismantle outputs — real buy → dismantle → sell', (trust) => {
    const best = cheapest(trust);
    let checked = 0;
    for (const [itemId, o] of [...best].sort(([a], [b]) => a.localeCompare(b))) {
      const def = content.item(itemId);
      if (!def.dismantle?.length) continue;
      const p = shopper(trust);
      const b = buy(p, o, 1);
      expect(b.ids).toHaveLength(1);
      const before = b.next;
      const k0 = counts(before);
      const dis = mustApply(before, (d) => dismantleItem(d, content, b.ids[0]!, 'dismantle'));
      expect(dis.value.outputs).toEqual(def.dismantle);
      const outputsDelta: Record<string, number> = { [itemId]: -1 };
      for (const x of def.dismantle) outputsDelta[x.itemId] = (outputsDelta[x.itemId] ?? 0) + x.qty;
      expect(counts(dis.next)).toEqual(withDelta(k0, outputsDelta));
      expect(dis.next.currency).toBe(before.currency);
      const sold = liquidateNew(before, dis.next);
      const formula = def.dismantle.reduce((s, x) => s + stackValue(x.itemId, x.qty, trust), 0);
      expect(sold.earned).toBe(formula);
      expect(sold.earned, `${itemId} @${trust}: outputs sell for ${sold.earned}, bought for ${b.paid}`).toBeLessThan(b.paid);
      expect(sold.next.currency).toBeLessThan(p.currency);
      checked++;
    }
    expect(checked).toBeGreaterThan(trust === 0 ? 10 : 30);
  });

  it('stacked dismantlables scale per unit (a stack of 5 batteries yields 5 chem and still loses money)', () => {
    for (const trust of TRUSTS) {
      const o = cheapest(trust).get('core.mat.battery')!;
      const p = shopper(trust);
      const b = buy(p, o, 5);
      expect(b.ids).toHaveLength(1);
      const dis = mustApply(b.next, (d) => dismantleItem(d, content, b.ids[0]!, 'dismantle'));
      expect(dis.value.outputs).toEqual([{ itemId: 'core.mat.chem', qty: 5 }]);
      const sold = liquidateNew(b.next, dis.next);
      expect(sold.earned).toBeLessThan(b.paid);
    }
  });
});

// --- (d) repair -----------------------------------------------------------------------------------------------------

const REPAIRABLE = [...content.items.values()].filter((d) => d.weapon || d.armor).map((d) => d.id);
const REPAIR_CASES = TRUSTS.flatMap((t) => [false, true].flatMap((bench) => [false, true].map((perk) => [t, bench, perk] as const)));

describe('A17 (d) repairing with a bought repair kit never increases total wealth', () => {
  it.each(REPAIR_CASES)('trust %i, workbench upgrade %s, gunsmith perk %s: every weapon and armor piece from several damage levels', (trust, bench, perk) => {
    const base = shopper(trust);
    if (bench) base.facilities['core.facility.workbench'] = 1;
    if (perk) base.perks = [GUNSMITH];
    const mult = aggregatePerks(content, base.perks).repairMult ?? 1;
    const amount = repairAmount(base) * mult;
    expect(amount).toBeCloseTo((bench ? 50 : 40) * (perk ? 1.2 : 1), 9);
    const violations: string[] = [];
    let checked = 0;
    for (const defId of REPAIRABLE) {
      const def = content.item(defId);
      const max = def.weapon ? 100 : def.armor!.maxDurability;
      for (const dur of [...new Set([0, 1, Math.floor(max / 2), Math.max(0, Math.ceil(max - amount)), max - 1])]) {
        let p = structuredClone(base);
        const [item] = grantItems(p, content, defId, 1, 'loot', { durability: dur });
        const wealth0 = p.currency + liquidation(p, trust);
        const valueBefore = sellValue(p, content, item!, trust);
        const kit = mustApply(p, (d) => buyFromTrader(d, content, MECH, KIT, 1, 'buy:kit'));
        p = kit.next;
        const rep = mustApply(p, (d) => repairItem(d, content, item!, mult, 'repair'));
        p = rep.next;
        expect(rep.value.restored).toBeCloseTo(Math.min(amount, max - dur), 9);
        expect(countDef(p.store, KIT)).toBe(0);
        const wealth1 = p.currency + liquidation(p, trust);
        const valueAfter = sellValue(p, content, item!, trust);
        const sold = mustApply(p, (d) => sellItems(d, content, MECH, [item!], 'sell'));
        expect(sold.value.earned).toBe(valueAfter);
        if (wealth1 > wealth0) violations.push(`${defId} durability ${dur}→${dur + rep.value.restored}: sale value ${valueBefore}→${valueAfter} (+${valueAfter - valueBefore}) for a ${kit.value.paid} cr kit ⇒ wealth +${wealth1 - wealth0}`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(80);
    expect(violations).toEqual([]);
  });

  it('a bought (full-condition) item cannot be repaired at all: no repair step exists in a pure buy → repair → sell cycle', () => {
    for (const trust of TRUSTS) {
      let p = shopper(trust);
      const kit = mustApply(p, (d) => buyFromTrader(d, content, MECH, KIT, 1, 'buy:kit'));
      p = kit.next;
      for (const o of [...cheapest(trust).values()].filter((x) => content.item(x.itemId).weapon || content.item(x.itemId).armor)) {
        const b = buy(p, o, 1);
        expect(refused(b.next, (d) => repairItem(d, content, b.ids[0]!, 1.2, 'repair')), o.itemId).toBe('repair.err.full');
      }
    }
  });
});

// --- (e) relief kit and quest items -------------------------------------------------------------------------------

/** Bankrupt profile (no weapon, no knife, no bag, 200 cr) after claiming the relief kit; returns the relief item ids. */
function reliefProfile(trust: number): { p: ProfileState; relief: string[] } {
  const p0 = newProfile(content, 1, 'A17', 'a17-relief', NOW);
  for (const t of Object.values(p0.traders)) t.trust = trust;
  for (const it of Object.values(p0.store.items)) {
    const k = content.item(it.definitionId).kind;
    if (p0.store.items[it.instanceId] && (k === 'weapon' || k === 'melee' || k === 'backpack')) destroyItem(p0.store, it.instanceId);
  }
  for (const id of [...p0.store.containers[STASH]!.items]) destroyItem(p0.store, id);
  p0.currency = 200;
  const r = mustApply(p0, (d) => claimRelief(d, content, 'relief:0'));
  const relief = created(p0, r.next);
  for (const id of relief) expect(r.next.store.items[id]!.modifiers, id).toContain(RELIEF_MODIFIER);
  expect(relief.map((id) => r.next.store.items[id]!.definitionId).sort()).toEqual(['core.ammo.9.relief', 'core.bag.basic', 'core.mag.p9', 'core.med.bandage', 'core.melee.knife', 'core.weapon.p9'].sort());
  return { p: r.next, relief };
}

/** Move every equipped relief item into the stash (sell / dismantle only take home storage). */
function unequipAll(p: ProfileState): ProfileState {
  let cur = p;
  for (const slot of ['secondary', 'melee', 'backpack'] as const) if (cur.store.containers[`eq:player:${slot}`]!.items.length) cur = mustApply(cur, (d) => unequipProfileItem(d, content, slot)).next;
  return cur;
}

describe('A17 (e) relief kit items are worthless; quest items cannot be sold', () => {
  it.each(TRUSTS)('trust %i: every relief item (incl. the loaded pistol, its magazine and chambered round) sells for 0', (trust) => {
    const { p, relief } = reliefProfile(trust);
    for (const id of relief) for (const tr of [...TRUST_TIERS, 1000]) expect(sellValue(p, content, id, tr), `${p.store.items[id]!.definitionId} @${tr}`).toBe(0);
    const q = unequipAll(p);
    const roots = relief.filter((id) => homeRoots(q).includes(id));
    expect(roots.length).toBe(5); // pistol (with magazine), knife, bag, ammo, bandages
    const sold = mustApply(q, (d) => sellItems(d, content, MECH, roots, 'sell:relief'));
    expect(sold.value.earned).toBe(0);
    expect(sold.next.currency).toBe(200);
  });

  it.each(TRUSTS)('trust %i: dismantling relief items yields nothing', (trust) => {
    const { p } = reliefProfile(trust);
    let q = unequipAll(p);
    const pistol = homeRoots(q).find((id) => q.store.items[id]!.definitionId === 'core.weapon.p9')!;
    expect(refused(q, (d) => dismantleItem(d, content, pistol, 'dismantle'))).toBe('dismantle.err.strip_first');
    q = mustApply(q, (d) => unloadWeapon(d, content, pistol, 'unload')).next;
    for (const id of homeRoots(q).filter((x) => q.store.items[x]!.modifiers.includes(RELIEF_MODIFIER))) {
      const defId = q.store.items[id]!.definitionId;
      const r = mustApply(q, (d) => dismantleItem(d, content, id, 'dismantle'));
      expect(r.value.outputs, defId).toEqual([]);
      expect(created(q, r.next), defId).toEqual([]);
      expect(r.next.currency).toBe(q.currency);
      q = r.next;
    }
  });

  it('quest items: sale value 0, selling and dismantling are refused', () => {
    const quest = [...content.items.values()].filter((d) => d.kind === 'quest').map((d) => d.id);
    expect(quest.length).toBeGreaterThan(0);
    for (const trust of TRUSTS) {
      const p = shopper(trust);
      for (const defId of quest) {
        const [id] = grantItems(p, content, defId, 1, 'loot');
        expect(sellValue(p, content, id!, trust)).toBe(0);
        for (const t of content.traders.values()) expect(refused(p, (d) => sellItems(d, content, t.id, [id!], 'sell')), `${defId} → ${t.id}`).toBe('trade.err.quest_item');
        expect(refused(p, (d) => dismantleItem(d, content, id!, 'dismantle'))).toBe('dismantle.err.not_allowed');
      }
    }
  });

  it.each(TRUSTS)('trust %i: relief rounds stay worthless when unloaded from the relief pistol / magazine or loaded into a regular magazine', (trust) => {
    // Path 1: unload the relief pistol (chambered round) and its relief magazine (14 rounds).
    const { p } = reliefProfile(trust);
    expect(liquidation(p, trust)).toBe(0);
    let q = unequipAll(p);
    const pistol = homeRoots(q).find((id) => q.store.items[id]!.definitionId === 'core.weapon.p9')!;
    const mag = q.store.items[pistol]!.weapon!.magazineId!;
    const rounds = q.store.items[mag]!.mag!.rounds.length + (q.store.items[pistol]!.weapon!.chamber ? 1 : 0);
    expect(rounds).toBe(15);
    q = mustApply(q, (d) => unloadWeapon(d, content, pistol, 'unload:weapon')).next;
    q = mustApply(q, (d) => unloadMagazine(d, content, mag, 'unload:mag')).next;
    const plainRounds = homeRoots(q)
      .filter((id) => q.store.items[id]!.definitionId === 'core.ammo.9.fmj' && !q.store.items[id]!.modifiers.includes(RELIEF_MODIFIER))
      .reduce((s, id) => s + q.store.items[id]!.quantity, 0);
    const unload = { liquidationValue: liquidation(q, trust), plainRounds };
    // Path 2: load the 30 loose relief rounds into a regular, bought P9 magazine.
    const r2 = reliefProfile(trust);
    const bought = buy(r2.p, cheapest(trust).get('core.mag.p9')!, 1);
    const regular = bought.ids[0]!;
    const emptyValue = sellValue(bought.next, content, regular, trust);
    const filled = runTx(bought.next, 'a17:fill', (d) => fillMagazine(d, content, regular, 'core.ammo.9.relief'));
    expect(filled.outcome.ok, 'relief rounds can be loaded into a regular magazine (they are real 9mm)').toBe(true);
    expect(filled.next.store.items[regular]!.mag!.rounds.length).toBeGreaterThan(0);
    const valueAdded = sellValue(filled.next, content, regular, trust) - emptyValue;
    expect({ unload, regularMagazine: { valueAdded } }, `${rounds} relief rounds in the pistol, 30 loose relief rounds`).toEqual({ unload: { liquidationValue: 0, plainRounds: 0 }, regularMagazine: { valueAdded: 0 } });
  });
});

// --- (f) one-step cycle search ------------------------------------------------------------------------------------

interface Cycle {
  name: string;
  gain: number;
}

describe('A17 (f) one-step cycle search: buy → (dismantle | craft | repair) → sell never increases currency', () => {
  it.each(TRUSTS)('trust %i', (trust) => {
    const best = cheapest(trust);
    const cycles: Cycle[] = [];
    const run = (name: string, body: (p: ProfileState) => ProfileState) => {
      const p0 = shopper(trust);
      const p1 = body(p0);
      const { next } = liquidateNew(p0, p1);
      cycles.push({ name, gain: next.currency - p0.currency });
    };
    for (const [itemId, o] of [...best].sort(([a], [b]) => a.localeCompare(b))) {
      const def = content.item(itemId);
      const qty = Math.min(def.stackMax, o.qty);
      run(`buy ${qty}× ${itemId} → sell`, (p) => buy(p, o, qty).next);
      if (def.dismantle?.length)
        run(`buy ${qty}× ${itemId} → dismantle → sell`, (p) => {
          const b = buy(p, o, qty);
          return mustApply(b.next, (d) => dismantleItem(d, content, b.ids[0]!, 'dismantle')).next;
        });
      if (def.weapon || def.armor)
        run(`buy ${itemId} + kit → repair → sell`, (p) => {
          const b = buy(p, o, 1);
          const k = mustApply(b.next, (d) => buyFromTrader(d, content, MECH, KIT, 1, 'buy:kit'));
          expect(refused(k.next, (d) => repairItem(d, content, b.ids[0]!, 1.2, 'repair'))).toBe('repair.err.full');
          return k.next;
        });
    }
    let crafts = 0;
    for (const r of content.recipes.values()) {
      if (!r.inputs.every((i) => best.get(i.itemId)?.via.kind === 'trader')) continue;
      crafts++;
      run(`buy inputs → craft ${r.id} → sell`, (p) => {
        let cur = p;
        for (const i of r.inputs) cur = buy(cur, best.get(i.itemId)!, i.qty).next;
        const job = mustApply(cur, (d) => startCraft(d, content, r.id));
        tickCrafting(job.next, job.value.total);
        return mustApply(job.next, (d) => completeCraft(d, content, job.value.jobId, `craftdone:${job.value.jobId}`)).next;
      });
    }
    expect(crafts).toBeGreaterThanOrEqual(trust === 0 ? 2 : 4);
    expect(cycles.length).toBeGreaterThan(trust === 0 ? 40 : 100);
    const profitable = cycles.filter((c) => c.gain > 0);
    expect(profitable, `best cycle: ${JSON.stringify(cycles.reduce((a, b) => (b.gain > a.gain ? b : a)))}`).toEqual([]);
  });
});

// --- sanity of the price rules themselves ------------------------------------------------------------------------

describe('A17 price rules', () => {
  it('condition factor of fresh instances is 1 (so fresh-bought items sell at exactly 35% (+10% at max trust) of base)', () => {
    const ids = { prefix: 'cf', next: 1 };
    for (const d of content.items.values()) {
      const it = instantiate(content, ids, d.id);
      expect(conditionFactor(content, it), d.id).toBe(1);
    }
  });
});
