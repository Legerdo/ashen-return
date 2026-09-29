import { Q05_LOW_POI, Q05_ZONE_POI } from '../content/maps/shelter';
import type { ContentRegistry } from '../content/registry';
import { countDef } from '../inventory/store';
import { homeContainers, type ProfileState } from './profile';
import { objDone } from './quests';

/**
 * "Where do I go next?" in the shelter, derived from profile state only (pure, deterministic):
 *   report   — a quest is ready: turn it in at its giver.
 *   deliver  — home storage holds everything a Deliver objective still needs (and it was extracted, if required).
 *   talk     — an active main-line quest asks to talk to an NPC.
 *   range    — an active main-line quest asks for a shooting-range drill.
 *   contract — a repeatable contract is complete: claim it at the mission board.
 * The HUD turns these into NPC head markers, off-screen edge arrows and toasts; the NPC panel does the actual work.
 */
export type GuideKind = 'report' | 'deliver' | 'talk' | 'range' | 'contract' | 'drill';

export interface QuestGuide {
  kind: GuideKind;
  /** Quest id, or the contract offer id for kind 'contract'. */
  questId: string;
  /** Target NPC (report / deliver / talk). */
  npcId: string | null;
  /** Target shelter interactable / POI id (range → 'poi.range', contract → 'st.board', drill → its drill spot). */
  placeId: string | null;
  itemId?: string;
  /** Marker label override (drill: what to do at that spot). */
  labelKey?: string;
}

/** Optional range drills: where each drill objective is done and what the marker says there. */
const DRILL_SPOTS: Record<string, { placeId: string; labelKey: string }> = {
  range_wall_block: { placeId: Q05_ZONE_POI, labelKey: 'guide.mark.q05_wall' },
  range_low_cover: { placeId: Q05_LOW_POI, labelKey: 'guide.mark.q05_low' },
};

/**
 * Markers for unfinished optional shooting-range drills (Q05's wall / low-cover spots). Pure, from profile state; the
 * app shows them only while the player is inside the range, so they never clutter the shelter hall.
 */
export function rangeDrillGuides(p: ProfileState, content: ContentRegistry): QuestGuide[] {
  const out: QuestGuide[] = [];
  for (const q of content.quests.values()) {
    const st = p.quests[q.id];
    if (!q.optional || st?.status !== 'active') continue;
    for (const o of q.objectives) {
      const spot = o.type === 'CustomValidated' && o.target ? DRILL_SPOTS[o.target] : undefined;
      if (!spot || objDone(p, q, o)) continue;
      out.push({ kind: 'drill', questId: q.id, npcId: null, placeId: spot.placeId, labelKey: spot.labelKey });
    }
  }
  return out;
}

export const RANGE_POI = 'poi.range';
export const BOARD_STATION = 'st.board';

/** Stable identity of a guide (used to notice newly appeared guidance). */
export function guideKey(g: QuestGuide): string {
  return `${g.kind}|${g.questId}|${g.npcId ?? g.placeId ?? ''}|${g.itemId ?? ''}`;
}

export function shelterGuides(p: ProfileState, content: ContentRegistry): QuestGuide[] {
  const out: QuestGuide[] = [];
  const mainLine = new Set(content.chapters.get('core.chapter.1')?.mainLine ?? []);
  for (const q of content.quests.values()) {
    const st = p.quests[q.id];
    if (!st) continue;
    if (st.status === 'ready') {
      out.push({ kind: 'report', questId: q.id, npcId: q.giver, placeId: null });
      continue;
    }
    if (st.status !== 'active') continue;
    for (const o of q.objectives) {
      if (objDone(p, q, o)) continue;
      if (o.type === 'Deliver' && o.npcId && o.target) {
        const needsExtract = q.objectives.find((x) => x.type === 'ExtractWith' && x.target === o.target);
        if (needsExtract && !objDone(p, q, needsExtract)) continue;
        const need = o.count - (st.progress[o.id] ?? 0);
        if (countDef(p.store, o.target, homeContainers(p)) >= need) out.push({ kind: 'deliver', questId: q.id, npcId: o.npcId, placeId: null, itemId: o.target });
        continue;
      }
      if (!mainLine.has(q.id) || q.optional) continue;
      if (o.type === 'Interact' && o.target) {
        const npcId = content.map('core.map.shelter').interactables.find((i) => i.id === o.target)?.npcId ?? null;
        if (npcId) out.push({ kind: 'talk', questId: q.id, npcId, placeId: null });
      } else if (o.type === 'CustomValidated' && o.target?.startsWith('range_')) {
        out.push({ kind: 'range', questId: q.id, npcId: null, placeId: RANGE_POI });
      }
    }
  }
  for (const ct of p.contracts.offers) if (ct.status === 'ready') out.push({ kind: 'contract', questId: ct.id, npcId: null, placeId: BOARD_STATION });
  return out;
}

/** One toast line per newly appeared guide that asks the player to go somewhere (report / deliver / contract). */
export function guideToast(g: QuestGuide, content: ContentRegistry): string | null {
  const npc = g.npcId ? content.t(content.npc(g.npcId).nameKey) : '';
  if (g.kind === 'report') return content.t('guide.toast.report', { quest: content.t(content.quest(g.questId).nameKey), npc });
  if (g.kind === 'deliver' && g.itemId) return content.t('guide.toast.deliver', { item: content.t(content.item(g.itemId).nameKey), npc });
  if (g.kind === 'contract') return content.t('guide.toast.contract');
  return null;
}
