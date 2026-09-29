import { describe, expect, it } from 'vitest';
import { createContent } from '../src/content/core';
import { destroyItem } from '../src/inventory/store';
import { ensureContracts } from '../src/progression/contracts';
import { BOARD_STATION, guideKey, guideToast, RANGE_POI, shelterGuides } from '../src/progression/guidance';
import { grantItems, newProfile, type ProfileState } from '../src/progression/profile';
import { applyQuestEvent, turnInQuest } from '../src/progression/quests';
import { edgePoint, onScreen } from '../src/ui/guide';

const content = createContent();
const Q01 = 'core.quest.q01_ready';
const Q02 = 'core.quest.q02_first_haul';
const RELIEF = 'core.quest.relief_package';
const fresh = (seed: string): ProfileState => newProfile(content, 1, 'Guide', seed, 0);
const kinds = (p: ProfileState) => shelterGuides(p, content).map((g) => `${g.kind}:${g.npcId ?? g.placeId}`);

describe('shelter guidance: who to go to next', () => {
  it('Q01 onboarding points at the mechanic and the range, then at the mechanic to report', () => {
    const p = fresh('guide-q01');
    expect(kinds(p)).toEqual(['talk:core.npc.mechanic', `range:${RANGE_POI}`]);
    // Onboarding hints never toast; only "go report / deliver" does.
    for (const g of shelterGuides(p, content)) expect(guideToast(g, content)).toBeNull();
    applyQuestEvent(p, content, { type: 'Interact', target: 'npc.mechanic' });
    expect(kinds(p)).toEqual([`range:${RANGE_POI}`]);
    applyQuestEvent(p, content, { type: 'Custom', target: 'range_reload', amount: 1 });
    expect(p.quests[Q01]!.status).toBe('ready');
    const guides = shelterGuides(p, content);
    expect(guides.map((g) => `${g.kind}:${g.npcId}`)).toEqual(['report:core.npc.mechanic']);
    const text = guideToast(guides[0]!, content)!;
    expect(text).toContain('정비공 부엉');
    expect(text).toContain('보고');
    expect(text).toContain('Q01');
  });

  it('a delivery is pointed out only once the item is extracted and home storage holds all that is needed', () => {
    let p = fresh('guide-q02');
    applyQuestEvent(p, content, { type: 'Interact', target: 'npc.mechanic' });
    applyQuestEvent(p, content, { type: 'Custom', target: 'range_reload', amount: 1 });
    turnInQuest(p, content, Q01, 'guide:q01');
    expect(p.quests[Q02]!.status).toBe('active');
    applyQuestEvent(p, content, { type: 'Retrieve', itemId: RELIEF });
    grantItems(p, content, RELIEF, 1, 'guide:held');
    expect(kinds(p), 'found but not extracted yet').toEqual([]);
    applyQuestEvent(p, content, { type: 'ExtractWith', itemId: RELIEF, qty: 1, mapId: 'core.map.quarantine_main' });
    const g = shelterGuides(p, content);
    expect(g.map((x) => `${x.kind}:${x.npcId}:${x.itemId}`)).toEqual([`deliver:core.npc.medic:${RELIEF}`]);
    expect(guideToast(g[0]!, content)).toContain('의무관 백로');
    expect(guideToast(g[0]!, content)).toContain(content.t(content.item(RELIEF).nameKey));
    p = structuredClone(p);
    for (const id of Object.keys(p.store.items)) if (p.store.items[id]?.definitionId === RELIEF) destroyItem(p.store, id);
    expect(kinds(p), 'item no longer in home storage').toEqual([]);
  });

  it('partial material deliveries are not announced until the full amount is at home (Q06: 4 scrap)', () => {
    const p = fresh('guide-q06');
    p.quests['core.quest.q06_scrap'] = { status: 'active', progress: {} };
    grantItems(p, content, 'core.mat.scrap', 3, 'guide:scrap3');
    expect(kinds(p).filter((k) => k.startsWith('deliver'))).toEqual([]);
    grantItems(p, content, 'core.mat.scrap', 1, 'guide:scrap4');
    expect(kinds(p).filter((k) => k.startsWith('deliver'))).toEqual(['deliver:core.npc.mechanic']);
  });

  it('a finished repeatable contract points at the mission board; guide keys are stable', () => {
    const p = fresh('guide-ct');
    p.flags['deploy_allowed'] = true;
    p.quests[Q01] = { status: 'completed', progress: {} };
    ensureContracts(p, content);
    const offer = p.contracts.offers[0]!;
    offer.status = 'ready';
    const g = shelterGuides(p, content).find((x) => x.kind === 'contract')!;
    expect(g.placeId).toBe(BOARD_STATION);
    expect(guideToast(g, content)).toContain('임무 게시판');
    expect(guideKey(g)).toBe(guideKey(shelterGuides(p, content).find((x) => x.kind === 'contract')!));
  });
});

describe('off-screen edge arrow placement', () => {
  // Inset box centre: (320, 166).
  const box = { x0: 26, y0: 30, x1: 614, y1: 302 };
  it('pins the arrow where the ray from the box centre towards the target leaves the inset view box', () => {
    const r = edgePoint({ x: 320, y: 166 }, { x: 1320, y: 166 }, box);
    expect(r.x).toBeCloseTo(614, 9);
    expect(r.y).toBeCloseTo(166, 9);
    expect(r.angle).toBeCloseTo(0, 9);
    const l = edgePoint({ x: 320, y: 166 }, { x: -680, y: 66 }, box);
    expect(l.x).toBeCloseTo(26, 9);
    expect(l.y).toBeCloseTo(166 - (294 / 1000) * 100, 9);
    const up = edgePoint({ x: 320, y: 166 }, { x: 320, y: -500 }, box);
    expect(up.x).toBeCloseTo(320, 9);
    expect(up.y).toBeCloseTo(30, 9);
    expect(up.angle).toBeCloseTo(-Math.PI / 2, 9);
    const corner = edgePoint({ x: 320, y: 166 }, { x: 5000, y: 5000 }, box);
    expect(corner.y).toBeCloseTo(302, 9);
    expect(corner.x).toBeLessThanOrEqual(614);
  });
  it('a player near a view corner (camera clamped at the map border) still gets the arrow on the facing border', () => {
    // Target to the right, a little below the HUD-reserved band: the arrow sits on the right border, not in a corner.
    const r = edgePoint({ x: 30, y: 340 }, { x: 900, y: 355 }, box);
    expect(r.x).toBeCloseTo(614, 9);
    expect(r.y).toBeGreaterThan(166);
    expect(r.y).toBeLessThan(302);
    expect(Math.cos(r.angle)).toBeGreaterThan(0.99); // pointing right, from the player
  });
  it('on-screen test keeps a small margin inside the 640×360 view', () => {
    expect(onScreen(320, 180)).toBe(true);
    expect(onScreen(5, 180)).toBe(false);
    expect(onScreen(320, 355)).toBe(false);
  });
});
