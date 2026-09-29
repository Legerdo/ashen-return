import type { ContentRegistry } from '../content/registry';
import type { AttachmentSlot, EquipSlot, ItemDef } from '../content/types';
import { dismantleItem, repairItem } from '../economy/crafting';
import { sellValue } from '../economy/trade';
import type { GameApp } from '../game/app';
import { bagContainerId, findFreeSpot, type ItemInstance, type ItemStore } from '../inventory/store';
import {
  attachToWeapon,
  detachFromWeapon,
  discardItem,
  equipProfileItem,
  fillMagazine,
  fillTube,
  loadWeapon,
  mergeProfileStacks,
  moveProfileItem,
  setQuickslot,
  splitProfileStack,
  toggleFavorite,
  unequipProfileItem,
  unloadMagazine,
  unloadWeapon,
} from '../progression/actions';
import { aggregatePerks, INCOMING, PLAYER, STASH } from '../progression/profile';
import { carriedContainerIds, player } from '../world/context';
import { h } from './dom';
import type { InvAdapter } from './inventoryView';

export function slotFor(def: ItemDef): EquipSlot | null {
  switch (def.kind) {
    case 'weapon':
      return def.weapon!.class === 'pistol' ? 'secondary' : 'primary1';
    case 'melee':
      return 'melee';
    case 'armor':
      return def.armor!.slot;
    case 'backpack':
      return 'backpack';
    case 'accessory':
      return 'accessory';
    default:
      return null;
  }
}

function stat(label: string, value: string, cls = ''): HTMLElement {
  return h('div', { class: cls }, h('span', { class: 'muted' }, `${label} `), value);
}

export function describeItem(content: ContentRegistry, store: ItemStore, it: ItemInstance, extra: { sell?: number; compare?: ItemInstance | null } = {}): HTMLElement {
  const d = content.item(it.definitionId);
  const root = h('div', null, h('h4', null, content.t(d.nameKey)), h('div', { class: 'muted' }, content.t(d.descKey)));
  const rows: HTMLElement[] = [];
  if (d.weapon) {
    const w = d.weapon;
    const cmp = extra.compare ? content.item(extra.compare.definitionId).weapon : null;
    const diff = (a: number, b: number | undefined, higherBetter = true) => (b === undefined ? '' : a === b ? '' : (a > b) === higherBetter ? ' ▲' : ' ▼');
    rows.push(stat('피해', `${w.damage}${w.pellets > 1 ? `×${w.pellets}` : ''}${diff(w.damage * w.pellets, cmp ? cmp.damage * cmp.pellets : undefined)}`));
    rows.push(stat('RPM', `${w.rpm}${diff(w.rpm, cmp?.rpm)}`));
    rows.push(stat('탄창', `${w.capacity}${w.magazineFamily ? '' : ' (튜브)'}`));
    rows.push(stat('유효/최대 거리', `${w.effectiveRange}/${w.maxRange}u${diff(w.effectiveRange, cmp?.effectiveRange)}`));
    rows.push(stat('정밀 산포', `${w.precisionSpreadDeg}°${diff(w.precisionSpreadDeg, cmp?.precisionSpreadDeg, false)}`));
    rows.push(stat('반동', `${w.recoilDeg}°${diff(w.recoilDeg, cmp?.recoilDeg, false)}`));
    rows.push(stat('장전', w.tube ? '튜브식 (0.4 + 0.55/발 + 0.35s)' : `${w.reloadTactical}/${w.reloadEmpty}s`));
    rows.push(stat('구경', content.t(`cal.${w.caliber}`)));
    rows.push(stat('내구도', `${Math.round(it.durability ?? 100)}%`));
    const mag = it.weapon?.magazineId ? store.items[it.weapon.magazineId] : null;
    rows.push(stat('장전 상태', `약실 ${it.weapon?.chamber ? 1 : 0} · ${mag ? `탄창 ${mag.mag?.rounds.length ?? 0}` : it.weapon?.tube ? `튜브 ${it.weapon.tube.length}` : '탄창 없음'}`));
    const atts = Object.entries(it.attachments).map(([, id]) => (id && store.items[id] ? content.t(content.item(store.items[id]!.definitionId).nameKey) : '')).filter(Boolean);
    if (atts.length) rows.push(stat('부착물', atts.join(', ')));
  }
  if (d.ammo) rows.push(stat('생체/관통/방어구손상', `×${d.ammo.fleshMult} / ${d.ammo.penetration} / ×${d.ammo.armorDamage}`), stat('환경 관통 에너지', String(d.ammo.envEnergy)));
  if (d.magazine) rows.push(stat('장탄', `${it.mag?.rounds.length ?? 0}/${d.magazine.capacity}${it.mag && it.mag.rounds.length ? ` (${content.t(content.item(it.mag.rounds[it.mag.rounds.length - 1]!).nameKey)})` : ''}`));
  if (d.armor) rows.push(stat('방어값', String(d.armor.rating)), stat('내구도', `${Math.round(it.durability ?? 0)}/${d.armor.maxDurability}`), stat('보호 부위', d.armor.slot === 'helmet' ? '머리' : '몸통'));
  if (d.medical?.type === 'firstaid') rows.push(stat('치료 잔량', `${Math.round(it.medPool ?? 40)}/40`));
  if (d.backpack) rows.push(stat('칸', `${d.backpack.w}×${d.backpack.h}`));
  rows.push(stat('무게', `${(d.weightKg * (d.stackMax > 1 && !d.unitWeightKg ? it.quantity : 1) + (d.unitWeightKg ?? 0) * it.quantity).toFixed(2)}kg`));
  if (extra.sell !== undefined) rows.push(stat('판매가', `${extra.sell}cr`));
  if (it.modifiers.includes('relief')) rows.push(h('div', { class: 'warn' }, '구제 장비 — 판매·분해 가치 0'));
  if (d.kind === 'quest') rows.push(h('div', { class: 'warn' }, '임무 아이템'));
  root.append(h('div', { class: 'kv', style: 'display:block;margin-top:6px' }, ...rows));
  return root;
}

// --- shelter adapter --------------------------------------------------------------------------------------------

export function profileAdapter(app: GameApp, onChange: () => void): InvAdapter {
  const content = app.content;
  const tx = (label: string, fn: Parameters<GameApp['tx']>[1]) =>
    void app.tx(`${label}:${app.nextNonce()}`, fn).then(() => onChange());
  const P = () => app.profile!;
  const bagId = () => {
    const bag = P().store.containers[`eq:${PLAYER}:backpack`]?.items[0];
    return bag ? bagContainerId(bag) : null;
  };
  const eqOf = (slot: EquipSlot) => P().store.containers[`eq:${PLAYER}:${slot}`]?.items[0] ?? null;
  const adapter: InvAdapter = {
    content,
    store: () => P().store,
    move: (id, target) => tx('move', (d) => moveProfileItem(d, content, id, target)),
    equip: (id, slot) => {
      const def = content.item(P().store.items[id]!.definitionId);
      // Primary weapons may go to either primary slot: dropping onto slot 2 keeps slot 2.
      const s = def.kind === 'weapon' && def.weapon!.class !== 'pistol' && (slot === 'primary1' || slot === 'primary2') ? slot : slot;
      tx('equip', (d) => equipProfileItem(d, content, id, s));
    },
    merge: (a, b) => tx('merge', (d) => mergeProfileStacks(d, content, a, b)),
    quickMove: (id) => {
      const it = P().store.items[id];
      if (!it) return;
      const bag = bagId();
      if (it.ownerContainerId === bag) tx('qmove', (d) => moveProfileItem(d, content, id, { containerId: STASH }));
      else if (it.ownerContainerId === STASH || it.ownerContainerId === INCOMING || it.ownerContainerId === 'shelf') {
        if (bag) tx('qmove', (d) => moveProfileItem(d, content, id, { containerId: bag }));
      } else if (it.ownerContainerId?.startsWith('eq:')) tx('unequip', (d) => unequipProfileItem(d, content, it.ownerContainerId!.split(':')[2] as EquipSlot));
    },
    primaryAction: (id) => {
      const it = P().store.items[id];
      if (!it) return;
      const def = content.item(it.definitionId);
      const slot = slotFor(def);
      if (slot && !it.ownerContainerId?.startsWith('eq:')) {
        const s = def.kind === 'weapon' && def.weapon!.class !== 'pistol' && eqOf('primary1') && !eqOf('primary2') ? 'primary2' : slot;
        tx('equip', (d) => equipProfileItem(d, content, id, s));
      } else if (def.magazine) tx('fill', (d) => fillMagazine(d, content, id, null));
    },
    contextActions: (id) => {
      const p = P();
      const it = p.store.items[id];
      if (!it) return [];
      const def = content.item(it.definitionId);
      const acts: { label: string; run: () => void; danger?: boolean }[] = [];
      const slot = slotFor(def);
      const equipped = it.ownerContainerId?.startsWith('eq:');
      if (equipped) acts.push({ label: '장착 해제', run: () => tx('unequip', (d) => unequipProfileItem(d, content, it.ownerContainerId!.split(':')[2] as EquipSlot)) });
      else if (slot) {
        acts.push({ label: slot === 'primary1' ? '주무기 1에 장착' : '장착', run: () => tx('equip', (d) => equipProfileItem(d, content, id, slot)) });
        if (slot === 'primary1') acts.push({ label: '주무기 2에 장착', run: () => tx('equip', (d) => equipProfileItem(d, content, id, 'primary2')) });
      }
      if (def.magazine) {
        const cals = new Set<string>();
        for (const o of Object.values(p.store.items)) {
          const od = content.item(o.definitionId);
          if (od.ammo?.caliber === def.magazine.caliber) cals.add(od.id);
        }
        for (const a of cals) acts.push({ label: `탄창 채우기: ${content.t(content.item(a).nameKey)}`, run: () => tx('fill', (d) => fillMagazine(d, content, id, a)) });
        if ((it.mag?.rounds.length ?? 0) > 0) acts.push({ label: '탄창 비우기', run: () => tx('unload', (d) => unloadMagazine(d, content, id, `unload:${id}`)) });
        // Insert into a compatible weapon without a magazine.
        for (const w of Object.values(p.store.items)) {
          const wd = content.item(w.definitionId).weapon;
          if (wd?.magazineFamily === def.magazine.family && !w.weapon?.magazineId) acts.push({ label: `${content.t(content.item(w.definitionId).nameKey)}에 삽입`, run: () => tx('load', (d) => loadWeapon(d, content, w.instanceId, id)) });
        }
      }
      if (def.weapon) {
        if (it.weapon?.magazineId || it.weapon?.chamber || it.weapon?.tube?.length) acts.push({ label: '탄 빼기', run: () => tx('unloadw', (d) => unloadWeapon(d, content, id, `unloadw:${id}`)) });
        if (it.weapon?.tube) acts.push({ label: '튜브 채우기', run: () => tx('tube', (d) => fillTube(d, content, id)) });
        for (const [s, aid] of Object.entries(it.attachments) as [AttachmentSlot, string][]) if (aid) acts.push({ label: `부착물 분리: ${content.t(content.item(p.store.items[aid]!.definitionId).nameKey)}`, run: () => tx('detach', (d) => detachFromWeapon(d, content, id, s)) });
        const repairable = (it.durability ?? 100) < 100;
        if (repairable) acts.push({ label: '수리 (수리 키트)', run: () => tx('repair', (d) => repairItem(d, content, id, aggregatePerks(content, d.perks).repairMult ?? 1, `repair:${id}`)) });
      }
      if (def.attachment) {
        for (const w of Object.values(p.store.items)) {
          const wd = content.item(w.definitionId).weapon;
          if (wd?.attachmentSlots.includes(def.attachment.slot) && !w.attachments[def.attachment.slot]) acts.push({ label: `${content.t(content.item(w.definitionId).nameKey)}에 부착`, run: () => tx('attach', (d) => attachToWeapon(d, content, w.instanceId, id)) });
        }
      }
      if (def.armor && (it.durability ?? 0) < def.armor.maxDurability) acts.push({ label: '수리 (수리 키트)', run: () => tx('repair', (d) => repairItem(d, content, id, aggregatePerks(content, d.perks).repairMult ?? 1, `repair:${id}`)) });
      if ((def.medical || def.throwable) && it.ownerContainerId === bagId()) for (let i = 0; i < 4; i++) acts.push({ label: `퀵슬롯 ${i + 4}에 지정`, run: () => tx('qs', (d) => setQuickslot(d, content, i, id)) });
      if (def.stackMax > 1 && it.quantity > 1) {
        acts.push({
          label: '절반 나누기',
          run: () => {
            const cont = p.store.containers[it.ownerContainerId!];
            if (!cont) return;
            const spot = cont.kind === 'grid' ? findFreeSpot(p.store, content, cont, def) : null;
            tx('split', (d) => splitProfileStack(d, content, id, Math.floor(it.quantity / 2), spot ? { containerId: cont.id, x: spot.x, y: spot.y, rotation: spot.rotation } : { containerId: STASH }));
          },
        });
      }
      if (def.dismantle && !equipped && it.containedItems.length === 0 && def.kind !== 'quest') acts.push({ label: `분해 → ${def.dismantle.map((o) => `${content.t(content.item(o.itemId).nameKey)} ${o.qty}`).join(', ')}`, run: () => tx('dismantle', (d) => dismantleItem(d, content, id, `dismantle:${id}`)) });
      acts.push({ label: it.lockTags.includes('favorite') ? '즐겨찾기 해제' : '즐겨찾기 잠금', run: () => tx('fav', (d) => toggleFavorite(d, id)) });
      if (def.kind !== 'quest' && !it.lockTags.includes('favorite')) acts.push({ label: '버리기', danger: true, run: () => { if (window.confirm(`${content.t(def.nameKey)}을(를) 버리시겠습니까? 되돌릴 수 없습니다.`)) tx('discard', (d) => discardItem(d, content, id, `discard:${id}`)); } });
      return acts;
    },
    isHidden: () => false,
    canDrag: () => true,
    describe: (id) => {
      const p = P();
      const it = p.store.items[id]!;
      const def = content.item(it.definitionId);
      const cmp = def.weapon ? (eqOf(def.weapon.class === 'pistol' ? 'secondary' : 'primary1') ? p.store.items[eqOf(def.weapon.class === 'pistol' ? 'secondary' : 'primary1')!] ?? null : null) : null;
      return describeItem(content, p.store, it, { sell: sellValue(p, content, id, 0), compare: cmp && cmp !== it ? cmp : null });
    },
  };
  return adapter;
}

// --- raid adapter -----------------------------------------------------------------------------------------------

export function raidAdapter(app: GameApp): InvAdapter {
  const content = app.content;
  const sim = () => app.ctx!.sim;
  const bag = () => {
    const pl = player(sim());
    return carriedContainerIds(sim(), pl).find((c) => c.startsWith('bag:')) ?? null;
  };
  const loot = () => sim().loot?.containerId ?? null;
  return {
    content,
    store: () => sim().store,
    move: (id, target) => app.queueOp({ op: 'move', itemId: id, target }),
    equip: (id, slot) => app.queueOp({ op: 'equip', itemId: id, slot }),
    merge: (a, b) => app.queueOp({ op: 'merge', fromId: a, toId: b }),
    quickMove: (id) => {
      const it = sim().store.items[id];
      if (!it) return;
      const b = bag();
      const l = loot();
      if (l && it.ownerContainerId === l && b) app.queueOp({ op: 'move', itemId: id, target: { containerId: b } });
      else if (l && b && it.ownerContainerId === b) app.queueOp({ op: 'move', itemId: id, target: { containerId: l } });
    },
    primaryAction: (id) => {
      const it = sim().store.items[id];
      if (!it) return;
      const def = content.item(it.definitionId);
      const l = loot();
      if (l && it.ownerContainerId === l) {
        const slot = slotFor(def);
        const b = bag();
        if (slot && !sim().store.containers[`eq:player:${slot}`]?.items.length) app.queueOp({ op: 'equip', itemId: id, slot });
        else if (b) app.queueOp({ op: 'move', itemId: id, target: { containerId: b } });
        return;
      }
      if (def.medical || def.throwable) app.queueOp({ op: 'use', itemId: id });
      else if (def.magazine) {
        const ammo = Object.values(sim().store.items).find((o) => content.item(o.definitionId).ammo?.caliber === def.magazine!.caliber && carriedContainerIds(sim(), player(sim())).includes(o.ownerContainerId ?? ''));
        if (ammo) app.queueOp({ op: 'loadMag', magId: id, ammoDefId: ammo.definitionId });
      } else {
        const slot = slotFor(def);
        if (slot) app.queueOp({ op: 'equip', itemId: id, slot });
      }
    },
    contextActions: (id) => {
      const s = sim();
      const it = s.store.items[id];
      if (!it) return [];
      const def = content.item(it.definitionId);
      const acts: { label: string; run: () => void; danger?: boolean }[] = [];
      const carried = [...carriedContainerIds(s, player(s)), ...['primary1', 'primary2', 'secondary', 'melee', 'helmet', 'vest', 'backpack', 'accessory'].map((x) => `eq:player:${x}`)].includes(it.ownerContainerId ?? '');
      const b = bag();
      if (!carried && b) acts.push({ label: '가방에 넣기', run: () => app.queueOp({ op: 'move', itemId: id, target: { containerId: b } }) });
      if (def.medical || def.throwable) acts.push({ label: def.medical ? '사용' : '던지기', run: () => app.queueOp({ op: 'use', itemId: id }) });
      const slot = slotFor(def);
      if (slot) acts.push({ label: '장착', run: () => app.queueOp({ op: 'equip', itemId: id, slot }) });
      if (slot === 'primary1') acts.push({ label: '주무기 2에 장착', run: () => app.queueOp({ op: 'equip', itemId: id, slot: 'primary2' }) });
      if (def.magazine && carried) {
        const seen = new Set<string>();
        for (const o of Object.values(s.store.items)) {
          const od = content.item(o.definitionId);
          if (od.ammo?.caliber === def.magazine.caliber && carriedContainerIds(s, player(s)).includes(o.ownerContainerId ?? '') && !seen.has(od.id)) {
            seen.add(od.id);
            acts.push({ label: `탄창 채우기 (0.2초/발): ${content.t(od.nameKey)}`, run: () => app.queueOp({ op: 'loadMag', magId: id, ammoDefId: od.id }) });
          }
        }
        if ((it.mag?.rounds.length ?? 0) > 0) acts.push({ label: '탄창 비우기', run: () => app.queueOp({ op: 'unloadMag', magId: id }) });
      }
      if ((def.medical || def.throwable) && carried) for (let i = 0; i < 4; i++) acts.push({ label: `퀵슬롯 ${i + 4}에 지정`, run: () => app.queueOp({ op: 'quickslot', index: i, itemId: id }) });
      if (def.stackMax > 1 && it.quantity > 1 && carried && b) {
        const cont = s.store.containers[b]!;
        acts.push({ label: '절반 나누기', run: () => {
          const spot = findFreeSpot(s.store, content, cont, def);
          if (spot) app.queueOp({ op: 'split', itemId: id, qty: Math.floor(it.quantity / 2), target: { containerId: b, x: spot.x, y: spot.y, rotation: spot.rotation } });
        } });
      }
      if (carried && def.kind !== 'backpack') acts.push({ label: '버리기 (바닥)', danger: true, run: () => app.queueOp({ op: 'drop', itemId: id }) });
      return acts;
    },
    isHidden: (cid, id) => {
      const s = sim();
      const wc = s.containers[cid];
      if (!wc) return false;
      const c = s.store.containers[cid];
      const idx = c ? c.items.indexOf(id) : -1;
      return idx >= wc.searched;
    },
    canDrag: (id) => {
      const s = sim();
      const it = s.store.items[id];
      if (!it) return false;
      const wc = it.ownerContainerId ? s.containers[it.ownerContainerId] : undefined;
      if (!wc) return true;
      const c = s.store.containers[wc.id]!;
      return c.items.indexOf(id) < wc.searched && !wc.locked;
    },
    describe: (id) => describeItem(content, sim().store, sim().store.items[id]!),
  };
}
