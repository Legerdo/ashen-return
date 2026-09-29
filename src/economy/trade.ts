import type { ContentRegistry } from '../content/registry';
import { clamp01 } from '../core/math';
import { Rng } from '../core/rng';
import { fail } from '../core/tx';
import { bagContainerId, destroyItem, descendants, type ItemInstance } from '../inventory/store';
import { grantItems, homeContainers, logItem, type MarketOffer, type ProfileState } from '../progression/profile';

/** Economy TUNABLES: trust price influence ±10%, sell = 35% of condition-adjusted base price. */
export const SELL_RATIO = 0.35;
export const TRUST_PRICE_SWING = 0.1;
export const TRUST_TIERS = [0, 100, 250, 500];
export const RELIEF_MODIFIER = 'relief';

export function trustFactor(trust: number): number {
  return clamp01(trust / 1000);
}

/** Unit buy price (ammo prices are per round). */
export function unitBuyPrice(content: ContentRegistry, defId: string, trust: number, priceMult = 1): number {
  const base = content.item(defId).basePrice;
  return Math.max(1, Math.round(base * (1 + TRUST_PRICE_SWING - 2 * TRUST_PRICE_SWING * trustFactor(trust)) * priceMult));
}

export function conditionFactor(content: ContentRegistry, it: ItemInstance): number {
  const d = content.item(it.definitionId);
  if (d.weapon && it.durability !== null) return 0.75 + 0.25 * clamp01(it.durability / 100);
  if (d.armor && it.durability !== null) return 0.75 + 0.25 * clamp01(it.durability / d.armor.maxDurability);
  if (d.medical?.type === 'firstaid') return 0.3 + 0.7 * clamp01((it.medPool ?? 40) / (d.medical.pool ?? 40));
  return 1;
}

/** Sell value of an item instance including contained magazines/attachments/rounds. Relief/quest items are worth 0. */
export function sellValue(p: ProfileState, content: ContentRegistry, itemId: string, trust: number): number {
  const it = p.store.items[itemId];
  if (!it) return 0;
  let total = 0;
  const ids = [itemId, ...descendants(p.store, itemId)];
  for (const id of ids) {
    const x = p.store.items[id];
    if (!x) continue;
    const d = content.item(x.definitionId);
    if (d.noValue || x.modifiers.includes(RELIEF_MODIFIER) || d.kind === 'quest') continue;
    const unit = SELL_RATIO * d.basePrice * conditionFactor(content, x) * (1 + TRUST_PRICE_SWING * trustFactor(trust));
    total += unit * x.quantity;
    // Loaded rounds are stored by definition id; no-value rounds (relief) stay worthless inside any magazine.
    const roundValue = (r: string) => (content.item(r).noValue ? 0 : SELL_RATIO * content.item(r).basePrice);
    if (x.mag) for (const r of x.mag.rounds) total += roundValue(r);
    if (x.weapon?.chamber) total += roundValue(x.weapon.chamber);
    if (x.weapon?.tube) for (const r of x.weapon.tube) total += roundValue(r);
  }
  return Math.floor(total);
}

export interface StockLine {
  itemId: string;
  qty: number;
  price: number;
  minTrust: number;
  locked: string | null;
  always: boolean;
}

export function ensureTraderStock(p: ProfileState, content: ContentRegistry, traderId: string): void {
  const st = p.traders[traderId];
  if (!st || st.generation === p.generation) return;
  const def = content.trader(traderId);
  st.stock = {};
  for (const s of def.stock) st.stock[s.itemId] = s.qty;
  st.generation = p.generation;
}

export function stockLines(p: ProfileState, content: ContentRegistry, traderId: string): StockLine[] {
  const def = content.trader(traderId);
  const st = p.traders[traderId]!;
  return def.stock.map((s) => {
    let locked: string | null = null;
    if (st.trust < s.minTrust) locked = 'trade.locked.trust';
    else if (s.requiresFlag && !p.flags[s.requiresFlag]) locked = 'trade.locked.flag';
    const qty = st.stock[s.itemId] ?? 0;
    return { itemId: s.itemId, qty: s.always ? Math.max(qty, alwaysFloor(s.qty)) : qty, price: unitBuyPrice(content, s.itemId, st.trust, s.priceMult ?? 1), minTrust: s.minTrust, locked, always: !!s.always };
  });
}

/** Basic survival stock (starter pistol ammo, bandages, relief gear) never becomes completely unavailable. */
export function alwaysFloor(qty: number): number {
  return Math.min(qty, 30);
}

export function buyFromTrader(p: ProfileState, content: ContentRegistry, traderId: string, itemId: string, qty: number, tx: string): { paid: number } {
  ensureTraderStock(p, content, traderId);
  const line = stockLines(p, content, traderId).find((l) => l.itemId === itemId);
  if (!line) fail('trade.err.not_sold');
  if (line!.locked) fail(line!.locked!);
  if (!Number.isInteger(qty) || qty <= 0) fail('trade.err.qty');
  if (line!.qty < qty) fail('trade.err.stock');
  const paid = line!.price * qty;
  if (p.currency < paid) fail('trade.err.money');
  const st = p.traders[traderId]!;
  st.stock[itemId] = Math.max(0, (st.stock[itemId] ?? 0) - qty);
  if (line!.always) st.stock[itemId] = Math.max(st.stock[itemId]!, 0);
  p.currency -= paid;
  const created = grantItems(p, content, itemId, qty, tx);
  // Purchases must land in real storage (never silently into overflow): refuse if the stash is full.
  if (created.some((id) => p.store.items[id]?.ownerContainerId === 'incoming')) fail('trade.err.space');
  return { paid };
}

function sellable(p: ProfileState, content: ContentRegistry, itemId: string, traderId: string | null): void {
  const it = p.store.items[itemId];
  if (!it) fail('inv.err.no_item');
  if (!homeContainers(p).includes(it!.ownerContainerId ?? '')) fail('trade.err.not_in_stash');
  if (it!.lockTags.includes('favorite')) fail('inv.err.locked');
  const d = content.item(it!.definitionId);
  if (d.kind === 'quest') fail('trade.err.quest_item');
  if (d.kind === 'backpack') {
    const bag = p.store.containers[bagContainerId(itemId)];
    if (bag && bag.items.length > 0) fail('inv.err.bag_not_empty');
  }
  if (traderId) {
    const t = content.trader(traderId);
    if (!t.buysKinds.includes(d.kind)) fail('trade.err.not_buying');
  }
}

export function sellItems(p: ProfileState, content: ContentRegistry, traderId: string, itemIds: string[], tx: string): { earned: number } {
  const trust = p.traders[traderId]?.trust ?? 0;
  let earned = 0;
  for (const id of itemIds) sellable(p, content, id, traderId);
  for (const id of itemIds) {
    earned += sellValue(p, content, id, trust);
    const it = p.store.items[id]!;
    logItem(p, { tx, event: 'destroy', defId: it.definitionId, qty: it.quantity, itemId: id, reason: `sold:${traderId}` });
    destroyItem(p.store, id);
  }
  p.currency += earned;
  return { earned };
}

// --- Black market -----------------------------------------------------------------------------------------------

export function marketUnlocked(p: ProfileState, content: ContentRegistry): boolean {
  const m = content.market('core.market.black');
  return !!p.flags[m.unlockFlag];
}

/** Deterministic offers from (profile seed, market generation); menu re-entry or reload never re-rolls. */
export function generateMarketOffers(p: ProfileState, content: ContentRegistry, generation: number): MarketOffer[] {
  const m = content.market('core.market.black');
  const rng = Rng.fromSeed(`${p.seed}|market|${generation}`);
  const pool = m.pool.map((e) => ({ ...e }));
  const out: MarketOffer[] = [];
  for (let i = 0; i < m.slots && pool.length > 0; i++) {
    const pick = rng.weighted(pool.map((e, idx) => ({ weight: e.weight, value: idx })));
    const e = pool.splice(pick, 1)[0]!;
    const qty = rng.int(e.qty[0], e.qty[1]);
    out.push({ offerId: `bm-${generation}-${i}`, itemId: e.itemId, qty, price: unitBuyPrice(content, e.itemId, 0, e.priceMult) });
  }
  return out;
}

export function ensureMarket(p: ProfileState, content: ContentRegistry): void {
  if (!marketUnlocked(p, content)) return;
  if (p.market.generation === p.generation && p.market.offers.length > 0) return;
  p.market = { generation: p.generation, offers: generateMarketOffers(p, content, p.generation) };
}

export function buyFromMarket(p: ProfileState, content: ContentRegistry, offerId: string, qty: number, tx: string): { paid: number } {
  if (!marketUnlocked(p, content)) fail('market.err.locked');
  ensureMarket(p, content);
  const o = p.market.offers.find((x) => x.offerId === offerId);
  if (!o) fail('market.err.no_offer');
  if (!Number.isInteger(qty) || qty <= 0 || o!.qty < qty) fail('trade.err.stock');
  const paid = o!.price * qty;
  if (p.currency < paid) fail('trade.err.money');
  o!.qty -= qty;
  p.currency -= paid;
  const created = grantItems(p, content, o!.itemId, qty, tx);
  if (created.some((id) => p.store.items[id]?.ownerContainerId === 'incoming')) fail('trade.err.space');
  return { paid };
}
