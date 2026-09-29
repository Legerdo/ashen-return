import { worldToView, viewToClient } from '../core/coords';
import { currentSpreadDeg, magazineOf, weaponStats } from '../combat/weapons';
import type { GameApp } from '../game/app';
import { activeWeaponItem, carriedContainerIds, equippedItem, hitboxOf, player, type SimContext } from '../world/context';
import { carriedWeightKg, normalLimitKg, WEIGHT } from '../world/movement';
import { BOARD_STATION, guideKey, RANGE_POI, type GuideKind } from '../progression/guidance';
import { isTraining, type SimEvent } from '../world/state';
import { EXTRACT_TIME } from '../world/sim';
import { TUTORIAL, TUTORIAL_STEPS, type TutorialDirector } from '../world/tutorial';
import { btn, h } from './dom';
import { GuideLayer, type GuideMark } from './guide';
import { itemIcon } from './icons';
import { controlHints, primaryKey } from './keys';

const DIRS = ['cap.dir.e', 'cap.dir.se', 'cap.dir.s', 'cap.dir.sw', 'cap.dir.w', 'cap.dir.nw', 'cap.dir.n', 'cap.dir.ne'];

interface Arrow {
  el: HTMLElement;
  until: number;
  angle: number;
}

/** Combat HUD (DOM, native resolution). Only writes to the DOM when a value changes. */
export class Hud {
  private root: HTMLElement;
  private overlay: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private cache = new Map<string, string>();
  private crosshair: HTMLElement;
  private ring: HTMLElement;
  private captions: HTMLElement;
  private arrows: Arrow[] = [];
  private labelPool: HTMLElement[] = [];
  private stepCaptionCounter = 0;
  private guide: GuideLayer;

  constructor(private readonly app: GameApp) {
    this.root = document.getElementById('hud-layer')!;
    this.overlay = document.getElementById('world-overlay')!;
    const guideRoot = h('div', { class: 'guide-layer' });
    this.root.append(guideRoot);
    this.guide = new GuideLayer(guideRoot);
    const mk = (key: string, cls: string) => {
      const el = h('div', { class: cls });
      this.els[key] = el;
      this.root.append(el);
      return el;
    };
    mk('vitals', 'hud-box hud-vitals');
    mk('weapon', 'hud-box hud-weapon');
    mk('quick', 'hud-quick');
    mk('prompt', 'hud-prompt');
    mk('objectives', 'hud-box hud-objectives');
    mk('top', 'hud-box hud-top');
    mk('exit', 'hud-box hud-exit');
    mk('action', 'hud-box hud-action');
    mk('keys', 'hud-keys');
    this.els['keys']!.dataset['testid'] = 'hud-keys';
    mk('tutorial', 'hud-box hud-tutorial');
    this.els['tutorial']!.style.display = 'none';
    this.captions = h('div', { class: 'captions', attrs: { 'aria-live': 'polite' } });
    this.root.append(this.captions);
    this.ring = h('div', { class: 'ring' });
    this.crosshair = h('div', { class: 'crosshair' }, this.ring, h('div', { class: 'dot' }));
    document.body.append(this.crosshair);
  }

  private set(key: string, html: HTMLElement | string, sig: string): void {
    if (this.cache.get(key) === sig) return;
    this.cache.set(key, sig);
    const el = this.els[key]!;
    el.replaceChildren(typeof html === 'string' ? document.createTextNode(html) : html);
  }

  private show(key: string, v: boolean): void {
    const el = this.els[key]!;
    const want = v ? '' : 'none';
    if (el.style.display !== want) el.style.display = want;
  }

  update(): void {
    const app = this.app;
    const ctx = app.currentCtx();
    const active = !!ctx && app.inWorld;
    const tutOn = active && app.mode === 'tutorial' ? 'on' : 'off';
    if (document.body.dataset['tutorial'] !== tutOn) document.body.dataset['tutorial'] = tutOn;
    this.root.style.display = active ? '' : 'none';
    this.crosshair.style.display = active && !app.panel ? '' : 'none';
    if (!active || !ctx) {
      this.overlay.replaceChildren();
      this.labelPool = [];
      this.guide.clear();
      if (document.body.dataset['keyhints'] !== 'off') document.body.dataset['keyhints'] = 'off';
      return;
    }
    const sim = ctx.sim;
    const c = app.content;
    const pl = player(sim);
    const raid = sim.mode === 'raid';
    // Vitals.
    const kg = carriedWeightKg(ctx, pl);
    const limit = normalLimitKg(ctx, pl);
    const helm = equippedItem(sim, pl.id, 'helmet');
    const vest = equippedItem(sim, pl.id, 'vest');
    const painful = pl.hp < 30 && pl.status.painkillerUntil <= sim.time;
    const statuses: string[] = [];
    if (pl.status.bleeding) statuses.push('bleed');
    if (painful) statuses.push('pain');
    if (pl.status.painkillerUntil > sim.time) statuses.push('pk');
    if (pl.status.flashedUntil > sim.time) statuses.push('flash');
    const vitSig = `${Math.ceil(pl.hp)}|${Math.round(pl.stamina)}|${statuses.join()}|${helm?.durability?.toFixed(0)}|${vest?.durability?.toFixed(0)}|${kg.toFixed(1)}|${pl.staminaMax}`;
    this.set(
      'vitals',
      h(
        'div',
        { style: 'display:flex;flex-direction:column;gap:4px' },
        h('div', { class: 'bar-label' }, h('span', null, `체력 ${Math.ceil(pl.hp)}`), h('span', { class: 'muted' }, '/ 100')),
        h('div', { class: 'bar hp', attrs: { role: 'progressbar', 'aria-label': '체력', 'aria-valuemin': '0', 'aria-valuemax': String(pl.maxHp), 'aria-valuenow': String(Math.ceil(pl.hp)) } }, h('div', { style: `width:${Math.max(0, pl.hp)}%` })),
        h('div', { class: 'bar-label' }, h('span', null, `스태미나 ${Math.round(pl.stamina)}`), h('span', { class: 'muted' }, `/ ${pl.staminaMax}`)),
        h('div', { class: 'bar st', attrs: { role: 'progressbar', 'aria-label': '스태미나', 'aria-valuemin': '0', 'aria-valuemax': String(pl.staminaMax), 'aria-valuenow': String(Math.round(pl.stamina)) } }, h('div', { style: `width:${(pl.stamina / pl.staminaMax) * 100}%` })),
        h('div', { class: 'status-row' }, ...statuses.map((s) => h('span', { class: `status ${s}` }, s === 'bleed' ? '출혈' : s === 'pain' ? '통증' : s === 'pk' ? '진통제' : '섬광'))),
        h(
          'div',
          { class: 'armor-row' },
          h('span', null, helm ? `헬멧 ${c.item(helm.definitionId).armor!.tier}등급 ${Math.round(helm.durability ?? 0)}` : '헬멧 없음'),
          h('span', null, vest ? `조끼 ${c.item(vest.definitionId).armor!.tier}등급 ${Math.round(vest.durability ?? 0)}` : '조끼 없음'),
        ),
        h('div', { class: `hud-weight ${kg > WEIGHT.heavy ? 'bad' : kg > limit ? 'warn' : ''}` }, `무게 ${kg.toFixed(1)}kg ${kg > WEIGHT.sprintMax ? '· 달리기 불가' : kg > limit ? '· 과적' : ''}`),
      ),
      vitSig,
    );
    // Weapon.
    const aw = activeWeaponItem(ctx, pl);
    const holstered = sim.mode === 'base' && ctx.geo.regionAt(pl.x, pl.y)?.id !== 'core.region.range';
    if (aw && !holstered) {
      const w = aw.item;
      const mag = magazineOf(ctx, w);
      const inMag = mag?.mag?.rounds.length ?? w.weapon?.tube?.length ?? 0;
      const cap = mag ? c.item(mag.definitionId).magazine!.capacity : aw.def.weapon!.capacity;
      const ammoId = w.weapon?.chamber ?? mag?.mag?.rounds[mag.mag.rounds.length - 1] ?? w.weapon?.tube?.[w.weapon.tube.length - 1] ?? null;
      let spareMags = 0;
      let spareRounds = 0;
      let loose = 0;
      for (const cid of carriedContainerIds(sim, pl)) {
        for (const id of sim.store.containers[cid]?.items ?? []) {
          const it = sim.store.items[id];
          if (!it) continue;
          const d = c.item(it.definitionId);
          if (d.magazine?.family === aw.def.weapon!.magazineFamily && aw.def.weapon!.magazineFamily) {
            spareMags++;
            spareRounds += it.mag?.rounds.length ?? 0;
          }
          if (d.ammo?.caliber === aw.def.weapon!.caliber) loose += it.quantity;
        }
      }
      const mode = w.weapon!.fireMode;
      const modeLabel = mode === 'auto' ? '자동' : mode === 'semi' ? '단발' : mode === 'pump' ? '펌프' : '볼트';
      // Shelter / range / tutorial reload from the unlimited training reserve (combat/reload.ts).
      const training = isTraining(sim);
      const reserve = training ? '훈련 탄약 무제한' : `예비 탄창 ${spareMags}(${spareRounds}발) · 낱탄 ${loose}`;
      const slots = this.slotRow(ctx);
      const sig = `${w.instanceId}|${w.weapon?.chamber}|${inMag}|${reserve}|${mode}|${Math.round(w.durability ?? 0)}|${slots.sig}`;
      this.set(
        'weapon',
        h(
          'div',
          null,
          h('div', { class: 'wname' }, c.t(aw.def.nameKey)),
          h('div', { class: 'detail' }, `${ammoId ? c.t(c.item(ammoId).nameKey) : '탄 없음'} · ${modeLabel} · 내구도 ${Math.round(w.durability ?? 0)}%`),
          h('div', { class: 'ammo' }, `${inMag + (w.weapon?.chamber ? 1 : 0)}`, h('span', { class: 'muted', style: 'font-size:0.6em' }, ` / ${cap}+1`)),
          h('div', { class: 'detail' }, `약실 ${w.weapon?.chamber ? 1 : 0} · ${mag ? `탄창 ${inMag}/${cap}` : w.weapon?.tube ? `튜브 ${inMag}/${cap}` : '탄창 없음'} · `, h('span', { class: training ? 'training' : '' }, reserve)),
          slots.el,
        ),
        sig,
      );
      this.show('weapon', true);
    } else {
      this.show('weapon', sim.mode === 'raid');
      if (sim.mode === 'raid') {
        const slots = this.slotRow(ctx);
        this.set('weapon', h('div', null, h('div', { class: 'wname' }, aw ? '' : pl.activeSlot === 'melee' ? '근접 무기' : '무기 없음'), slots.el), `noweapon|${slots.sig}|${pl.activeSlot}`);
      }
    }
    // Quickslots.
    const qsig = pl.quickslots.map((q) => (q ? `${q}:${sim.store.items[q]?.quantity ?? 0}` : '-')).join('|');
    this.set(
      'quick',
      h(
        'div',
        { style: 'display:flex;gap:6px' },
        ...pl.quickslots.map((q, i) => {
          const it = q ? sim.store.items[q] : undefined;
          const d = it ? c.item(it.definitionId) : null;
          return h('div', { class: 'qslot', title: d ? c.t(d.nameKey) : '비어 있음' }, h('span', { class: 'k' }, String(i + 4)), d ? h('img', { attrs: { alt: c.t(d.nameKey), src: itemIcon(d) } }) : null, it && it.quantity > 1 ? h('span', { class: 'n' }, String(it.quantity)) : null);
        }),
      ),
      qsig,
    );
    this.show('quick', raid || pl.quickslots.some(Boolean));
    // Prompt.
    const pr = sim.prompt;
    if (pr && !app.panel) {
      const label = c.t(pr.labelKey, pr.params ? Object.fromEntries(Object.entries(pr.params).map(([k, v]) => [k, typeof v === 'string' && c.has(v) ? c.t(v) : v])) : undefined);
      const sig = `${pr.id}|${pr.blockedKey}|${label}`;
      this.set('prompt', h('span', null, h('span', { class: 'key' }, 'E'), pr.blockedKey ? `${label} — ${c.t(pr.blockedKey)}` : label), sig);
      this.els['prompt']!.classList.toggle('blocked', !!pr.blockedKey);
      this.show('prompt', true);
    } else this.show('prompt', false);
    // Objectives (the tutorial shows its lesson box instead).
    const tut = app.mode === 'tutorial' && app.tutorial && !app.tutorial.finished ? app.tutorial : null;
    this.show('objectives', !tut);
    this.show('tutorial', !!tut);
    if (tut) {
      const b = app.input.bindings;
      this.set('tutorial', this.tutorialBox(tut), `${tut.step}|${tut.progress}|${app.settings.aimToggle}|${JSON.stringify(b)}`);
    } else this.set('objectives', this.objectives(), this.objectivesSig());
    // Top info.
    const reg = ctx.geo.regionAt(pl.x, pl.y);
    const p = app.profile;
    const topSig = `${sim.mapId}|${reg?.id}|${Math.floor(sim.time)}|${p?.currency}|${p?.level}|${sim.env.phase}|${sim.env.weather}|${app.settings.keyHints}|${app.mode}`;
    this.set(
      'top',
      h(
        'div',
        null,
        h('div', { style: 'font-weight:700' }, `${c.t(ctx.geo.map.nameKey)}${reg ? ` · ${c.t(reg.nameKey)}` : ''}`),
        app.mode === 'tutorial' ? h('div', { class: 'muted' }, '훈련 중 · 피해 없음 · 스태미나·탄약 무제한') : raid ? h('div', { class: 'muted' }, `${c.t(c.timePhase(sim.env.phase).nameKey)} · ${c.t(c.weather(sim.env.weather).nameKey)} · 경과 ${Math.floor(sim.time / 60)}:${String(Math.floor(sim.time % 60)).padStart(2, '0')}`) : h('div', { class: 'muted' }, `Lv.${p?.level ?? 1} · ${(p?.currency ?? 0).toLocaleString('ko-KR')}cr${app.settings.keyHints ? '' : ' · [Tab] 창고/성장 · [E] 상호작용'}`),
      ),
      topSig,
    );
    // Exit progress.
    let exitShown = false;
    if (raid) {
      for (const ex of ctx.geo.map.exits) {
        const st = sim.exits[ex.id];
        if (st && st.progress > 0) {
          exitShown = true;
          this.set('exit', h('div', null, h('div', null, `${c.t(ex.nameKey)} — 탈출 중 ${Math.max(0, EXTRACT_TIME - st.progress).toFixed(1)}초`), h('div', { class: 'progress' }, h('div', { style: `width:${(st.progress / EXTRACT_TIME) * 100}%` }))), `${ex.id}|${st.progress.toFixed(1)}`);
        }
      }
    }
    this.show('exit', exitShown);
    // Action progress (reload/heal/throw/switch).
    const act = pl.action;
    if (act && act.type !== 'sprintStop' && act.type !== 'dodge') {
      const names: Record<string, string> = { reload: act.quick ? '빠른 장전' : '장전', tubeReload: '튜브 장전', refillMag: '탄창 채우기', heal: '치료', melee: '근접 공격', throw: '투척', switch: '무기 교체', loadMag: '탄창에 탄 넣기', unloadMag: '탄 빼기' };
      const frac = act.duration > 50 ? ((act.roundsDone ?? 0) % 10) / 10 : Math.min(1, act.elapsed / act.duration);
      this.set('action', h('div', null, h('div', null, names[act.type] ?? act.type), h('div', { class: 'progress' }, h('div', { style: `width:${frac * 100}%` }))), `${act.type}|${Math.round(frac * 50)}`);
      this.show('action', true);
    } else this.show('action', false);
    this.updateKeyStrip(ctx);
    this.updateCrosshair();
    this.updateOverlay();
    this.updateArrows();
    this.guide.update(this.guideMarks(ctx), app.view, app.rectProvider(), { x: pl.px + (pl.x - pl.px) * app.renderAlpha(), y: pl.py + (pl.y - pl.py) * app.renderAlpha() });
  }

  /**
   * Always-visible control strip on the bottom edge (built from the live bindings). While it shows, body carries
   * data-keyhints="on" and the bottom HUD (vitals, weapon, quickslots, prompt, action, captions) moves up above it.
   */
  private updateKeyStrip(ctx: SimContext): void {
    const app = this.app;
    const show = app.settings.keyHints && !app.panel;
    const want = show ? 'on' : 'off';
    if (document.body.dataset['keyhints'] !== want) document.body.dataset['keyhints'] = want;
    this.show('keys', show);
    if (!show) return;
    const pl = player(ctx.sim);
    const mode = app.mode === 'tutorial' ? 'tutorial' : ctx.sim.mode === 'raid' ? 'raid' : 'base';
    const armed = mode !== 'base' || ctx.geo.regionAt(pl.x, pl.y)?.id === 'core.region.range';
    const training = isTraining(ctx.sim);
    const sig = `${mode}|${armed}|${training}|${app.settings.aimToggle}|${JSON.stringify(app.input.bindings)}`;
    this.set(
      'keys',
      h('div', { class: 'keys-row' }, ...controlHints(app.input.bindings, { mode, armed, aimToggle: app.settings.aimToggle, training }).map((k) => h('span', { class: 'kh' }, h('span', { class: 'k' }, k.keys), k.label))),
      sig,
    );
  }

  /** Guidance targets: shelter turn-ins / deliveries / onboarding tasks, or the current tutorial step. */
  private guideMarks(ctx: SimContext): GuideMark[] {
    const app = this.app;
    const c = app.content;
    if (app.panel) return [];
    if (app.mode === 'tutorial') return app.tutorialMarks();
    if (app.mode !== 'base') return [];
    const byKey = new Map<string, { key: string; x: number; y: number; z: number; name: string; kinds: GuideKind[]; labels: string[] }>();
    for (const g of app.guides) {
      let at: { key: string; x: number; y: number; z: number; name: string } | null = null;
      if (g.npcId) {
        const a = ctx.sim.actors.find((x) => x.kind === 'npc' && x.archetypeId === g.npcId);
        if (a) at = { key: `npc:${g.npcId}`, x: a.x, y: a.y, z: hitboxOf(c, a).height + 0.45, name: c.t(c.npc(g.npcId).nameKey) };
      } else if (g.placeId) {
        const spot = ctx.geo.map.interactables.find((i) => i.id === g.placeId) ?? ctx.geo.map.pois.find((p) => p.id === g.placeId);
        if (spot) at = { key: `place:${g.placeId}`, x: spot.x, y: spot.y, z: 1.6, name: c.t(g.placeId === RANGE_POI ? 'guide.range' : g.placeId === BOARD_STATION ? 'guide.board' : g.placeId) };
      }
      if (!at) continue;
      const m = byKey.get(at.key) ?? { ...at, kinds: [], labels: [] };
      byKey.set(at.key, m);
      if (!m.kinds.includes(g.kind)) m.kinds.push(g.kind);
      if (g.labelKey && !m.labels.includes(g.labelKey)) m.labels.push(g.labelKey);
    }
    const order: GuideKind[] = ['report', 'deliver', 'contract', 'talk', 'range', 'drill'];
    return [...byKey.values()].map((m) => {
      const urgent = m.kinds.some((k) => k === 'report' || k === 'deliver' || k === 'contract');
      const label = [...order.filter((k) => m.kinds.includes(k) && k !== 'drill').map((k) => c.t(`guide.mark.${k}`)), ...m.labels.map((k) => c.t(k))].join(' · ');
      return { key: m.key, x: m.x, y: m.y, z: m.z, icon: urgent ? '!' : '›', label, name: m.name, tone: urgent ? 'report' : 'task' };
    });
  }

  /** Weapon slots with their switch keys ([1] primary 1 · [2] primary 2 · [3] secondary), the active one highlighted. */
  private slotRow(ctx: SimContext): { el: HTMLElement; sig: string } {
    const app = this.app;
    const c = app.content;
    const pl = player(ctx.sim);
    const b = app.input.bindings;
    const rows = ([['weapon1', 'primary1'], ['weapon2', 'primary2'], ['weapon3', 'secondary']] as const).map(([action, slot]) => {
      const it = equippedItem(ctx.sim, pl.id, slot);
      return { key: primaryKey(b, action), name: it ? c.t(c.item(it.definitionId).nameKey) : '—', active: pl.activeSlot === slot, empty: !it };
    });
    const sig = rows.map((r) => `${r.key}:${r.name}:${r.active}`).join(',');
    const el = h('div', { class: 'slot-row', attrs: { 'data-testid': 'hud-slots' } }, ...rows.map((r) => h('span', { class: `ws${r.active ? ' on' : ''}${r.empty ? ' empty' : ''}` }, h('span', { class: 'k' }, r.key), r.name)));
    return { el, sig };
  }

  /** Current lesson: step counter, what to do (with the live key names), progress dots and a skip button. */
  private tutorialBox(t: TutorialDirector): HTMLElement {
    const app = this.app;
    const c = app.content;
    const b = app.input.bindings;
    const k = (a: string) => primaryKey(b, a);
    const params: Record<string, string | number> = { n: t.progress, count: TUTORIAL.shootHits, rolls: TUTORIAL.dodgeRolls };
    for (const a of ['up', 'left', 'down', 'right', 'sprint', 'dodge', 'crouch', 'interact', 'inventory', 'reload', 'melee', 'throw', 'quick1', 'map']) params[a] = k(a);
    const id = t.id;
    const bodyKey = id === 'ads' && app.settings.aimToggle ? 'tutorial.s.ads.body_toggle' : `tutorial.s.${id}.body`;
    const skip = btn(c.t('tutorial.skip'), () => {
      app.skipTutorial();
      document.getElementById('game-frame')?.focus({ preventScroll: true });
    }, { class: 'small tut-skip', testid: 'tutorial-skip' });
    return h(
      'div',
      { attrs: { 'data-testid': 'tutorial-box', 'data-step': id } },
      h('div', { class: 'tut-head' }, h('span', { class: 'tut-step' }, c.t('tutorial.head', { n: t.step + 1, total: TUTORIAL_STEPS.length })), h('span', { class: 'tut-title' }, c.t(`tutorial.s.${id}.title`)), skip),
      h('div', { class: 'tut-body' }, c.t(bodyKey, params)),
      h('div', { class: 'tut-dots', attrs: { 'aria-hidden': 'true' } }, ...TUTORIAL_STEPS.map((_, i) => h('span', { class: `dot${i < t.step ? ' done' : i === t.step ? ' cur' : ''}` }))),
    );
  }

  private objectivesSig(): string {
    const p = this.app.profile;
    const sim = this.app.ctx?.sim;
    if (!p) return '';
    return JSON.stringify([Object.entries(p.quests).filter(([, s]) => s.status !== 'locked' && s.status !== 'completed'), p.contracts.offers.filter((o) => o.status !== 'offered').map((o) => [o.id, o.progress, o.status]), sim?.progress.visited.length, sim?.progress.kills.length, sim?.progress.retrieved.length, this.app.guides.map(guideKey)]);
  }

  private objectives(): HTMLElement {
    const app = this.app;
    const p = app.profile;
    const c = app.content;
    const sim = app.ctx?.sim;
    const root = h('div', null);
    if (!p) return root;
    let n = 0;
    for (const q of c.quests.values()) {
      const st = p.quests[q.id];
      if (!st || (st.status !== 'active' && st.status !== 'ready')) continue;
      if (n >= 3) break;
      n++;
      root.append(h('div', { class: 'q' }, `${c.t(q.nameKey)}${st.status === 'ready' ? ' · 완료' : ''}`));
      // Who to go to next: the giver for a finished quest, the recipient when a delivery can be made now.
      if (st.status === 'ready') root.append(h('div', { class: 'o guide-line' }, `▶ ${c.t(c.npc(q.giver).nameKey)}에게 보고`));
      for (const g of app.guides) if (g.kind === 'deliver' && g.questId === q.id && g.npcId && g.itemId) root.append(h('div', { class: 'o guide-line' }, `▶ ${c.t(c.item(g.itemId).nameKey)} → ${c.t(c.npc(g.npcId).nameKey)}에게 전달`));
      for (const o of q.objectives) {
        let cur = st.progress[o.id] ?? 0;
        if (sim && sim.mode === 'raid' && cur < o.count) {
          if (o.type === 'Visit' && o.target && sim.progress.visited.includes(o.target)) cur = o.count;
          if (o.type === 'Retrieve' && o.target && sim.progress.retrieved.includes(o.target)) cur = o.count;
          if (o.type === 'Kill' && o.target) cur = Math.min(o.count, cur + sim.progress.kills.filter((k) => k.role === o.target).length);
        }
        const done = cur >= o.count;
        root.append(h('div', { class: `o${done ? ' done' : ''}` }, `${done ? '■' : '□'} ${c.t(o.descKey)}${o.count > 1 ? ` (${Math.min(cur, o.count)}/${o.count})` : ''}`));
      }
    }
    for (const ct of p.contracts.offers) {
      if (ct.status !== 'active' && ct.status !== 'ready') continue;
      const t = c.contract(ct.templateId);
      root.append(h('div', { class: 'q' }, `계약: ${c.t(t.nameKey)}${ct.status === 'ready' ? ' · 완료' : ''}`), h('div', { class: 'o' }, `${ct.progress}/${ct.objective.count}`));
    }
    return root;
  }

  private updateCrosshair(): void {
    const app = this.app;
    const ctx = app.ctx;
    const cur = app.input.cursorClient;
    if (!ctx || !cur) return;
    this.crosshair.style.left = `${cur.x}px`;
    this.crosshair.style.top = `${cur.y}px`;
    const pl = player(ctx.sim);
    const aw = activeWeaponItem(ctx, pl);
    const rect = app.rectProvider();
    const scale = rect.width / 640;
    let radius = 6;
    if (aw) {
      const stats = weaponStats(ctx, aw.item, ctx.sim.perks);
      const ammo = aw.item.weapon?.chamber ? ctx.content.item(aw.item.weapon.chamber).ammo ?? null : null;
      const spread = currentSpreadDeg(pl, stats, ammo);
      const d = Math.max(1, Math.hypot(pl.aim.targetX - pl.x, pl.aim.targetY - pl.y));
      radius = Math.max(4, Math.tan((spread * Math.PI) / 180) * d * 16 * scale);
    }
    const r = Math.min(120, radius);
    const ringSize = `${r * 2}px`;
    if (this.ring.style.width !== ringSize) {
      this.ring.style.width = ringSize;
      this.ring.style.height = ringSize;
    }
    const blocked = pl.aim.muzzleBlocked;
    const unavailable = !aw || (pl.action !== null && pl.action.type !== 'sprintStop') || (ctx.sim.mode === 'base' && ctx.geo.regionAt(pl.x, pl.y)?.id !== 'core.region.range');
    this.crosshair.classList.toggle('blocked', blocked);
    this.crosshair.classList.toggle('unavailable', !blocked && unavailable);
    this.crosshair.classList.toggle('stable', !blocked && !unavailable && pl.handling.adsT >= 0.99);
    this.crosshair.classList.toggle('lowcover', pl.handling.muzzleRaised);
  }

  /** World-anchored labels (exits) rendered in the DOM overlay for crisp Korean text. */
  private updateOverlay(): void {
    const app = this.app;
    const ctx = app.ctx!;
    const rect = app.rectProvider();
    let i = 0;
    const put = (text: string, x: number, y: number, z: number, cls: string) => {
      const v = worldToView(app.view, x, y, z);
      if (v.sx < -40 || v.sy < -20 || v.sx > 680 || v.sy > 380) return;
      const cpos = viewToClient(rect, v.sx, v.sy);
      let el = this.labelPool[i];
      if (!el) {
        el = h('div', { class: 'world-label' });
        this.labelPool[i] = el;
        this.overlay.append(el);
      }
      if (el.textContent !== text) el.textContent = text;
      el.className = `world-label ${cls}`;
      el.style.left = `${cpos.clientX}px`;
      el.style.top = `${cpos.clientY}px`;
      el.style.display = '';
      i++;
    };
    if (ctx.sim.mode === 'raid') {
      for (const ex of ctx.geo.map.exits) {
        const st = ctx.sim.exits[ex.id];
        put(app.content.t(ex.nameKey), ex.x + ex.w / 2, ex.y, 0.2, st?.enabled ? '' : 'cond');
      }
    }
    for (let j = i; j < this.labelPool.length; j++) this.labelPool[j]!.style.display = 'none';
  }

  /** Damage numbers, captions and directional cues driven by simulation feedback events. */
  onEvent(e: SimEvent & { __sx?: number; __sy?: number }): void {
    const app = this.app;
    const ctx = app.ctx;
    if (!ctx) return;
    const s = app.settings;
    const rect = app.rectProvider();
    const pl = player(ctx.sim);
    if (e.t === 'hit' && s.damageNumbers && (e.byPlayer || e.actorId === 'player') && e.__sx !== undefined) {
      const cpos = viewToClient(rect, e.__sx, e.__sy!);
      const el = h('div', { class: `dmg-num${e.part === 'head' ? ' head' : ''}${e.armorHit ? ' armor' : ''}${e.actorId === 'player' ? ' me' : ''}`, style: `left:${cpos.clientX}px;top:${cpos.clientY - 10}px` }, e.damage > 0 ? String(e.damage) : '0');
      this.overlay.append(el);
      setTimeout(() => el.remove(), 950);
    }
    const caption = (key: string, x: number, y: number) => {
      if (!s.subtitles) return;
      const d = Math.hypot(x - pl.x, y - pl.y);
      const ang = Math.atan2(y - pl.y, x - pl.x);
      const idx = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
      const dir = d < 4 ? app.content.t('cap.near') : app.content.t(DIRS[idx]!);
      const el = h('div', { class: 'caption' }, `[${app.content.t(key)} · ${dir}]`);
      this.captions.append(el);
      while (this.captions.children.length > 4) this.captions.firstElementChild?.remove();
      setTimeout(() => el.remove(), 2200);
    };
    if (e.t === 'shot' && e.actorId !== 'player' && ctx.sim.mode === 'raid') {
      caption(e.suppressed ? 'cap.gunshot.suppressed' : 'cap.gunshot', e.x, e.y);
      if (s.directionalAid && !app.visibleActors.has(e.actorId)) this.arrow(Math.atan2(e.y - pl.y, e.x - pl.x), false);
    } else if (e.t === 'explosion') caption('cap.explosion', e.x, e.y);
    else if (e.t === 'alert') {
      const a = ctx.sim.actors.find((x) => x.id === e.actorId);
      if (a && Math.hypot(a.x - pl.x, a.y - pl.y) < 20) caption('cap.alert', a.x, a.y);
    } else if (e.t === 'footstep' && e.actorId !== 'player') {
      const d = Math.hypot(e.x - pl.x, e.y - pl.y);
      if (d < 8) {
        if (++this.stepCaptionCounter % 3 === 0) caption('cap.footsteps', e.x, e.y);
        if (s.directionalAid && !app.visibleActors.has(e.actorId)) this.arrow(Math.atan2(e.y - pl.y, e.x - pl.x), true);
      }
    }
  }

  private arrow(angle: number, step: boolean): void {
    const el = h('div', { class: `dir-arrow${step ? ' step' : ''}` });
    document.body.append(el);
    this.arrows.push({ el, until: performance.now() + 1500, angle });
    if (this.arrows.length > 8) this.arrows.shift()?.el.remove();
  }

  private updateArrows(): void {
    const app = this.app;
    const ctx = app.ctx!;
    const now = performance.now();
    const pl = player(ctx.sim);
    const rect = app.rectProvider();
    const v = worldToView(app.view, pl.x, pl.y, 1);
    const c = viewToClient(rect, v.sx, v.sy);
    const R = 70 * (rect.width / 1280) + 30;
    this.arrows = this.arrows.filter((a) => {
      if (a.until < now) {
        a.el.remove();
        return false;
      }
      a.el.style.left = `${c.clientX + Math.cos(a.angle) * R - 7}px`;
      a.el.style.top = `${c.clientY + Math.sin(a.angle) * R - 7}px`;
      a.el.style.transform = `rotate(${a.angle + Math.PI / 2}rad)`;
      a.el.style.opacity = String(Math.min(0.9, (a.until - now) / 800));
      return true;
    });
  }
}
