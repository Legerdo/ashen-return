import type { ContentRegistry } from '../content/registry';
import type { EquipSlot, TimePhase, Weather } from '../content/types';
import { Rng } from '../core/rng';
import { fail } from '../core/tx';
import { addContainer, bagContainerId, destroyItem, emptyStore, itemsInContainerDeep, transferBetweenStores, type ItemStore } from '../inventory/store';
import type { SimState } from '../world/state';
import type { RaidLaunch } from '../world/spawn';
import { raidThreat } from '../world/threat';
import { applyRaidToContracts } from './contracts';
import { addExp, applyQuestEvent, activeQuestIds, objDone } from './quests';
import { aggregatePerks, DEATHBAG, deposit, KEEP_ON_DEATH, logItem, pushLog, SECURE_POCKET, type Forecast, type ProfileState, type RaidSummary } from './profile';

const SLOTS: EquipSlot[] = ['primary1', 'primary2', 'secondary', 'melee', 'helmet', 'vest', 'backpack', 'accessory'];
const eq = (actor: string, s: EquipSlot) => `eq:${actor}:${s}`;

export const EXTRACT_EXP = 100;
export const DISCOVERY_EXP = 25;
export const HEADSHOT_KILL_EXP = 10;

/** Deterministic forecast per destination and profile generation (A16: identical after save/load). */
export function forecastFor(p: ProfileState, content: ContentRegistry, destId: string): Forecast {
  const cur = p.forecasts[destId];
  if (cur && cur.generation === p.generation) return cur;
  const d = content.destination(destId);
  const rng = Rng.fromSeed(`${p.seed}|forecast|${destId}|${p.generation}`);
  const phase = rng.weighted((Object.keys(d.timeWeights) as TimePhase[]).map((k) => ({ weight: d.timeWeights[k], value: k })));
  const weather = rng.weighted((Object.keys(d.weatherWeights) as Weather[]).map((k) => ({ weight: d.weatherWeights[k], value: k })));
  const f: Forecast = { destId, seed: `${p.seed}:${destId}:${p.generation}:${rng.nextU32().toString(36)}`, phase, weather, generation: p.generation };
  p.forecasts[destId] = f;
  return f;
}

function questItemNeeds(p: ProfileState, content: ContentRegistry, loadout: ItemStore): { held: string[] } {
  const held = new Set<string>();
  const has = (defId: string) => Object.values(p.store.items).some((i) => i.definitionId === defId) || Object.values(loadout.items).some((i) => i.definitionId === defId);
  for (const qid of activeQuestIds(p)) {
    const q = content.quest(qid);
    for (const o of q.objectives) {
      if (o.type !== 'ExtractWith' || !o.target) continue;
      if (objDone(p, q, o) || has(o.target)) held.add(o.target);
    }
  }
  return { held: [...held] };
}

/**
 * Move every root item of a grid container (with descendants) from one store to the same container id in another,
 * keeping grid positions; the destination container is created with the source's shape when missing. Returns the
 * moved item ids (roots and descendants).
 */
function moveGridContents(from: ItemStore, to: ItemStore, cid: string): string[] {
  const src = from.containers[cid];
  if (!src) return [];
  const dst = addContainer(to, { id: cid, kind: src.kind, w: src.w, h: src.h });
  const moved: string[] = [];
  for (const id of [...src.items]) {
    const it = from.items[id];
    if (!it) continue;
    const pos = it.gridPosition ? { ...it.gridPosition } : null;
    const rot = it.rotation;
    moved.push(...transferBetweenStores(from, to, id));
    const r = to.items[id]!;
    r.ownerContainerId = cid;
    r.gridPosition = pos;
    r.rotation = rot;
    if (!dst.items.includes(id)) dst.items.push(id);
  }
  return moved;
}

/** Deployment transaction body: the loadout leaves the profile store and moves into the raid (single ownership). */
export function prepareDeploy(p: ProfileState, content: ContentRegistry, destId: string, now: number): RaidLaunch {
  if (!p.flags['deploy_allowed']) fail('deploy.err.not_allowed');
  const dest = content.destination(destId);
  if (dest.unlockFlag && !p.flags[dest.unlockFlag]) fail('deploy.err.locked');
  if (p.activeRaid) fail('deploy.err.active');
  const f = forecastFor(p, content, destId);
  p.raidCounter++;
  const raidId = `r${p.slotId}-${p.raidCounter}`;
  const loadout = emptyStore();
  for (const s of SLOTS) addContainer(loadout, { id: eq('player', s), kind: 'slot', w: 1, h: 1, accepts: s });
  for (const s of SLOTS) {
    const c = p.store.containers[eq('player', s)];
    const id = c?.items[0];
    if (!id) continue;
    transferBetweenStores(p.store, loadout, id);
    const it = loadout.items[id]!;
    it.ownerContainerId = eq('player', s);
    it.gridPosition = null;
    loadout.containers[eq('player', s)]!.items.push(id);
  }
  // The secret pocket travels along (same grid, same positions); it is the player's pocket container in the raid.
  moveGridContents(p.store, loadout, SECURE_POCKET);
  for (const it of Object.values(loadout.items)) logItem(p, { tx: `deploy:${raidId}`, event: 'transfer', defId: it.definitionId, qty: it.quantity, itemId: it.instanceId, reason: 'to-raid' });
  // Unique key / quest items still count as held while they sit in the death bag (spawned for recovery or not),
  // so the world never places a second copy. Computed before the bag leaves the profile store.
  const keyItemsHeld = [...Object.values(p.store.items), ...Object.values(loadout.items)].filter((i) => content.item(i.definitionId).kind === 'key').map((i) => i.definitionId);
  const needs = questItemNeeds(p, content, loadout);
  let deathBag: RaidLaunch['deathBag'] = null;
  if (p.lastDeathBag && p.lastDeathBag.mapId === dest.mapId) {
    const db = emptyStore();
    const roots = [...(p.store.containers[DEATHBAG]?.items ?? [])];
    for (const id of roots) transferBetweenStores(p.store, db, id);
    deathBag = { store: db, rootIds: roots, x: p.lastDeathBag.x, y: p.lastDeathBag.y, sourceRaidId: p.lastDeathBag.raidId };
    p.lastDeathBag = null;
  }
  const bossRng = Rng.fromSeed(`${f.seed}|boss`);
  const bossActive = p.quests['core.quest.q08_last_signal']?.status === 'active' || (p.flags['free_roam'] === true && bossRng.next() < 0.5);
  p.activeRaid = { raidId, mapId: dest.mapId, destId, startedAt: now };
  p.stats.raids++;
  const quickslots = p.quickslots.map((q) => (q && loadout.items[q] ? q : null));
  return {
    raidId,
    mapId: dest.mapId,
    seed: f.seed,
    phase: f.phase,
    weather: f.weather,
    flags: { ...p.flags },
    registeredKeys: [...p.keys.registered],
    activeQuests: activeQuestIds(p),
    questItemsHeld: needs.held,
    keyItemsHeld,
    perks: aggregatePerks(content, p.perks),
    notesKnown: Object.entries(p.notes).filter(([, n]) => n.found).map(([id]) => id),
    loadout,
    quickslots,
    deathBag,
    bossActive,
    threat: raidThreat((q) => p.quests[q]?.status === 'completed'),
    // Procedural terrain (default on): the layout follows the raid seed, so a resumed raid rebuilds the same map.
    ...(p.settings?.proceduralTerrain === false ? {} : { layoutSeed: f.seed }),
  };
}

/**
 * Raid end transaction body (extraction or death). Committed once per raidId.
 * Works on a private copy of the raid state: if persisting the transaction fails, the live raid keeps every item,
 * so the retry (same txId) settles exactly the same loadout and loot.
 */
export function commitRaidEnd(p: ProfileState, content: ContentRegistry, liveSim: SimState): RaidSummary {
  const sim = structuredClone({ ...liveSim, fx: [] });
  const outcome = sim.outcome;
  if (!outcome) fail('raid.err.not_over');
  if (!p.activeRaid || p.activeRaid.raidId !== sim.raidId) fail('raid.err.mismatch');
  const tx = `raidend:${sim.raidId}`;
  const pl = sim.actors.find((a) => a.kind === 'player')!;
  const extracted = outcome!.kind === 'extracted' && pl.alive;
  const summary: RaidSummary = { raidId: sim.raidId, mapId: sim.mapId, outcome: extracted ? 'extracted' : outcome!.kind === 'abandoned' ? 'abandoned' : 'dead', exitId: extracted && outcome!.kind === 'extracted' ? outcome!.exitId : null, kills: sim.stats.kills, headshots: sim.stats.headshots, expGained: 0, itemsIn: [], itemsLost: [], incoming: 0, levelUps: 0, duration: sim.time, questUpdates: [], notesFound: [], feePaid: 0 };
  const rootSlots = new Map<string, EquipSlot>();
  for (const s of SLOTS) {
    const id = sim.store.containers[eq('player', s)]?.items[0];
    if (id) rootSlots.set(id, s);
  }
  const roots = [...rootSlots.keys()];
  const levelBefore = p.level;
  let exp = 0;
  const map = content.map(sim.mapId);
  if (extracted && outcome!.kind === 'extracted') {
    const exit = map.exits.find((e) => e.id === outcome!.exitId);
    if (exit?.condition.type === 'fee') {
      p.currency -= exit.condition.credits;
      summary.feePaid = exit.condition.credits;
    }
    if (exit?.condition.type === 'item' && exit.condition.consume) {
      const all = roots.flatMap((r) => [r, ...itemsInContainerDeep(sim.store, bagContainerId(r))]);
      const fuel = all.find((id) => sim.store.items[id]?.definitionId === (exit.condition as { itemId: string }).itemId);
      if (fuel) {
        const it = sim.store.items[fuel]!;
        if (it.quantity > 1) it.quantity--;
        else destroyItem(sim.store, fuel);
      }
    }
    const extractedDefs = new Map<string, number>();
    const loadoutSet = new Set(sim.loadoutItemIds);
    for (const r of roots) {
      const moved = transferBetweenStores(sim.store, p.store, r);
      const cid = eq('player', rootSlots.get(r)!);
      const it = p.store.items[r]!;
      it.ownerContainerId = cid;
      it.gridPosition = null;
      if (!p.store.containers[cid]!.items.includes(r)) p.store.containers[cid]!.items.push(r);
      for (const id of moved) {
        const m = p.store.items[id];
        if (m) extractedDefs.set(m.definitionId, (extractedDefs.get(m.definitionId) ?? 0) + m.quantity);
      }
    }
    // The secret pocket comes home as it is (new loot kept in it counts as brought in, and stays in the pocket).
    const pocketRoots = [...(sim.store.containers[SECURE_POCKET]?.items ?? [])];
    for (const id of moveGridContents(sim.store, p.store, SECURE_POCKET)) {
      const m = p.store.items[id];
      if (m) extractedDefs.set(m.definitionId, (extractedDefs.get(m.definitionId) ?? 0) + m.quantity);
    }
    for (const id of pocketRoots) {
      const m = p.store.items[id];
      if (m && !loadoutSet.has(id)) summary.itemsIn.push({ defId: m.definitionId, qty: m.quantity });
    }
    // New loot leaves the bag for the stash (overflow → incoming); items brought from the shelter stay packed.
    const bag = p.store.containers[eq('player', 'backpack')]?.items[0];
    if (bag) {
      const bc = p.store.containers[bagContainerId(bag)];
      for (const id of [...(bc?.items ?? [])]) {
        if (loadoutSet.has(id)) continue;
        const it = p.store.items[id]!;
        // Read before depositing: deposit may merge the stack into an existing stash stack.
        const defId = it.definitionId;
        const qty = it.quantity;
        const where = deposit(p, content, id, tx);
        if (where === 'incoming') summary.incoming++;
        summary.itemsIn.push({ defId, qty });
      }
    }
    // Unrecovered remains of a spawned death bag return to the profile (bag stays recoverable).
    if (sim.deathBagContainerId && sim.store.containers[sim.deathBagContainerId]?.items.length) {
      const left = [...sim.store.containers[sim.deathBagContainerId]!.items];
      for (const id of left) {
        transferBetweenStores(sim.store, p.store, id);
        const it = p.store.items[id]!;
        it.ownerContainerId = DEATHBAG;
        it.gridPosition = null;
        p.store.containers[DEATHBAG]!.items.push(id);
      }
      const src = sim.containers[sim.deathBagContainerId]!;
      p.lastDeathBag = { raidId: sim.deathBagContainerId.replace('deathbag:', ''), mapId: sim.mapId, x: src.x, y: src.y };
    }
    for (const [defId, qty] of extractedDefs) summary.questUpdates.push(...applyQuestEvent(p, content, { type: 'ExtractWith', itemId: defId, qty, mapId: sim.mapId }));
    summary.questUpdates.push(...applyQuestEvent(p, content, { type: 'UseExit', exitId: outcome!.exitId }));
    p.stats.extractions++;
    exp += EXTRACT_EXP;
    p.playerHp = Math.max(1, Math.round(pl.hp));
    p.playerBleeding = pl.status.bleeding;
    const contractChanged = applyRaidToContracts(p, {
      mapId: sim.mapId,
      extracted: true,
      visited: sim.progress.visited,
      kills: sim.progress.kills.map((k) => ({ role: k.role, weaponTags: k.weaponTags })),
      headshots: headshotsOnEnemies(sim, content),
      extractedItems: [...extractedDefs].map(([defId, qty]) => ({ defId, qty })),
      eventsCompleted: sim.progress.eventsCompleted,
    });
    summary.questUpdates.push(...contractChanged);
  } else {
    // Death: previous bag is replaced (policy shown before deployment); account currency and progression stay.
    const oldBag = [...(p.store.containers[DEATHBAG]?.items ?? [])];
    for (const id of oldBag) {
      const it = p.store.items[id];
      if (it) logItem(p, { tx, event: 'destroy', defId: it.definitionId, qty: it.quantity, itemId: id, reason: 'deathbag-replaced' });
      destroyItem(p.store, id);
    }
    if (sim.deathBagContainerId) {
      // The unrecovered bag spawned in this raid is replaced as well (same policy record as a profile-side bag).
      for (const id of [...(sim.store.containers[sim.deathBagContainerId]?.items ?? [])]) {
        const it = sim.store.items[id];
        if (it) logItem(p, { tx, event: 'destroy', defId: it.definitionId, qty: it.quantity, itemId: id, reason: 'deathbag-replaced' });
        destroyItem(sim.store, id);
      }
    }
    const toDeathBag = (id: string) => {
      const moved = transferBetweenStores(sim.store, p.store, id);
      const it = p.store.items[id]!;
      it.ownerContainerId = DEATHBAG;
      it.gridPosition = null;
      p.store.containers[DEATHBAG]!.items.push(id);
      for (const m of moved.map((x) => p.store.items[x])) if (m) summary.itemsLost.push({ defId: m.definitionId, qty: m.quantity });
    };
    const kept: { defId: string; qty: number }[] = [];
    // Secret pocket: never lost — it returns to the profile pocket unchanged.
    for (const id of moveGridContents(sim.store, p.store, SECURE_POCKET)) {
      const m = p.store.items[id];
      if (m) kept.push({ defId: m.definitionId, qty: m.quantity });
    }
    const lostRoots: string[] = [];
    for (const r of roots) {
      const slot = rootSlots.get(r)!;
      const def = content.item(sim.store.items[r]!.definitionId);
      if (!def.tags.includes(KEEP_ON_DEATH)) {
        lostRoots.push(r);
        continue;
      }
      // A keep-on-death item (the basic bag) returns to its slot; whatever it held goes to the death bag.
      const bc = sim.store.containers[bagContainerId(r)];
      for (const id of [...(bc?.items ?? [])]) toDeathBag(id);
      transferBetweenStores(sim.store, p.store, r);
      const it = p.store.items[r]!;
      it.ownerContainerId = eq('player', slot);
      it.gridPosition = null;
      p.store.containers[eq('player', slot)]!.items.push(r);
      kept.push({ defId: def.id, qty: 1 });
    }
    for (const r of lostRoots) toDeathBag(r);
    if (kept.length) summary.itemsKept = kept;
    p.lastDeathBag = (p.store.containers[DEATHBAG]?.items.length ?? 0) > 0 ? { raidId: sim.raidId, mapId: sim.mapId, x: pl.x, y: pl.y } : null;
    p.stats.deaths++;
    p.playerHp = 100;
    p.playerBleeding = false;
    applyRaidToContracts(p, { mapId: sim.mapId, extracted: false, visited: sim.progress.visited, kills: sim.progress.kills.map((k) => ({ role: k.role, weaponTags: k.weaponTags })), headshots: headshotsOnEnemies(sim, content), extractedItems: [], eventsCompleted: sim.progress.eventsCompleted });
  }
  // Common progress: discovery, kills, retrieval, notes.
  for (const poi of sim.progress.visited) summary.questUpdates.push(...applyQuestEvent(p, content, { type: 'Visit', target: poi, context: 'raid' }));
  for (const d of [...sim.progress.visited, ...sim.progress.discovered]) {
    if (!p.flags[`disc:${d}`]) {
      p.flags[`disc:${d}`] = true;
      exp += DISCOVERY_EXP;
    }
  }
  for (const k of sim.progress.kills) {
    summary.questUpdates.push(...applyQuestEvent(p, content, { type: 'Kill', role: k.role, archetypeId: k.archetypeId, weaponTags: k.weaponTags, part: k.part }));
    const arch = k.archetypeId && content.enemies.has(k.archetypeId) ? content.enemy(k.archetypeId) : null;
    exp += (arch?.exp ?? 15) + (k.part === 'head' ? HEADSHOT_KILL_EXP : 0);
  }
  for (const h of sim.progress.hitParts) if (h.context === 'raid') applyQuestEvent(p, content, { type: 'HitPart', part: h.part, context: 'raid', amount: 1 });
  for (const r of sim.progress.retrieved) summary.questUpdates.push(...applyQuestEvent(p, content, { type: 'Retrieve', itemId: r }));
  if (extracted) summary.questUpdates.push(...applyQuestEvent(p, content, { type: 'Survive', mapId: sim.mapId }));
  for (const n of sim.progress.notesFound) {
    const st = (p.notes[n] ??= { found: false, read: false });
    if (!st.found) summary.notesFound.push(n);
    st.found = true;
    if (sim.progress.custom.includes(`read:${n}`)) st.read = true;
  }
  p.stats.kills += sim.stats.kills;
  p.stats.headshots += sim.stats.headshots;
  addExp(p, exp);
  summary.expGained = exp;
  summary.levelUps = p.level - levelBefore;
  summary.questUpdates = [...new Set(summary.questUpdates)];
  p.activeRaid = null;
  p.generation++;
  p.lastRaidSummary = summary;
  pushLog(p, extracted ? 'log.raid.extracted' : 'log.raid.died', { map: map.nameKey });
  return summary;
}

function headshotsOnEnemies(sim: SimState, content: ContentRegistry): { weaponTags: string[] }[] {
  // Headshot hits on enemies inside the raid, attributed to the weapon class through kill records when available.
  const out: { weaponTags: string[] }[] = [];
  for (const h of sim.progress.hitParts) {
    if (h.context !== 'raid' || h.part !== 'head') continue;
    const tags = h.weaponDefId && content.hasItem(h.weaponDefId) ? content.item(h.weaponDefId).tags : [];
    out.push({ weaponTags: tags });
  }
  return out;
}
