import type { ContentRegistry } from '../content/registry';
import type { EquipSlot, ItemDef } from '../content/types';
import { buildingCost, footprintOf, moveBuilding, placeBuilding, upgradeFacility, validatePlacement } from '../economy/buildings';
import { cancelCraft, craftSpeed, hasBuilding, recipeBlocker, recipeTime, startCraft } from '../economy/crafting';
import { buyFromMarket, buyFromTrader, ensureMarket, ensureTraderStock, marketUnlocked, sellItems, sellValue, stockLines, TRUST_TIERS } from '../economy/trade';
import type { GameApp } from '../game/app';
import { bagContainerId, countDef } from '../inventory/store';
import { claimRelief, canClaimRelief, healAtShelter, healCost, markNoteRead, perkBlocker, registerKey, restoreGenerator, sortHomeContainer, unlockPerk } from '../progression/actions';
import { acceptContract, abandonContract, deliverContract, ensureContracts, MAX_ACTIVE_CONTRACTS, turnInContract } from '../progression/contracts';
import { EXP_TABLE, homeContainers, INCOMING, PLAYER, SECURE_POCKET, SHELF, STASH, type ProfileState } from '../progression/profile';

const SECURE_POCKET_TITLE = '시크릿 포켓 — 사망해도 잃지 않음';
import { shelterGuides } from '../progression/guidance';
import { deliverToNpc, turnInQuest } from '../progression/quests';
import { forecastFor } from '../progression/raidFlow';
import { groupThreat, raidThreat } from '../world/threat';
import { ACTIONS, isBindable, type Action } from '../presentation/input';
import { RANGE_PRESETS } from '../world/range';
import { carriedWeightKg } from '../world/movement';
import { btn, fmtCredits, fmtTime, h } from './dom';
import { itemIcon } from './icons';
import { containerView, slotView, type InvAdapter } from './inventoryView';
import { profileAdapter, raidAdapter } from './adapters';

export interface UiCtx {
  app: GameApp;
  content: ContentRegistry;
  invalidate(): void;
  close(): void;
  state: Record<string, string>;
}

const T = (u: UiCtx, key: string, params?: Record<string, string | number>) => u.content.t(key, params);

function panel(u: UiCtx, title: string, body: (HTMLElement | null)[], opts: { size?: 'narrow' | 'mid'; foot?: HTMLElement[]; tabs?: HTMLElement; testid?: string } = {}): HTMLElement {
  const p = h(
    'div',
    { class: `panel ${opts.size ?? ''}`, role: 'dialog', attrs: { 'aria-modal': 'true', 'aria-label': title, ...(opts.testid ? { 'data-testid': opts.testid } : {}) } },
    h('div', { class: 'panel-head' }, h('h2', null, title), btn('닫기 (Esc)', () => u.close(), { class: 'small', testid: 'panel-close' })),
    opts.tabs ?? null,
    h('div', { class: 'panel-body' }, ...body),
    opts.foot && opts.foot.length ? h('div', { class: 'panel-foot' }, ...opts.foot) : null,
  );
  return h('div', { class: 'overlay', onclick: (e) => {
    if (e.target === e.currentTarget) u.close();
  } }, p);
}

function tabs(u: UiCtx, key: string, entries: [string, string][], def: string): { el: HTMLElement; active: string } {
  const active = u.state[key] ?? def;
  const el = h('div', { class: 'tabs', role: 'tablist' }, ...entries.map(([id, label]) => {
    const b = btn(label, () => {
      u.state[key] = id;
      u.invalidate();
    }, { class: `tab small ${active === id ? 'active' : ''}`, testid: `tab-${id}` });
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(active === id));
    return b;
  }));
  return { el, active };
}

function itemLine(u: UiCtx, defId: string, right: (HTMLElement | string | null)[], sub?: string): HTMLElement {
  const d = u.content.item(defId);
  return h('div', { class: 'line-item' }, h('img', { attrs: { alt: '', src: itemIcon(d) } }), h('div', { class: 'grow' }, h('div', null, T(u, d.nameKey)), sub ? h('div', { class: 'hint' }, sub) : null), ...right);
}

async function run(u: UiCtx, txId: string, fn: (d: ProfileState) => unknown, ok?: string): Promise<boolean> {
  const r = await u.app.tx(txId, fn, ok);
  u.invalidate();
  return r.ok && r.applied;
}

// ------------------------------------------------------------------------------------------------ shelter inventory

export function stashPanel(u: UiCtx, opts: { shelf?: boolean } = {}): HTMLElement {
  const app = u.app;
  const p = app.profile!;
  const t = tabs(u, 'invTab', [['stash', '창고·장비'], ['perks', '성장 (Perk)'], ['quests', '임무'], ['notes', '기록']], 'stash');
  let body: HTMLElement;
  if (t.active === 'perks') body = perksView(u);
  else if (t.active === 'quests') body = questsView(u);
  else if (t.active === 'notes') body = notesView(u);
  else body = loadoutView(u, profileAdapter(app, () => u.invalidate()), opts.shelf ?? false);
  return panel(u, `창고와 장비 — ${fmtCredits(p.currency)}`, [body], { tabs: t.el, testid: 'panel-stash' });
}

function equipmentColumn(adapter: InvAdapter, prefix: string): HTMLElement {
  const slots: EquipSlot[] = ['primary1', 'primary2', 'secondary', 'melee', 'helmet', 'vest', 'backpack', 'accessory'];
  return h('div', { class: 'col' }, h('div', { class: 'grid-title' }, '장비'), h('div', { class: 'slots-grid', style: 'grid-template-columns: repeat(2, auto)' }, ...slots.map((s) => slotView(adapter, `eq:${prefix}:${s}`, s))));
}

function loadoutView(u: UiCtx, adapter: InvAdapter, shelf: boolean): HTMLElement {
  const p = u.app.profile!;
  const bag = p.store.containers[`eq:${PLAYER}:backpack`]?.items[0];
  const incoming = p.store.containers[INCOMING]!;
  const weight = (() => {
    let kg = 0;
    const ids = [...Object.values(p.store.items)].filter((i) => i.ownerContainerId?.startsWith('eq:') || (bag && i.ownerContainerId === bagContainerId(bag)));
    for (const it of ids) {
      const d = u.content.item(it.definitionId);
      kg += d.weightKg * (d.stackMax > 1 && !d.unitWeightKg ? it.quantity : 1) + (d.unitWeightKg ?? 0) * it.quantity;
    }
    return kg;
  })();
  // Category filter (dims non-matching items everywhere in this view) and stable sort for the home grids.
  const filter = u.state['invFilter'] ?? 'all';
  const cat = INV_FILTERS.find((f) => f[0] === filter) ?? INV_FILTERS[0]!;
  const matches = filter === 'all' ? undefined : (d: ItemDef) => cat[2].includes(d.kind);
  const filterSel = h('select', { attrs: { 'aria-label': '분류 필터', 'data-testid': 'inv-filter' }, onchange: (e) => {
    u.state['invFilter'] = (e.target as HTMLSelectElement).value;
    u.invalidate();
  } }, ...INV_FILTERS.map(([id, label]) => {
    const o = h('option', { value: id }, label);
    if (id === filter) o.selected = true;
    return o;
  }));
  const sortBtn = (cid: string, testid: string) => btn('정렬', () => void run(u, `sort:${cid}:${u.app.nextNonce()}`, (d) => sortHomeContainer(d, u.content, cid), 'inv.sorted'), { class: 'small', testid, title: '종류 → 큰 것 → 이름 순으로 다시 배치합니다. 즐겨찾기(★) 물건은 제자리에 둡니다.' });
  return h(
    'div',
    null,
    h('div', { class: 'inv-tools' }, h('span', { class: 'muted' }, '분류'), filterSel),
    h(
      'div',
      { class: 'cols' },
      equipmentColumn(adapter, PLAYER),
      h('div', { class: 'col' }, bag ? containerView(adapter, bagContainerId(bag), `가방 — 장비 무게 약 ${weight.toFixed(1)}kg`, undefined, matches) : h('div', { class: 'muted' }, '가방 없음'), p.store.containers[SECURE_POCKET] ? containerView(adapter, SECURE_POCKET, SECURE_POCKET_TITLE, undefined, matches) : null, h('div', { class: 'hint' }, 'Shift+클릭: 빠른 이동 · 더블클릭: 장착/채우기 · 우클릭: 메뉴 · 드래그 중 R: 회전')),
      h('div', { class: 'col' }, containerView(adapter, STASH, `창고 (${p.store.containers[STASH]!.w}×${p.store.containers[STASH]!.h})`, sortBtn(STASH, 'sort-stash'), matches), incoming.items.length ? containerView(adapter, INCOMING, `보관 대기함 ${incoming.items.length}개 — 창고에 빈칸이 생기면 옮기세요`, undefined, matches) : null, (shelf || p.store.containers[SHELF]) && p.store.containers[SHELF] ? containerView(adapter, SHELF, '보급 선반', sortBtn(SHELF, 'sort-shelf'), matches) : null),
    ),
  );
}

/** Stash/bag category filter: [id, label, kinds]. */
const INV_FILTERS: [string, string, ItemDef['kind'][]][] = [
  ['all', '전체', []],
  ['weapons', '무기·부착물', ['weapon', 'attachment', 'melee']],
  ['ammo', '탄약·탄창', ['ammo', 'magazine']],
  ['armor', '방어구·가방', ['armor', 'backpack', 'accessory']],
  ['medical', '의료·투척', ['medical', 'throwable']],
  ['materials', '재료·도구', ['material', 'tool']],
  ['valuables', '귀중품', ['valuable']],
  ['quest', '임무·열쇠', ['quest', 'key']],
];

// ------------------------------------------------------------------------------------------------ perks / quests / notes

function perksView(u: UiCtx): HTMLElement {
  const p = u.app.profile!;
  const lines: ['survival' | 'carry' | 'combat', string][] = [['survival', '생존'], ['carry', '운반·탐색'], ['combat', '전투·정비']];
  const next = EXP_TABLE[p.level] ?? null;
  return h(
    'div',
    null,
    h('div', { class: 'card' }, `레벨 ${p.level} · EXP ${p.exp}${next ? ` / 다음 ${next}` : ' (최대)'} · 남은 Perk 포인트 ${p.perkPoints}`),
    h(
      'div',
      { class: 'cols' },
      ...lines.map(([line, label]) =>
        h(
          'div',
          { class: 'col card', style: 'flex:1;min-width:240px' },
          h('h3', null, label),
          ...[...u.content.perks.values()].filter((x) => x.line === line).map((perk) => {
            const owned = p.perks.includes(perk.id);
            const blocker = perkBlocker(p, u.content, perk.id);
            return h('div', { class: 'line-item' }, h('div', { class: 'grow' }, h('div', null, T(u, perk.nameKey), owned ? h('span', { class: 'badge good', style: 'margin-left:6px' }, '보유') : null), h('div', { class: 'hint' }, `${T(u, perk.descKey)} · Lv.${perk.level} · ${perk.cost}pt${perk.requires.length ? ` · 선행: ${perk.requires.map((r) => T(u, u.content.perk(r).nameKey)).join(', ')}` : ''}`)), owned ? null : btn('해금', () => void run(u, `perk:${perk.id}`, (d) => unlockPerk(d, u.content, perk.id), 'perk.unlocked'), { class: 'small', disabled: !!blocker, title: blocker ? T(u, blocker) : '', testid: `perk-${perk.id}` }));
          }),
        ),
      ),
    ),
  );
}

export function questsView(u: UiCtx): HTMLElement {
  const p = u.app.profile!;
  const c = u.content;
  const items: HTMLElement[] = [];
  for (const q of c.quests.values()) {
    const st = p.quests[q.id];
    if (!st || st.status === 'locked') continue;
    const badge = st.status === 'completed' ? h('span', { class: 'badge good' }, '완료') : st.status === 'ready' ? h('span', { class: 'badge warn' }, `보고: ${T(u, c.npc(q.giver).nameKey)}`) : h('span', { class: 'badge' }, '진행 중');
    items.push(
      h(
        'div',
        { class: 'card' },
        h('h3', null, T(u, q.nameKey), ' ', badge),
        h('div', { class: 'hint' }, T(u, q.descKey)),
        ...q.objectives.map((o) => {
          const cur = st.progress[o.id] ?? 0;
          const done = cur >= o.count;
          return h('div', { class: done ? 'good' : '' }, `${done ? '■' : '□'} ${T(u, o.descKey)} ${o.count > 1 ? `(${Math.min(cur, o.count)}/${o.count})` : ''}`);
        }),
        h('div', { class: 'hint' }, `보상: ${[q.rewards.credits ? fmtCredits(q.rewards.credits) : '', q.rewards.exp ? `EXP ${q.rewards.exp}` : '', ...(q.rewards.items ?? []).map((i) => `${T(u, c.item(i.itemId).nameKey)} ×${i.qty}`), q.rewards.perkPoints ? `Perk +${q.rewards.perkPoints}` : ''].filter(Boolean).join(' · ')}`),
      ),
    );
  }
  const act = c.chapters.get('core.chapter.1')!.acts[Math.min(5, p.chapter.act)]!;
  return h('div', { class: 'list' }, h('div', { class: 'card' }, h('h3', null, T(u, act.nameKey)), h('div', { class: 'hint' }, T(u, act.descKey))), ...items);
}

function notesView(u: UiCtx): HTMLElement {
  const p = u.app.profile!;
  const c = u.content;
  const sel = u.state['note'];
  const list = [...c.notes.values()].map((n) => {
    const st = p.notes[n.id] ?? { found: false, read: false };
    return h('div', { class: 'line-item' }, h('div', { class: 'grow' }, st.found ? T(u, n.titleKey) : '??? (미발견)', h('div', { class: 'hint' }, T(u, c.map(n.mapId).nameKey))), st.found ? h('span', { class: `badge ${st.read ? 'good' : 'warn'}` }, st.read ? '읽음' : '새 기록') : null, st.found ? btn('읽기', () => {
      u.state['note'] = n.id;
      void run(u, `noteread:${n.id}`, (d) => markNoteRead(d, n.id));
    }, { class: 'small', testid: `note-${n.id}` }) : null);
  });
  const found = Object.values(p.notes).filter((n) => n.found).length;
  const keys = p.keys.registered.map((k) => T(u, c.key(k).nameKey));
  return h('div', { class: 'cols' }, h('div', { class: 'col', style: 'flex:1' }, h('div', { class: 'card' }, `발견한 기록 ${found}/${c.notes.size} · 등록된 열쇠 ${p.keys.registered.length}/${c.keys.size}${keys.length ? ` (${keys.join(', ')})` : ''}`), ...list), sel && p.notes[sel]?.found ? h('div', { class: 'col', style: 'flex:1.2' }, h('h3', null, T(u, c.note(sel).titleKey)), h('div', { class: 'note-text' }, T(u, c.note(sel).bodyKey))) : null);
}

// ------------------------------------------------------------------------------------------------ deploy

export function deployPanel(u: UiCtx): HTMLElement {
  const app = u.app;
  const p = app.profile!;
  const c = u.content;
  const sel = u.state['dest'] ?? 'core.dest.quarantine_main';
  // Enemy strength follows story progress (world/threat.ts); regions shift it (farm/canal lower, industrial higher).
  const threat = raidThreat((q) => p.quests[q]?.status === 'completed');
  const cards = [...c.destinations.values()].map((d) => {
    const unlocked = !d.unlockFlag || p.flags[d.unlockFlag];
    const f = forecastFor(structuredClone(p), c, d.id);
    const tiers = c.map(d.mapId).regions.map((r) => groupThreat(threat, r.lootTier));
    const lo = Math.min(...tiers);
    const hi = Math.max(...tiers);
    const strength = lo === hi ? T(u, `threat.tier.${hi}`) : `${T(u, `threat.tier.${lo}`)} ~ ${T(u, `threat.tier.${hi}`)}`;
    return h(
      'div',
      { class: `card ${sel === d.id ? 'active' : ''}`, style: `flex:1;min-width:260px;${sel === d.id ? 'border-color:var(--accent)' : ''}` },
      h('h3', null, T(u, d.nameKey), unlocked ? null : h('span', { class: 'badge bad', style: 'margin-left:6px' }, '잠김')),
      h('div', { class: 'hint' }, T(u, d.descKey)),
      h('div', { class: 'kv' }, h('span', { class: 'muted' }, '예보'), h('span', null, `${T(u, c.timePhase(f.phase).nameKey)} · ${T(u, c.weather(f.weather).nameKey)}`), h('span', { class: 'muted' }, '위험도'), h('span', null, '●'.repeat(d.risk) + '○'.repeat(5 - d.risk)), h('span', { class: 'muted' }, T(u, 'threat.label')), h('span', { attrs: { 'data-testid': `threat-${d.id}` } }, strength), h('span', { class: 'muted' }, '예상 시간'), h('span', null, T(u, d.durationHintKey))),
      unlocked ? btn(sel === d.id ? '선택됨' : '선택', () => {
        u.state['dest'] = d.id;
        u.invalidate();
      }, { class: 'small', testid: `dest-${d.id}` }) : h('div', { class: 'hint' }, d.unlockFlag === 'deploy_allowed' ? 'Q01을 완료해야 합니다' : 'Q03 완료 후 해금'),
    );
  });
  const loadout: string[] = [];
  for (const s of ['primary1', 'primary2', 'secondary', 'melee', 'helmet', 'vest', 'backpack'] as EquipSlot[]) {
    const id = p.store.containers[`eq:${PLAYER}:${s}`]?.items[0];
    if (id) loadout.push(T(u, c.item(p.store.items[id]!.definitionId).nameKey));
  }
  const dest = c.destination(sel);
  const warnings: HTMLElement[] = [];
  if (!p.flags['deploy_allowed']) warnings.push(h('div', { class: 'bad' }, '출격 허가가 없습니다. 정비공의 Q01을 먼저 완료하세요.'));
  if (p.lastDeathBag) {
    const same = p.lastDeathBag.mapId === dest.mapId;
    warnings.push(h('div', { class: 'warn', attrs: { 'data-testid': 'deathbag-warning' } }, same ? `이번 출격(${T(u, c.map(dest.mapId).nameKey)})에서 지난 사망 가방을 회수할 수 있습니다. 이번에 사망하면 이전 가방은 사라집니다.` : `회수 가능한 사망 가방이 ${T(u, c.map(p.lastDeathBag.mapId).nameKey)}에 있습니다. 다른 지역에서 사망하면 그 가방은 사라집니다.`));
  }
  const pocketN = p.store.containers[SECURE_POCKET]?.items.length ?? 0;
  warnings.push(h('div', { class: 'hint', attrs: { 'data-testid': 'deploy-pocket' } }, `사망 시 보존: 시크릿 포켓(${pocketN}개)과 기본 가방(안의 물건은 제외). 나머지 휴대품은 사망 가방으로 이동합니다.`));
  if (p.playerHp < 100 || p.playerBleeding) warnings.push(h('div', { class: 'warn' }, `현재 체력 ${p.playerHp}${p.playerBleeding ? ' · 출혈 중' : ''} — 의무관에게 치료받을 수 있습니다 (${fmtCredits(healCost(p))}).`));
  if (!loadout.some((l) => l)) warnings.push(h('div', { class: 'warn' }, '장착한 장비가 없습니다.'));
  const canGo = !!p.flags['deploy_allowed'] && (!dest.unlockFlag || !!p.flags[dest.unlockFlag]) && !app.busy;
  return panel(
    u,
    '출격 준비',
    [
      h('div', { class: 'cols' }, ...cards),
      h('div', { class: 'hint', attrs: { 'data-testid': 'threat-hint' } }, T(u, 'threat.hint')),
      h('div', { class: 'card' }, h('h3', null, '휴대 장비'), h('div', null, loadout.join(' · ') || '없음'), h('div', { class: 'hint' }, '출격하면 장착 장비와 가방이 격리구역으로 이동합니다. 사망 시 사망 가방으로 옮겨지고, 계정 화폐·창고·성장은 유지됩니다.')),
      ...warnings,
    ],
    { foot: [btn('장비 정리', () => app.openPanel('station:stash', 'stash'), { class: '' }), btn(app.busy ? '출격 중…' : '출격', () => void app.deploy(sel), { class: 'primary', disabled: !canGo, testid: 'deploy-go' })], testid: 'panel-deploy' },
  );
}

// ------------------------------------------------------------------------------------------------ NPC

export function npcPanel(u: UiCtx, npcId: string): HTMLElement {
  const app = u.app;
  const c = u.content;
  const npc = c.npc(npcId);
  const p = app.profile!;
  const traderId = npc.traderId;
  ensureTraderStock(structuredClone(p), c, traderId);
  const tr = p.traders[traderId]!;
  const tier = TRUST_TIERS.filter((x) => tr.trust >= x).length - 1;
  const t = tabs(u, `npc:${npcId}`, [['talk', '대화·임무'], ['buy', '구매'], ['sell', '판매'], ['special', npcId.endsWith('mechanic') ? '정비·구제' : npcId.endsWith('medic') ? '치료' : '열쇠 등록']], 'talk');
  let body: HTMLElement;
  if (t.active === 'buy') {
    const lines = stockLines(p.traders[traderId]!.generation === p.generation ? p : (() => {
      const d = structuredClone(p);
      ensureTraderStock(d, c, traderId);
      return d;
    })(), c, traderId);
    body = h('div', { class: 'list' }, ...lines.map((l) => {
      const def = c.item(l.itemId);
      const unit = def.kind === 'ammo' ? Math.min(l.qty, def.stackMax) : 1;
      const soldOut = !l.locked && l.qty <= 0;
      return itemLine(u, l.itemId, [h('span', { class: 'muted' }, l.locked ? T(u, l.locked) + (l.minTrust ? ` (신뢰 ${l.minTrust})` : '') : soldOut ? '품절' : `재고 ${l.qty}`), h('span', null, soldOut ? '—' : fmtCredits(l.price * Math.max(1, unit))), btn(soldOut ? '품절' : unit > 1 ? `${unit}개 구매` : '구매', () => {
        const txId = `buy:${traderId}:${l.itemId}:${app.nextNonce()}`;
        void run(u, txId, (d) => buyFromTrader(d, c, traderId, l.itemId, unit, txId), 'trade.bought');
      }, { class: 'small', disabled: !!l.locked || soldOut || l.qty < unit || p.currency < l.price * unit, testid: `buy-${l.itemId}` })], def.kind === 'ammo' ? `발당 ${l.price}cr` : undefined);
    }));
  } else if (t.active === 'sell') {
    const ids = homeContainers(p).flatMap((cid) => p.store.containers[cid]?.items ?? []).filter((id) => {
      const it = p.store.items[id];
      if (!it) return false;
      const d = c.item(it.definitionId);
      return c.trader(traderId).buysKinds.includes(d.kind) && d.kind !== 'quest';
    });
    body = h('div', { class: 'list' }, h('div', { class: 'hint' }, '창고·보관 대기함의 물건만 팔 수 있습니다. 즐겨찾기 잠금된 물건은 팔리지 않습니다. 판매가 = 상태 보정가의 35%.'), ...ids.map((id) => {
      const it = p.store.items[id]!;
      const v = sellValue(p, c, id, tr.trust);
      return itemLine(u, it.definitionId, [h('span', { class: 'muted' }, it.quantity > 1 ? `×${it.quantity}` : ''), h('span', null, fmtCredits(v)), btn('판매', () => void run(u, `sell:${id}`, (d) => sellItems(d, c, traderId, [id], `sell:${id}`), 'trade.sold'), { class: 'small', disabled: v <= 0 || it.lockTags.includes('favorite'), testid: `sell-${it.definitionId}` })]);
    }));
  } else if (t.active === 'special') {
    body = specialView(u, npcId);
  } else {
    const ready = [...c.quests.values()].filter((q) => q.giver === npcId && p.quests[q.id]?.status === 'ready');
    const deliverable = [...c.quests.values()].filter((q) => p.quests[q.id]?.status === 'active' && q.objectives.some((o) => o.type === 'Deliver' && o.npcId === npcId && (p.quests[q.id]!.progress[o.id] ?? 0) < o.count && countDef(p.store, o.target!, homeContainers(p)) > 0));
    const greet = T(u, npc.greetingKeys[p.generation % npc.greetingKeys.length]!);
    body = h(
      'div',
      { class: 'list' },
      h('div', { class: 'card' }, h('h3', null, `${T(u, npc.nameKey)} · ${T(u, npc.roleKey)}`), h('div', null, `“${greet}”`), h('div', { class: 'hint' }, `신뢰도 ${tr.trust}/1000 · 단계 ${tier + 1}/4`)),
      ...deliverable.map((q) => h('div', { class: 'line-item' }, h('div', { class: 'grow' }, `${T(u, q.nameKey)} — 물건 전달`), btn('전달', () => void run(u, `deliver:${npcId}:${app.nextNonce()}`, (d) => deliverToNpc(d, c, npcId), 'quest.delivered'), { class: 'small primary', testid: `deliver-${q.id}` }))),
      ...ready.map((q) => h('div', { class: 'line-item' }, h('div', { class: 'grow' }, `${T(u, q.nameKey)} — 완료 보고`), btn('보고', async () => {
        const ok = await run(u, `quest:${q.id}:complete`, (d) => {
          const r = turnInQuest(d, c, q.id, `quest:${q.id}:complete`);
          // Unlocks granted by the reward (contracts after Q01, the black market after Q07) are offered right away,
          // not only after the next shelter entry. Both are deterministic per (seed, generation) and idempotent.
          ensureContracts(d, c);
          ensureMarket(d, c);
          return r;
        }, 'quest.completed');
        if (ok) {
          app.toast(T(u, q.completeDialogKey), 'good', 7000);
          app.audio.play('ui.quest');
          if (q.id === c.chapters.get('core.chapter.1')!.finalQuest) app.openPanel('chapter', null);
          else if (q.rewards.flags?.includes('workbench_unlocked') || q.rewards.flags?.includes('power_restored')) app.rebuildBase();
        }
      }, { class: 'small primary', testid: `turnin-${q.id}` }))),
      questsView(u),
    );
  }
  return panel(u, `${T(u, npc.nameKey)} — ${fmtCredits(p.currency)}`, [body], { tabs: t.el, testid: `panel-npc-${npcId}` });
}

function specialView(u: UiCtx, npcId: string): HTMLElement {
  const app = u.app;
  const p = app.profile!;
  const c = u.content;
  if (npcId.endsWith('medic')) {
    const cost = healCost(p);
    return h('div', { class: 'list' }, h('div', { class: 'card' }, `현재 체력 ${p.playerHp}/100${p.playerBleeding ? ' · 출혈' : ''}`), btn(`치료 받기 (${fmtCredits(cost)})`, () => void run(u, `heal:${app.nextNonce()}`, (d) => healAtShelter(d), 'med.healed'), { class: 'primary', disabled: p.playerHp >= 100 && !p.playerBleeding, testid: 'heal' }), h('div', { class: 'hint' }, '의료대 개선을 완료하면 기본 치료가 무료가 됩니다.'));
  }
  if (npcId.endsWith('mechanic')) {
    const eligible = canClaimRelief(p, c);
    return h('div', { class: 'list' }, h('div', { class: 'card' }, h('h3', null, '구제 장비'), h('div', { class: 'hint' }, '무기가 하나도 없고 1,000cr 미만일 때 한 세대에 한 번 받을 수 있습니다. 판매·분해 가치는 0입니다.'), btn('구제 장비 받기', () => void run(u, `relief:${p.generation}`, (d) => claimRelief(d, c, `relief:${p.generation}`), 'relief.claimed'), { class: 'primary', disabled: !eligible, testid: 'relief' })), h('div', { class: 'hint' }, '수리와 분해는 작업대에서 할 수 있습니다.'));
  }
  const keyItems = homeContainers(p).flatMap((cid) => p.store.containers[cid]?.items ?? []).filter((id) => c.item(p.store.items[id]!.definitionId).kind === 'key');
  return h('div', { class: 'list' }, h('div', { class: 'hint' }, '열쇠를 등록하면 아이템은 소모되고, 이후 해당 문을 열쇠 없이 열 수 있습니다. 같은 열쇠를 다시 등록해도 변화가 없습니다.'), ...keyItems.map((id) => {
    const it = p.store.items[id]!;
    const keyId = c.item(it.definitionId).keyId!;
    const done = p.keys.registered.includes(keyId);
    return itemLine(u, it.definitionId, [done ? h('span', { class: 'badge good' }, '이미 등록됨') : null, btn('등록', () => void run(u, `key:${keyId}`, (d) => registerKey(d, c, id, `key:${keyId}`), 'key.registered'), { class: 'small primary', disabled: done, testid: `register-${keyId}` })]);
  }), keyItems.length === 0 ? h('div', { class: 'muted' }, '창고에 등록할 열쇠가 없습니다.') : null, h('div', { class: 'card' }, `등록된 접근권: ${p.keys.registered.map((k) => T(u, c.key(k).nameKey)).join(', ') || '없음'}`));
}

// ------------------------------------------------------------------------------------------------ board (quests + contracts)

export function boardPanel(u: UiCtx): HTMLElement {
  const app = u.app;
  const p = app.profile!;
  const c = u.content;
  const t = tabs(u, 'board', [['contracts', '반복 계약'], ['quests', '주 임무']], 'contracts');
  if (t.active === 'quests') return panel(u, '임무 게시판', [questsView(u)], { tabs: t.el, testid: 'panel-board' });
  const active = p.contracts.offers.filter((x) => x.status === 'active' || x.status === 'ready').length;
  const rows = p.contracts.offers.map((ct) => {
    const tpl = c.contract(ct.templateId);
    const params = Object.fromEntries(Object.entries(ct.params).map(([k, v]) => [k, typeof v === 'string' && c.has(v) ? c.t(v) : typeof v === 'string' && v.startsWith('poi.') ? c.t(v) : v]));
    const desc = c.t(tpl.descKey, params as Record<string, string | number>);
    const acts: HTMLElement[] = [];
    if (ct.status === 'offered') acts.push(btn('수락', () => void run(u, `ctaccept:${ct.id}`, (d) => acceptContract(d, ct.id), 'contract.accepted'), { class: 'small', disabled: active >= MAX_ACTIVE_CONTRACTS, testid: `ct-accept-${ct.templateId}` }));
    if (ct.status === 'active') {
      if (ct.objective.type === 'Deliver') acts.push(btn('전달', () => void run(u, `ctdeliver:${ct.id}:${app.nextNonce()}`, (d) => deliverContract(d, ct.id), 'quest.delivered'), { class: 'small', testid: `ct-deliver-${ct.templateId}` }));
      acts.push(btn('포기', () => void run(u, `ctabandon:${ct.id}:${app.nextNonce()}`, (d) => abandonContract(d, ct.id)), { class: 'small danger' }));
    }
    if (ct.status === 'ready') acts.push(btn('보상 받기', () => void run(u, `ctdone:${ct.id}`, (d) => turnInContract(d, ct.id), 'contract.done'), { class: 'small primary', testid: `ct-done-${ct.templateId}` }));
    return h('div', { class: 'line-item' }, h('div', { class: 'grow' }, h('div', null, T(u, tpl.nameKey), ' ', h('span', { class: `badge ${ct.status === 'ready' ? 'good' : ct.status === 'active' ? 'warn' : ''}` }, ct.status === 'offered' ? '제안' : ct.status === 'active' ? `진행 ${ct.progress}/${ct.objective.count}` : '완료 가능')), h('div', { class: 'hint' }, `${desc} · 보상 ${fmtCredits(ct.rewardCredits)}, EXP ${ct.rewardExp}, 신뢰 +${ct.trust}`)), ...acts);
  });
  return panel(u, '임무 게시판 — 반복 계약', [h('div', { class: 'hint' }, `동시에 ${MAX_ACTIVE_CONTRACTS}개까지 추적할 수 있습니다 (현재 ${active}). 제안 목록은 출격할 때마다 새로 바뀌며, 불러오기로 다시 뽑히지 않습니다.`), ...(rows.length ? rows : [h('div', { class: 'muted' }, p.flags['deploy_allowed'] ? '이번 제안은 모두 처리했습니다. 다음 출격 뒤에 새 계약이 올라옵니다.' : 'Q01을 완료하면 계약이 열립니다.')])], { tabs: t.el, testid: 'panel-board' });
}

// ------------------------------------------------------------------------------------------------ crafting / repair

export function craftPanel(u: UiCtx, station: 'workbench' | 'medical'): HTMLElement {
  const app = u.app;
  const p = app.profile!;
  const c = u.content;
  const recipes = [...c.recipes.values()].filter((r) => r.station === station);
  const job = p.crafting.jobs.find((j) => j.station === station);
  const list = recipes.map((r) => {
    const blocker = recipeBlocker(p, c, r.id);
    const ins = r.inputs.map((i) => `${T(u, c.item(i.itemId).nameKey)} ${countDef(p.store, i.itemId, homeContainers(p))}/${i.qty}`).join(' · ');
    return itemLine(u, r.output.itemId, [h('span', { class: 'muted' }, `${recipeTime(p, c, r.id).toFixed(1)}초 · 수수료 ${r.fee}cr`), btn('제작', () => void run(u, `craft:${r.id}:${app.nextNonce()}`, (d) => startCraft(d, c, r.id), 'craft.started'), { class: 'small', disabled: !!blocker, title: blocker ? T(u, blocker) : '', testid: `craft-${r.id}` })], `${ins}${r.requiresBuilding && !hasBuilding(p, r.requiresBuilding) ? ` · 필요: ${T(u, c.building(r.requiresBuilding).nameKey)}` : ''}`);
  });
  const jobView = job ? h('div', { class: 'card' }, `${T(u, c.recipe(job.recipeId).nameKey)} 제작 중 — ${job.remaining.toFixed(1)}초 남음`, h('div', { class: 'progress' }, h('div', { style: `width:${(1 - job.remaining / job.total) * 100}%` })), btn('취소 (재료 반환)', () => void run(u, `craftcancel:${job.jobId}`, (d) => cancelCraft(d, c, job.jobId)), { class: 'small danger' })) : h('div', { class: 'hint' }, `재료는 제작 시작 시 예약되고 완료 시 한 번 소비됩니다. 거점이 일시정지되거나 창이 숨겨지면 시간이 흐르지 않습니다.${station === 'workbench' ? ` 작업대 속도 ×${craftSpeed(p)}` : ''}`);
  const extra = station === 'workbench' ? h('div', { class: 'hint' }, '수리·분해: 창고 화면에서 아이템을 우클릭하세요 (수리 키트 필요).') : healBox(u);
  return panel(u, station === 'workbench' ? '작업대' : '의료대', [jobView, ...list, extra], { size: 'mid', testid: `panel-craft-${station}` });
}

function healBox(u: UiCtx): HTMLElement {
  const p = u.app.profile!;
  return h('div', { class: 'card' }, `체력 ${p.playerHp}/100 · 치료비 ${fmtCredits(healCost(p))}`, btn('치료', () => void run(u, `heal:${u.app.nextNonce()}`, (d) => healAtShelter(d), 'med.healed'), { class: 'small', disabled: p.playerHp >= 100 && !p.playerBleeding }));
}

// ------------------------------------------------------------------------------------------------ construction & facilities

export function buildPanel(u: UiCtx): HTMLElement {
  const app = u.app;
  const p = app.profile!;
  const c = u.content;
  const map = c.map('core.map.shelter');
  const zone = map.buildZone!;
  const selB = u.state['bld'] ?? '';
  const rot = (Number(u.state['rot'] ?? '0') as 0 | 1) ?? 0;
  const cell = 26;
  const grid = h('div', { class: 'build-grid', style: `width:${zone.w * cell}px;height:${zone.h * cell}px`, attrs: { 'aria-label': '건설 구역 격자' } });
  const hover = u.state['hover'] ? u.state['hover'].split(',').map(Number) : null;
  const moving = u.state['moveGuid'] ?? '';
  const preview = selB && hover ? validatePlacement(p, c, map, selB, hover[0]!, hover[1]!, rot, moving || null) : null;
  const fpPrev = selB && hover ? footprintOf(c, { buildingId: selB, x: hover[0]!, y: hover[1]!, rot }) : null;
  for (let yy = 0; yy < zone.h; yy++)
    for (let xx = 0; xx < zone.w; xx++) {
      const gx = zone.x + xx;
      const gy = zone.y + yy;
      let cls = 'build-cell';
      if (zone.reserved.some((r) => gx >= r.x && gx < r.x + r.w && gy >= r.y && gy < r.y + r.h)) cls += ' reserved';
      const b = p.buildings.find((o) => {
        const f = footprintOf(c, o);
        return gx >= f.x && gx < f.x + f.w && gy >= f.y && gy < f.y + f.h;
      });
      if (b && b.guid !== moving) cls += ' building';
      if (fpPrev && gx >= fpPrev.x && gx < fpPrev.x + fpPrev.w && gy >= fpPrev.y && gy < fpPrev.y + fpPrev.h) cls += preview ? ' preview-bad' : ' preview-ok';
      const cellEl = h('div', { class: cls, style: `left:${xx * cell}px;top:${yy * cell}px;width:${cell}px;height:${cell}px`, data: { bx: String(gx), by: String(gy) }, title: b ? T(u, c.building(b.buildingId).nameKey) : `${gx},${gy}` });
      cellEl.addEventListener('pointerenter', () => {
        // Re-rendering replaces the cells under a still pointer; only redraw when the hovered cell actually changes.
        if (!selB || u.state['hover'] === `${gx},${gy}`) return;
        u.state['hover'] = `${gx},${gy}`;
        u.invalidate();
      });
      cellEl.addEventListener('click', () => {
        if (!selB) return;
        if (moving) void run(u, `bldmove:${moving}:${app.nextNonce()}`, (d) => moveBuilding(d, c, map, moving, gx, gy, rot), 'build.moved').then((ok) => ok && app.rebuildBase());
        else void run(u, `build:${selB}`, (d) => placeBuilding(d, c, map, selB, gx, gy, rot), 'build.placed').then((ok) => ok && app.rebuildBase());
        u.state['bld'] = '';
        u.state['moveGuid'] = '';
      });
      grid.append(cellEl);
    }
  const blds = [...c.buildings.values()].map((b) => {
    const placed = p.buildings.find((x) => x.buildingId === b.id);
    const locked = b.unlockFlag && !p.flags[b.unlockFlag];
    const cost = buildingCost(p, b.id, c);
    const costTxt = `${fmtCredits(cost.credits)}${cost.items.length ? ` + ${cost.items.map((i) => `${T(u, c.item(i.itemId).nameKey)} ${countDef(p.store, i.itemId, homeContainers(p))}/${i.qty}`).join(', ')}` : ''}`;
    return h('div', { class: 'line-item' }, h('div', { class: 'grow' }, h('div', null, T(u, b.nameKey), placed ? h('span', { class: 'badge good', style: 'margin-left:6px' }, '설치됨') : locked ? h('span', { class: 'badge bad', style: 'margin-left:6px' }, '잠김') : null), h('div', { class: 'hint' }, `${T(u, b.descKey)} · ${b.footprint.w}×${b.footprint.h} · ${costTxt}`)), placed ? btn('옮기기', () => {
      u.state['bld'] = b.id;
      u.state['moveGuid'] = placed.guid;
      u.invalidate();
    }, { class: 'small' }) : btn(selB === b.id ? '배치할 칸을 클릭' : '배치', () => {
      u.state['bld'] = b.id;
      u.state['moveGuid'] = '';
      u.invalidate();
    }, { class: 'small primary', disabled: !!locked, testid: `build-${b.id}` }));
  });
  const facs = [...c.facilities.values()].map((f) => {
    const done = (p.facilities[f.id] ?? 0) > 0;
    const blocked = (f.requiresFlag && !p.flags[f.requiresFlag]) || (f.requiresBuilding && !p.buildings.some((b) => b.buildingId === f.requiresBuilding));
    return h('div', { class: 'line-item' }, h('div', { class: 'grow' }, h('div', null, T(u, f.nameKey), done ? h('span', { class: 'badge good', style: 'margin-left:6px' }, '완료') : null), h('div', { class: 'hint' }, `${T(u, f.descKey)} · ${fmtCredits(f.cost)}${f.requiresBuilding ? ` · 필요: ${T(u, c.building(f.requiresBuilding).nameKey)}` : ''}${f.requiresFlag ? ' · 전력 복구 필요' : ''}`)), done ? null : btn('개선', () => void run(u, `facility:${f.id}`, (d) => upgradeFacility(d, c, f.id), 'facility.done'), { class: 'small', disabled: !!blocked || p.currency < f.cost, testid: `facility-${f.id}` }));
  });
  return panel(
    u,
    `건설 — ${fmtCredits(p.currency)}`,
    [
      h('div', { class: 'cols' }, h('div', { class: 'col' }, grid, h('div', { class: 'hint' }, selB ? `${T(u, c.building(selB).nameKey)} ${rot ? '(회전)' : ''}: ${preview ? T(u, preview) : '배치 가능'}` : '건물을 고른 뒤 격자를 클릭하세요. 입구·단말·동선을 막는 배치는 거부됩니다.'), btn(`회전 (${rot ? '90°' : '0°'})`, () => {
        u.state['rot'] = rot ? '0' : '1';
        u.invalidate();
      }, { class: 'small' })), h('div', { class: 'col', style: 'flex:1;min-width:320px' }, h('h3', null, '건물'), ...blds, h('h3', null, '시설 개선'), ...facs)),
    ],
    { testid: 'panel-build' },
  );
}

// ------------------------------------------------------------------------------------------------ market, generator, power

export function marketPanel(u: UiCtx): HTMLElement {
  const app = u.app;
  const p = app.profile!;
  const c = u.content;
  if (!marketUnlocked(p, c)) return panel(u, '무전기', [h('div', { class: 'muted' }, '잡음뿐이다. 전력과 통신을 복구하면(Q07) 블랙마켓 주파수가 잡힌다.')], { size: 'narrow', testid: 'panel-market' });
  const view = p.market.generation === p.generation && p.market.offers.length ? p : (() => {
    const d = structuredClone(p);
    ensureMarket(d, c);
    return d;
  })();
  const rows = view.market.offers.map((o) => {
    const def = c.item(o.itemId);
    const unit = def.kind === 'ammo' ? Math.min(o.qty, def.stackMax) : 1;
    const soldOut = o.qty <= 0;
    return itemLine(u, o.itemId, [h('span', { class: 'muted' }, soldOut ? '품절' : `남은 수량 ${o.qty}`), h('span', null, soldOut ? '—' : fmtCredits(o.price * unit)), btn(soldOut ? '품절' : unit > 1 ? `${unit}개 구매` : '구매', () => {
      const txId = `bm:${o.offerId}:${app.nextNonce()}`;
      void run(u, txId, (d) => {
        ensureMarket(d, c);
        return buyFromMarket(d, c, o.offerId, unit, txId);
      }, 'trade.bought');
    }, { class: 'small', disabled: soldOut || o.qty < unit || p.currency < o.price * unit, testid: `bm-${o.itemId}` })]);
  });
  return panel(u, `블랙마켓 — 세대 ${view.market.generation} · ${fmtCredits(p.currency)}`, [h('div', { class: 'hint' }, '물건은 출격할 때마다 바뀝니다. 메뉴를 다시 열거나 불러와도 목록은 그대로입니다.'), ...rows], { size: 'mid', testid: 'panel-market' });
}

export function generatorPanel(u: UiCtx): HTMLElement {
  const app = u.app;
  const p = app.profile!;
  const c = u.content;
  const hasModule = p.buildings.some((b) => b.buildingId === 'core.building.power_comms');
  const relay = countDef(p.store, 'core.quest.relay_module', homeContainers(p));
  const done = !!p.flags['generator_restored'];
  return panel(
    u,
    '발전기',
    [
      h('div', { class: 'card' }, done ? h('div', { class: 'good' }, '발전기가 돌고 있다. 대피소에 불이 들어왔다.') : h('div', null, '중계부가 끊긴 발전기. 발전·통신 모듈과 중계 모듈이 있으면 되살릴 수 있다.')),
      h('div', { class: 'kv' }, h('span', { class: 'muted' }, '발전·통신 모듈'), h('span', { class: hasModule ? 'good' : 'bad' }, hasModule ? '설치됨' : '없음 (건설 단말)'), h('span', { class: 'muted' }, '중계 모듈'), h('span', { class: relay ? 'good' : 'bad' }, relay ? `${relay}개 보유` : '없음 (작업대에서 제작)')),
    ],
    { size: 'narrow', foot: [btn('중계 모듈 연결', () => void run(u, 'generator:restore', (d) => restoreGenerator(d, c, 'generator:restore'), 'gen.restored'), { class: 'primary', disabled: done || !hasModule || relay < 1, testid: 'generator-restore' })], testid: 'panel-generator' },
  );
}

// ------------------------------------------------------------------------------------------------ range

/** Human-readable first collision of a shot-log entry (target label, obstacle profile name, ground, miss). */
function firstHitLabel(u: UiCtx, firstHit: string): string {
  if (firstHit === 'none') return '빗나감 (사거리 소멸)';
  if (firstHit === 'ground') return '지면';
  if (firstHit === 'pending') return '비행 중';
  if (firstHit.startsWith('actor:dummy-')) return `표적 ${firstHit.slice('actor:dummy-'.length)}`;
  if (firstHit.startsWith('actor:')) return firstHit.slice(6);
  if (firstHit.startsWith('obstacle:')) {
    const ob = u.app.ctx?.geo.byId.get(firstHit.slice(9));
    return ob ? `${MATERIAL_KO[ob.profile.material] ?? ob.profile.material} 엄폐물` : firstHit.slice(9);
  }
  return firstHit;
}

const MATERIAL_KO: Record<string, string> = { concrete: '콘크리트', brick: '벽돌', wood: '목재', metal: '철판', glass: '유리', vegetation: '수풀', sandbag: '모래주머니', fabric: '천', flesh: '생체', dirt: '흙', water: '물' };

export function rangePanel(u: UiCtx, kind: 'rack' | 'terminal'): HTMLElement {
  const app = u.app;
  const c = u.content;
  const sim = app.ctx!.sim;
  if (kind === 'rack') {
    const weapons = [...c.items.values()].filter((d) => d.kind === 'weapon');
    return panel(u, T(u, 'range.rack.title'), [h('div', { class: 'hint' }, T(u, 'range.rack.desc')), ...weapons.map((d) => itemLine(u, d.id, [btn('대여', () => {
      app.rentRangeWeapon(d.id);
      void app.tx(`rangeweapon:${app.nextNonce()}`, (p) => {
        p.rangeWeapon = d.id;
      });
      u.close();
    }, { class: 'small', testid: `rack-${d.id.split('.').pop()}` })], `${d.weapon!.damage}${d.weapon!.pellets > 1 ? `×${d.weapon!.pellets}` : ''} 피해 · ${d.weapon!.rpm} RPM`))], { size: 'mid', testid: 'panel-rack' });
  }
  const r = sim.range!;
  const log = sim.shotLog.slice(-10).reverse();
  return panel(
    u,
    T(u, 'range.terminal.title'),
    [
      h('div', { class: 'hint' }, T(u, 'range.terminal.desc')),
      h('div', { class: 'cols' }, ...RANGE_PRESETS.map((pr) => btn(T(u, `range.preset.${pr}`), () => {
        app.queueOp({ op: 'rangePreset', preset: pr });
        u.invalidate();
      }, { class: `small ${r.preset === pr ? 'primary' : ''}`, testid: `preset-${pr}` }))),
      h('div', { class: 'card' }, T(u, 'range.stats', { head: r.headHits, wall: r.wallBlocks, low: r.lowCoverHits, reload: r.reloads })),
      h('h3', null, T(u, 'range.shotlog')),
      h('table', { class: 'stat-table' }, h('tr', null, ...['shot', '무기/탄', '첫 충돌', '부위', '거리', 'raw', '방어구 전', '손실', '계산', '실제'].map((x) => h('th', null, x))), ...log.map((l) => h('tr', null, h('td', null, l.shotId.split('-').pop() ?? ''), h('td', null, `${l.weaponId.split('.').pop()} / ${l.ammoId.split('.').slice(-2).join('.')}`), h('td', null, firstHitLabel(u, l.firstHit)), h('td', null, l.part === 'head' ? '머리' : l.part === 'body' ? '몸' : l.part === 'limb' ? '다리' : '-'), h('td', null, l.range.toFixed(2)), h('td', null, l.rawDamage.toFixed(2)), h('td', null, l.armorBefore === null ? '-' : l.armorBefore.toFixed(1)), h('td', null, l.armorLoss.toFixed(2)), h('td', null, l.calculatedHPDamage.toFixed(3)), h('td', null, l.actualHPLoss.toFixed(3))))),
    ],
    { testid: 'panel-terminal' },
  );
}

// ------------------------------------------------------------------------------------------------ raid inventory / loot / note / map

export function raidInventoryPanel(u: UiCtx, lootId: string | null): HTMLElement {
  const app = u.app;
  const sim = app.ctx!.sim;
  const c = u.content;
  const adapter = raidAdapter(app);
  const pl = sim.actors.find((a) => a.kind === 'player')!;
  const bag = sim.store.containers[`eq:player:backpack`]?.items[0];
  const kg = carriedWeightKg(app.ctx!, pl);
  const cols: HTMLElement[] = [equipmentColumn(adapter, 'player'), h('div', { class: 'col' }, bag ? containerView(adapter, bagContainerId(bag), `가방 — ${kg.toFixed(1)}kg`) : h('div', { class: 'muted' }, '가방 없음'), sim.store.containers[SECURE_POCKET] && !sim.training ? containerView(adapter, SECURE_POCKET, SECURE_POCKET_TITLE) : null, h('div', { class: 'hint' }, 'Shift+클릭: 빠른 이동 · 더블클릭: 사용/장착 · 우클릭: 메뉴. 인벤토리를 열어도 시간은 흐릅니다.'))];
  if (lootId) {
    const wc = sim.containers[lootId];
    const sc = sim.store.containers[lootId];
    if (wc && sc) {
      const name = c.has(wc.nameKey) ? c.t(wc.nameKey) : wc.nameKey;
      const total = sc.items.length;
      const status = wc.searched < total ? `검색 중… ${wc.searched}/${total}` : `${total}개`;
      cols.push(h('div', { class: 'col' }, containerView(adapter, lootId, `${name} — ${status}`, btn('모두 가방에', () => app.queueOp({ op: 'takeAll' }), { class: 'small', testid: 'take-all' }))));
    }
  }
  return panel(u, lootId ? '전리품' : '인벤토리', [h('div', { class: 'cols' }, ...cols)], { testid: lootId ? 'panel-loot' : 'panel-inventory' });
}

export function notePanel(u: UiCtx, noteId: string): HTMLElement {
  const c = u.content;
  const app = u.app;
  if (app.mode === 'raid') app.queueOp({ op: 'readNote', noteId });
  return panel(u, T(u, c.note(noteId).titleKey), [h('div', { class: 'note-text' }, T(u, c.note(noteId).bodyKey)), h('div', { class: 'hint' }, '기록은 발견 즉시 기록되며, 생환 여부와 관계없이 기록 보관함에 남습니다.')], { size: 'narrow', testid: 'panel-note' });
}

const mapCache = new Map<string, HTMLCanvasElement>();
export function mapPanel(u: UiCtx): HTMLElement {
  const app = u.app;
  const ctx = app.ctx!;
  const map = ctx.geo.map;
  const scale = map.width > 70 ? 6 : 8;
  // Procedural raids differ per layout seed: the cached base image is per (map, layout).
  const cacheKey = `${map.id}|${ctx.sim.layoutSeed ?? ''}`;
  let base = mapCache.get(cacheKey);
  if (!base) {
    base = document.createElement('canvas');
    base.width = map.width * scale;
    base.height = map.height * scale;
    const g = base.getContext('2d')!;
    for (let y = 0; y < map.height; y++)
      for (let x = 0; x < map.width; x++) {
        const gd = ctx.geo.grounds[map.ground[y * map.width + x] ?? 0]!;
        g.fillStyle = `#${gd.color.toString(16).padStart(6, '0')}`;
        g.fillRect(x * scale, y * scale, scale, scale);
      }
    for (const o of ctx.geo.obstacles) {
      if (o.profile.render === 'none' || o.id.startsWith('bounds')) continue;
      g.fillStyle = o.profile.foliage ? '#4a6a3a' : o.box.z1 > 1.9 ? '#1a1c20' : '#6a6a6a';
      g.fillRect(o.box.x0 * scale, o.box.y0 * scale, Math.max(1, (o.box.x1 - o.box.x0) * scale), Math.max(1, (o.box.y1 - o.box.y0) * scale));
    }
    if (mapCache.size > 6) mapCache.clear();
    mapCache.set(cacheKey, base);
  }
  const cv = document.createElement('canvas');
  cv.width = base.width;
  cv.height = base.height;
  cv.className = 'map-canvas';
  const g = cv.getContext('2d')!;
  g.drawImage(base, 0, 0);
  const sim = ctx.sim;
  const dot = (x: number, y: number, color: string, r = 3, shape: 'circle' | 'square' | 'tri' = 'circle') => {
    g.fillStyle = color;
    g.strokeStyle = '#000';
    g.beginPath();
    if (shape === 'square') g.rect(x * scale - r, y * scale - r, r * 2, r * 2);
    else if (shape === 'tri') {
      g.moveTo(x * scale, y * scale - r - 1);
      g.lineTo(x * scale + r + 1, y * scale + r);
      g.lineTo(x * scale - r - 1, y * scale + r);
      g.closePath();
    } else g.arc(x * scale, y * scale, r, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  };
  for (const ex of map.exits) {
    const st = sim.exits[ex.id];
    g.strokeStyle = st?.enabled === false ? '#e0a040' : '#62e08a';
    g.lineWidth = 2;
    g.strokeRect(ex.x * scale, ex.y * scale, ex.w * scale, ex.h * scale);
  }
  for (const poi of map.pois) dot(poi.x, poi.y, sim.progress.visited.includes(poi.id) ? '#b0b0b0' : '#6aa8e0', 3, 'square');
  const p = app.profile;
  if (p?.perks.includes('core.perk.carry.scout')) for (const c of Object.values(sim.containers)) if (c.opened || c.kind === 'world') dot(c.x, c.y, c.opened ? '#555' : '#d9a441', 2, 'square');
  if (sim.deathBagContainerId) {
    const db = sim.containers[sim.deathBagContainerId];
    if (db) dot(db.x, db.y, '#e05a4a', 4, 'tri');
  }
  const pl = sim.actors.find((a) => a.kind === 'player')!;
  dot(pl.x, pl.y, '#ffffff', 4);
  const exitsList = map.exits.map((ex) => {
    const st = sim.exits[ex.id];
    const cond = ex.condition.type === 'free' ? '무료' : T(u, (ex.condition as { hintKey: string }).hintKey);
    return h('div', { class: st?.enabled === false ? 'warn' : 'good' }, `${T(u, ex.nameKey)} — ${cond}${st?.enabled === false ? ' (조건 미충족)' : ''}`);
  });
  return panel(u, `${T(u, map.nameKey)} 지도`, [h('div', { class: 'cols' }, cv, h('div', { class: 'col', style: 'min-width:240px' }, h('div', { class: 'legend' }, h('span', { style: '--c:#fff' }, '나'), h('span', { style: '--c:#62e08a' }, '탈출(가능)'), h('span', { style: '--c:#e0a040' }, '탈출(조건)'), h('span', { style: '--c:#6aa8e0' }, '랜드마크'), h('span', { style: '--c:#e05a4a' }, '사망 가방')), ...exitsList))], { testid: 'panel-map' });
}

// ------------------------------------------------------------------------------------------------ pause / settings / summary / chapter

export function pausePanel(u: UiCtx, arg: string | null): HTMLElement {
  const app = u.app;
  const raid = app.mode === 'raid';
  const tutorial = app.mode === 'tutorial';
  return panel(
    u,
    '일시정지',
    [
      arg === 'resumed' ? h('div', { class: 'card warn' }, '저장된 출격을 이어서 진행합니다. 준비되면 계속하기를 누르세요.') : null,
      arg === 'save_error' ? h('div', { class: 'card bad' }, '저장에 실패했습니다. 저장 공간을 확인한 뒤 다시 시도하세요. 기존 저장은 안전합니다.') : null,
      h(
        'div',
        { class: 'list' },
        btn('계속하기', () => u.close(), { class: 'primary', testid: 'resume' }),
        btn('설정', () => app.openPanel('settings', null)),
        tutorial ? btn(T(u, 'tutorial.skip'), () => app.skipTutorial(), { testid: 'pause-skip-tutorial' }) : null,
        raid ? btn('출격 포기 (사망 처리)', () => {
          if (window.confirm('출격을 포기하면 휴대품이 사망 가방으로 이동합니다. 계속할까요?')) {
            app.queueOp({ op: 'abandon' });
            u.close();
          }
        }, { class: 'danger' }) : null,
        btn('저장하고 타이틀로', () => void app.backToTitle(), { testid: 'to-title' }),
      ),
      h('div', { class: 'hint' }, raid ? '출격 중 진행 상황은 주기적으로 저장되며, 창을 닫았다가 다시 열면 마지막 저장 지점에서 이어집니다.' : tutorial ? '기초 훈련은 단계마다 저장되어 다음에 이어서 할 수 있습니다. 훈련 중 쓰는 물건은 실제 창고와 무관합니다.' : '거점에서의 모든 거래·제작·건설은 즉시 저장됩니다.'),
    ],
    { size: 'narrow', testid: 'panel-pause' },
  );
}

export function settingsPanel(u: UiCtx): HTMLElement {
  const app = u.app;
  const s = app.settings;
  const t = tabs(u, 'settings', [['audio', '오디오'], ['access', '화면·접근성'], ['controls', '조작']], 'audio');
  let body: HTMLElement;
  const slider = (label: string, value: number, onchange: (v: number) => void, testid?: string) => {
    const input = h('input', { type: 'range', attrs: { min: '0', max: '100', 'aria-label': label, ...(testid ? { 'data-testid': testid } : {}) }, value: String(Math.round(value * 100)), onchange: (e) => onchange(Number((e.target as HTMLInputElement).value) / 100) });
    return h('label', { class: 'line-item' }, h('span', { class: 'grow' }, label), input);
  };
  const toggle = (label: string, value: boolean, onchange: (v: boolean) => void, testid?: string) => h('label', { class: 'line-item' }, h('span', { class: 'grow' }, label), h('input', { type: 'checkbox', checked: value, attrs: testid ? { 'data-testid': testid } : {}, onchange: (e) => onchange((e.target as HTMLInputElement).checked) }));
  if (t.active === 'audio') {
    body = h('div', { class: 'list' }, ...(['Master', 'Music', 'Weapons', 'Impacts', 'Footsteps', 'Ambience', 'UI', 'Voice'] as const).map((b) => slider(T(u, `bus.${b}`), s.volumes[b], (v) => void app.updateSettings({ volumes: { ...s.volumes, [b]: v } }), `vol-${b}`)), h('div', { class: 'hint' }, app.audio.unlocked ? '오디오 활성화됨' : '첫 클릭/키 입력 후 오디오가 켜집니다. 음량 설정은 적 AI의 청각 판정에 영향을 주지 않습니다.'));
  } else if (t.active === 'access') {
    const scaleSel = h('select', { attrs: { 'aria-label': 'UI 크기', 'data-testid': 'ui-scale' }, onchange: (e) => void app.updateSettings({ uiScale: Number((e.target as HTMLSelectElement).value) }) }, ...[100, 125, 150].map((v) => {
      const o = h('option', { value: String(v) }, `${v}%`);
      if (s.uiScale === v) o.selected = true;
      return o;
    }));
    body = h(
      'div',
      { class: 'list' },
      h('label', { class: 'line-item' }, h('span', { class: 'grow' }, 'UI 크기'), scaleSel),
      toggle('자막 (소리 설명)', s.subtitles, (v) => void app.updateSettings({ subtitles: v }), 'set-subtitles'),
      toggle('조작키 안내 (화면 맨 아래 한 줄)', s.keyHints, (v) => void app.updateSettings({ keyHints: v }), 'set-keyhints'),
      toggle('방향 소리 보조 (화살표)', s.directionalAid, (v) => void app.updateSettings({ directionalAid: v })),
      toggle('색 외 형태 구분 (상태 아이콘 기호)', s.shapeCues, (v) => void app.updateSettings({ shapeCues: v })),
      toggle('데미지 숫자 표시', s.damageNumbers, (v) => void app.updateSettings({ damageNumbers: v })),
      toggle('적 체력바 표시', s.healthBars, (v) => void app.updateSettings({ healthBars: v })),
      slider('카메라 흔들림', s.cameraShake, (v) => void app.updateSettings({ cameraShake: v })),
      slider('섬광·피격 플래시 강도', s.flashIntensity, (v) => void app.updateSettings({ flashIntensity: v })),
      toggle('절차적 지형 (출격마다 시작 위치·엄폐물·보급 상자·지면이 달라짐, 다음 출격부터 적용)', s.proceduralTerrain, (v) => void app.updateSettings({ proceduralTerrain: v }), 'set-procgen'),
      import.meta.env.DEV || __E2E__ ? toggle('디버그 오버레이 (개발 빌드)', s.debugOverlay, (v) => void app.updateSettings({ debugOverlay: v })) : null,
      h('div', { class: 'hint' }, '접근성 설정은 표현만 바꿉니다. 실제 피해·AI 탐지 규칙은 바뀌지 않습니다.'),
    );
  } else {
    const waiting = u.state['rebind'] ?? '';
    body = h(
      'div',
      { class: 'list' },
      toggle('정밀 조준 토글 (끄면 누르고 있기)', s.aimToggle, (v) => void app.updateSettings({ aimToggle: v })),
      ...ACTIONS.map((a: Action) => {
        const cur = (app.input.bindings[a] ?? []).join(', ');
        return h('div', { class: 'line-item' }, h('span', { class: 'grow' }, T(u, `action.${a}`)), h('span', { class: 'muted' }, waiting === a ? '키를 누르세요… (Esc 취소)' : cur), btn('변경', () => {
          u.state['rebind'] = a;
          u.invalidate();
          const handler = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            window.removeEventListener('keydown', handler, true);
            u.state['rebind'] = '';
            if (e.code !== 'Escape' && isBindable(e.code) && !e.ctrlKey && !e.metaKey && !e.altKey) {
              const next: Record<string, string[]> = { ...s.bindings, [a]: [e.code] };
              void app.updateSettings({ bindings: next });
            } else if (e.code !== 'Escape') app.toast('브라우저 예약 키는 지정할 수 없습니다', 'warn');
            u.invalidate();
          };
          window.addEventListener('keydown', handler, true);
        }, { class: 'small' }));
      }),
      h('div', { class: 'hint' }, 'Ctrl+R · Ctrl+W · F5 같은 브라우저 예약 조합은 지정할 수 없습니다.'),
    );
  }
  return panel(u, '설정', [body], { tabs: t.el, size: 'mid', testid: 'panel-settings' });
}

export function summaryPanel(u: UiCtx): HTMLElement {
  const app = u.app;
  const s = app.lastSummary;
  const c = u.content;
  if (!s) return panel(u, '정산', [h('div', null, '정산 정보 없음')], { size: 'narrow', foot: [btn('거점으로', () => app.continueFromSummary(), { class: 'primary' })] });
  const good = s.outcome === 'extracted';
  const group = (list: { defId: string; qty: number }[]) => {
    const m = new Map<string, number>();
    for (const i of list) m.set(i.defId, (m.get(i.defId) ?? 0) + i.qty);
    return [...m].map(([d, q]) => itemLine(u, d, [h('span', null, `×${q}`)]));
  };
  return panel(
    u,
    good ? '생환 — 반입 정산' : s.outcome === 'abandoned' ? '출격 포기' : '사망',
    [
      h('div', { class: `card ${good ? 'good' : 'bad'}` }, good ? `${T(u, c.map(s.mapId).nameKey)}에서 ${s.exitId ? T(u, c.map(s.mapId).exits.find((e) => e.id === s.exitId)?.nameKey ?? '') : ''}(으)로 탈출했습니다.` : '쓰러졌다. 휴대품은 사망 가방에 남았다. 다음 같은 지역 출격에서 회수할 수 있다.'),
      h('div', { class: 'kv' }, h('span', { class: 'muted' }, '시간'), h('span', null, fmtTime(s.duration)), h('span', { class: 'muted' }, '처치 / 헤드샷'), h('span', null, `${s.kills} / ${s.headshots}`), h('span', { class: 'muted' }, 'EXP'), h('span', null, `+${s.expGained}${s.levelUps ? ` (레벨 업 ${s.levelUps}!)` : ''}`), s.feePaid ? h('span', { class: 'muted' }, '통행료') : null, s.feePaid ? h('span', null, fmtCredits(s.feePaid)) : null, s.incoming ? h('span', { class: 'muted' }, '보관 대기함') : null, s.incoming ? h('span', { class: 'warn' }, `${s.incoming}개 (창고 가득)`) : null),
      s.notesFound.length ? h('div', { class: 'card' }, `새 기록: ${s.notesFound.map((n) => T(u, c.note(n).titleKey)).join(', ')}`) : null,
      summaryGuides(u),
      good && s.itemsIn.length ? h('div', null, h('h3', null, '창고로 반입된 전리품'), ...group(s.itemsIn)) : null,
      !good && s.itemsKept?.length ? h('div', { attrs: { 'data-testid': 'summary-kept' } }, h('h3', null, '잃지 않은 물품 (시크릿 포켓 · 기본 가방)'), ...group(s.itemsKept)) : null,
      !good && s.itemsLost.length ? h('div', null, h('h3', null, '사망 가방으로 이동한 물품'), ...group(s.itemsLost)) : null,
    ],
    { size: 'mid', foot: [btn('거점으로 돌아가기', () => app.continueFromSummary(), { class: 'primary', testid: 'summary-continue' })], testid: 'panel-summary' },
  );
}

/** "Back at the shelter": quests to report and deliveries that can be made, naming the NPC to go to. */
function summaryGuides(u: UiCtx): HTMLElement | null {
  const p = u.app.profile;
  const c = u.content;
  if (!p) return null;
  const lines = shelterGuides(p, c).flatMap((g) => {
    if (g.kind === 'report' && g.npcId) return [`▶ ${T(u, c.npc(g.npcId).nameKey)}에게 보고 — ${T(u, c.quest(g.questId).nameKey)}`];
    if (g.kind === 'deliver' && g.npcId && g.itemId) return [`▶ ${T(u, c.item(g.itemId).nameKey)} → ${T(u, c.npc(g.npcId).nameKey)}에게 전달`];
    if (g.kind === 'contract') return ['▶ 임무 게시판에서 계약 보상 받기'];
    return [];
  });
  if (!lines.length) return null;
  return h('div', { class: 'card good', data: { testid: 'summary-guides' } }, h('div', { style: 'font-weight:700' }, '거점에 돌아가면'), ...lines.map((l) => h('div', null, l)));
}

export function chapterPanel(u: UiCtx): HTMLElement {
  const app = u.app;
  const c = u.content;
  const ch = c.chapters.get('core.chapter.1')!;
  return panel(
    u,
    'Chapter 1 완료',
    [h('div', { class: 'chapter-end' }, h('h1', null, T(u, ch.nameKey)), h('p', null, T(u, 'act.5.name')), h('p', null, T(u, 'act.5.desc')), h('p', { class: 'muted' }, '두 지역 모두 자유롭게 계속 출격할 수 있습니다. 계약·블랙마켓·시설 개선이 계속 열려 있습니다.'))],
    { size: 'mid', foot: [btn('자유 출격 계속', () => {
      void app.tx('chapter:epilogue', (d) => {
        d.chapter.epilogueSeen = true;
      });
      u.close();
    }, { class: 'primary', testid: 'chapter-continue' })], testid: 'panel-chapter' },
  );
}

export function recoveryPanel(u: UiCtx): HTMLElement {
  const app = u.app;
  const rec = app.pendingRecovery!;
  const f = rec.failure;
  const backups = f.kind === 'corrupt' ? f.backups : [];
  return panel(
    u,
    '저장 데이터 손상',
    [h('div', { class: 'bad' }, `슬롯 ${rec.slotId}의 현재 저장 기록을 읽을 수 없습니다.`), h('div', { class: 'hint' }, f.kind === 'corrupt' ? f.errors.join(' / ') : ''), h('div', null, backups.length ? `유효한 이전 스냅샷 후보 ${backups.length}개가 있습니다. 손상된 기록은 자동으로 덮어쓰지 않습니다.` : '복구 가능한 백업이 없습니다. 슬롯을 내보내 보관하거나 삭제할 수 있습니다.')],
    { size: 'narrow', foot: [btn('취소', () => {
      app.pendingRecovery = null;
      u.invalidate();
    }), btn('마지막 유효 백업으로 복구', () => void app.continueGame(rec.slotId, true).then(() => u.invalidate()), { class: 'primary', disabled: backups.length === 0, testid: 'recover-backup' })], testid: 'panel-recovery' },
  );
}
