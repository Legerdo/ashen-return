import type { ContentRegistry } from '../content/registry';
import type { ObjectiveDef, QuestDef, RewardDef } from '../content/types';
import { fail } from '../core/tx';
import { consumeDef, countDef } from '../inventory/store';
import { grantItems, homeContainers, levelForExp, pushLog, type ProfileState } from './profile';

/**
 * Quest state machine. "Found (Retrieve) / Held / Extracted (ExtractWith) / Submitted (Deliver)" are distinct.
 * Completion rewards, submission consumption, trust, WorldFlags and unlocks commit inside ONE transaction
 * (callers wrap these in runTx with a stable id like quest:<id>:complete).
 */

export type QuestEvent =
  | { type: 'Visit'; target: string; context: 'base' | 'raid' }
  | { type: 'Interact'; target: string }
  | { type: 'Custom'; target: string; amount: number }
  | { type: 'HitPart'; part: string; context: 'range' | 'raid'; amount: number }
  | { type: 'Retrieve'; itemId: string }
  | { type: 'ExtractWith'; itemId: string; qty: number; mapId: string }
  | { type: 'Craft'; recipeId: string }
  | { type: 'Repair' }
  | { type: 'Survive'; mapId: string }
  | { type: 'UseExit'; exitId: string }
  | { type: 'Kill'; role: string; archetypeId: string; weaponTags: string[]; part: string | null };

export function objDone(p: ProfileState, q: QuestDef, o: ObjectiveDef): boolean {
  return (p.quests[q.id]?.progress[o.id] ?? 0) >= o.count;
}

/** Unlock quests whose prerequisites are completed; main and optional quests auto-activate. */
export function refreshQuests(p: ProfileState, content: ContentRegistry): string[] {
  const changed: string[] = [];
  for (const q of content.quests.values()) {
    const st = (p.quests[q.id] ??= { status: 'locked', progress: {} });
    if (st.status === 'locked') {
      const ok = q.requires.every((r) => p.quests[r]?.status === 'completed') && (q.requiresFlags ?? []).every((f) => p.flags[f]);
      if (ok) {
        st.status = 'active';
        changed.push(q.id);
        pushLog(p, 'log.quest.new', { name: q.nameKey });
      }
    }
    if (st.status === 'active') {
      // WorldFlag objectives resolve from state.
      for (const o of q.objectives) if (o.type === 'WorldFlag' && o.target && p.flags[o.target]) st.progress[o.id] = o.count;
      if (isReady(p, q)) {
        st.status = 'ready';
        changed.push(q.id);
      }
    }
  }
  return changed;
}

export function isReady(p: ProfileState, q: QuestDef): boolean {
  return q.objectives.filter((o) => !o.optional).every((o) => objDone(p, q, o));
}

function inc(p: ProfileState, q: QuestDef, o: ObjectiveDef, amount: number): boolean {
  const st = p.quests[q.id]!;
  const cur = st.progress[o.id] ?? 0;
  if (cur >= o.count) return false;
  st.progress[o.id] = Math.min(o.count, cur + Math.max(0, amount));
  return st.progress[o.id] !== cur;
}

/** Apply a gameplay event to all active quests. Returns quest ids whose progress changed. */
export function applyQuestEvent(p: ProfileState, content: ContentRegistry, ev: QuestEvent): string[] {
  const changed = new Set<string>();
  for (const q of content.quests.values()) {
    const st = p.quests[q.id];
    if (!st || st.status !== 'active') continue;
    for (const o of q.objectives) {
      let hit = false;
      switch (ev.type) {
        case 'Visit':
          hit = o.type === 'Visit' && o.target === ev.target && inc(p, q, o, 1);
          break;
        case 'Interact':
          hit = o.type === 'Interact' && o.target === ev.target && inc(p, q, o, 1);
          break;
        case 'Custom':
          hit = o.type === 'CustomValidated' && o.target === ev.target && inc(p, q, o, ev.amount);
          break;
        case 'HitPart':
          hit = o.type === 'HitPart' && o.part === ev.part && (!o.context || o.context === ev.context) && inc(p, q, o, ev.amount);
          break;
        case 'Retrieve':
          hit = o.type === 'Retrieve' && o.target === ev.itemId && inc(p, q, o, 1);
          break;
        case 'ExtractWith':
          hit = o.type === 'ExtractWith' && o.target === ev.itemId && (!o.mapId || o.mapId === ev.mapId) && inc(p, q, o, ev.qty);
          if (hit) {
            // Extracting with an item also proves it was found.
            for (const r of q.objectives) if (r.type === 'Retrieve' && r.target === ev.itemId) inc(p, q, r, r.count);
          }
          break;
        case 'Craft':
          hit = o.type === 'Craft' && o.target === ev.recipeId && inc(p, q, o, 1);
          break;
        case 'Repair':
          hit = o.type === 'Repair' && inc(p, q, o, 1);
          break;
        case 'Survive': {
          if (o.type !== 'Survive' || (o.mapId && o.mapId !== ev.mapId)) break;
          // Survive counts only once the other (non-delivery) objectives of this quest are satisfied.
          const others = q.objectives.filter((x) => x !== o && x.type !== 'Deliver' && !x.optional);
          if (others.every((x) => objDone(p, q, x))) hit = inc(p, q, o, 1);
          break;
        }
        case 'UseExit':
          hit = o.type === 'UseExit' && o.target === ev.exitId && inc(p, q, o, 1);
          break;
        case 'Kill':
          if (o.type === 'Kill') hit = (o.target === ev.role || o.target === ev.archetypeId || o.target === 'any') && inc(p, q, o, 1);
          else if (o.type === 'KillWithWeaponTag') hit = !!o.weaponTag && ev.weaponTags.includes(o.weaponTag) && inc(p, q, o, 1);
          break;
      }
      if (hit) changed.add(q.id);
    }
  }
  refreshQuests(p, content);
  return [...changed];
}

/** Submit deliverable items to an NPC for every active quest objective that wants them (consumes from home storage). */
export function deliverToNpc(p: ProfileState, content: ContentRegistry, npcId: string): { questId: string; itemId: string; qty: number }[] {
  const out: { questId: string; itemId: string; qty: number }[] = [];
  for (const q of content.quests.values()) {
    const st = p.quests[q.id];
    if (!st || st.status !== 'active') continue;
    for (const o of q.objectives) {
      if (o.type !== 'Deliver' || o.npcId !== npcId || !o.target) continue;
      // Delivery needs the item to have been extracted when the quest also has an ExtractWith step for it.
      const needsExtract = q.objectives.find((x) => x.type === 'ExtractWith' && x.target === o.target);
      if (needsExtract && !objDone(p, q, needsExtract)) continue;
      const need = o.count - (st.progress[o.id] ?? 0);
      if (need <= 0) continue;
      const have = countDef(p.store, o.target, homeContainers(p));
      const give = Math.min(need, have);
      if (give <= 0) continue;
      if (!consumeDef(p.store, o.target, give, homeContainers(p))) continue;
      st.progress[o.id] = (st.progress[o.id] ?? 0) + give;
      out.push({ questId: q.id, itemId: o.target, qty: give });
    }
  }
  refreshQuests(p, content);
  return out;
}

export function applyRewards(p: ProfileState, content: ContentRegistry, r: RewardDef, tx: string): { levelUps: number } {
  if (r.credits) p.currency += r.credits;
  const before = p.level;
  if (r.exp) addExp(p, r.exp);
  for (const it of r.items ?? []) grantItems(p, content, it.itemId, it.qty, tx);
  for (const t of r.trust ?? []) {
    const st = p.traders[t.traderId];
    if (st) st.trust = Math.max(0, Math.min(1000, st.trust + t.amount));
  }
  for (const f of r.flags ?? []) setFlag(p, f);
  if (r.perkPoints) p.perkPoints += r.perkPoints;
  return { levelUps: p.level - before };
}

export function addExp(p: ProfileState, amount: number): number {
  const before = p.level;
  p.exp += Math.max(0, Math.round(amount));
  p.level = levelForExp(p.exp);
  const ups = p.level - before;
  if (ups > 0) {
    p.perkPoints += ups;
    pushLog(p, 'log.levelup', { level: p.level });
  }
  return ups;
}

export function setFlag(p: ProfileState, f: string): void {
  if (p.flags[f]) return;
  p.flags[f] = true;
  if (f === 'chapter1_complete') p.chapter.completed = true;
}

/** Turn in a ready quest at its giver. */
export function turnInQuest(p: ProfileState, content: ContentRegistry, questId: string, tx: string): { levelUps: number } {
  const q = content.quest(questId);
  const st = p.quests[questId];
  if (!st || st.status !== 'ready') fail('quest.err.not_ready');
  st!.status = 'completed';
  const res = applyRewards(p, content, q.rewards, tx);
  pushLog(p, 'log.quest.done', { name: q.nameKey });
  refreshQuests(p, content);
  p.chapter.act = currentAct(p, content);
  return res;
}

export function currentAct(p: ProfileState, content: ContentRegistry): number {
  let act = 0;
  for (const q of content.quests.values()) if (p.quests[q.id]?.status === 'completed' && !q.optional) act = Math.max(act, q.act + (q.id === 'core.quest.q08_last_signal' ? 1 : 0));
  if (act === 0 && p.quests['core.quest.q01_ready']?.status === 'completed') act = 1;
  return act;
}

export function activeQuestIds(p: ProfileState): string[] {
  return Object.entries(p.quests)
    .filter(([, s]) => s.status === 'active' || s.status === 'ready')
    .map(([id]) => id);
}
