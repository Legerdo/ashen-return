import type { ContentRegistry } from '../content/registry';
import { FixedStepClock, SIM_DT } from '../core/clock';
import { clientToView, type ViewCamera } from '../core/coords';
import type { TxOutcome } from '../core/tx';
import { buildingInteractables, buildingObstacles } from '../economy/buildings';
import { completeCraft, tickCrafting } from '../economy/crafting';
import { ensureMarket, ensureTraderStock } from '../economy/trade';
import { ensureContracts } from '../progression/contracts';
import { guideKey, guideToast, rangeDrillGuides, shelterGuides, type QuestGuide } from '../progression/guidance';
import { aggregatePerks, newProfile, type ProfileState, type RaidSummary, type Settings } from '../progression/profile';
import { applyQuestEvent, refreshQuests } from '../progression/quests';
import { commitRaidEnd, prepareDeploy } from '../progression/raidFlow';
import { RELOAD_HOLD_TIME } from '../combat/reload';
import { resolveAim } from '../presentation/aimResolve';
import type { AudioEngine } from '../presentation/audio';
import type { InputManager } from '../presentation/input';
import type { SceneHost, SceneSettings } from '../presentation/worldScene';
import type { GuideMark } from '../ui/guide';
import { SaveStore, type LoadFailure, type LoadResult } from '../save/saveStore';
import { idleCommand, type PlayerCommand, type RaidOp } from '../world/command';
import { makeContext, type SimContext } from '../world/context';
import { destroyItem } from '../inventory/store';
import { createBaseSim, firstArmedSlot, issueTrainingWeapon, profileTrainingLoadout } from '../world/range';
import { stepSim } from '../world/sim';
import { createRaidSim, raidGeometry } from '../world/spawn';
import type { ActorState, SimEvent } from '../world/state';
import { createTutorialSim, TUTORIAL_STEPS, TutorialDirector } from '../world/tutorial';
import { rectContains } from '../core/math';
import { predictTrajectory, launchVelocity, throwOrigin } from '../world/throwables';
import { ProfileService } from './profileService';

export type AppMode = 'boot' | 'title' | 'tutorial' | 'base' | 'raid' | 'summary';

/** Optional range drill quest (wall block / low cover) with live feedback in the shelter. */
const Q05_QUEST = 'core.quest.q05_cover';

/** TUNABLE: camera-lead glide snaps to its target inside this distance (world units; 1/64 u = 0.25 view px). */
const LEAD_SNAP = 1 / 64;

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'warn' | 'error' | 'good';
  until: number;
}

export interface PanelState {
  name: string;
  arg: string | null;
}

export const RAID_CHECKPOINT_SECONDS = 15;

/**
 * Orchestrates modes (title → shelter → raid → summary), the fixed-step clock, input→command sampling,
 * transactional profile changes and persistence. Presentation and UI only read state and call these methods.
 */
export class GameApp implements SceneHost {
  mode: AppMode = 'boot';
  svc: ProfileService | null = null;
  ctx: SimContext | null = null;
  readonly clock = new FixedStepClock();
  paused = false;
  panel: PanelState | null = null;
  toasts: Toast[] = [];
  private toastSeq = 0;
  private opQueue: RaidOp[] = [];
  private fxQueue: SimEvent[] = [];
  private mapVersion = 0;
  private alpha = 0;
  view: ViewCamera = { cx: 0, cy: 0, k: 1 };
  visibleActors = new Set<string>();
  private lead = { x: 0, y: 0 };
  lastSummary: RaidSummary | null = null;
  pendingRecovery: { slotId: number; failure: LoadFailure } | null = null;
  settings: Settings;
  busy = false;
  onUiEvent: ((e: SimEvent) => void) | null = null;
  onRender: (() => void) | null = null;
  /** Presentation-only audio feedback for simulation events (never feeds back into the simulation). */
  onSound: ((ctx: SimContext, e: SimEvent) => void) | null = null;
  throwPreview: { x: number; y: number; z: number }[] = [];
  private throwHeld = false;
  /** Sim time at which the current R hold began (null = not held) and whether its hold action already fired. */
  private reloadHeldSince: number | null = null;
  private reloadHoldFired = false;
  private nonce = 0;
  private baseQuestTimer = 0;
  /** Shelter guidance (report / deliver / talk / range / contract), refreshed with the base quest tick. */
  guides: QuestGuide[] = [];
  /** Guides already announced; null = announce every current guide on the next refresh (fresh shelter entry). */
  private guideKeys: Set<string> | null = null;
  /** Range rental of the current shelter visit (kept across construction rebuilds, dropped on leaving). */
  private rangeRental: string | null = null;
  /** Signature of the profile loadout last mirrored into the shelter sim. */
  private loadoutSig = '';
  /** First-run controls course (mode 'tutorial'); null otherwise. */
  tutorial: TutorialDirector | null = null;
  private lastRangeCounters = { head: 0, wall: 0, low: 0, reload: 0 };
  /** Q05 drill feedback: the player was inside the turret zone at the last check. */
  private q05Inside = false;
  frameTimes: number[] = [];
  simStepMs = 0;
  /** Per-frame recording for performance runs (enabled only through the test hooks; null in normal play). */
  perfLog: { dt: number[]; sim: number[]; app: number[] } | null = null;

  constructor(
    readonly content: ContentRegistry,
    readonly store: SaveStore,
    readonly input: InputManager,
    readonly audio: AudioEngine,
    readonly rectProvider: () => { left: number; top: number; width: number; height: number },
    defaults: Settings,
  ) {
    this.settings = defaults;
  }

  get profile(): ProfileState | null {
    return this.svc?.profile ?? null;
  }

  // --- SceneHost ---------------------------------------------------------------------------------------------

  currentCtx(): SimContext | null {
    return this.mode === 'base' || this.mode === 'raid' || this.mode === 'tutorial' || this.mode === 'summary' ? this.ctx : null;
  }

  /** Modes that run the fixed-step simulation. */
  get inWorld(): boolean {
    return this.mode === 'base' || this.mode === 'raid' || this.mode === 'tutorial';
  }
  renderAlpha(): number {
    return this.alpha;
  }
  mapKey(): string {
    return `${this.ctx?.sim.mapId ?? ''}#${this.mapVersion}`;
  }
  drainFx(): SimEvent[] {
    const f = this.fxQueue;
    this.fxQueue = [];
    return f;
  }
  sceneSettings(): SceneSettings {
    return { cameraShake: this.settings.cameraShake, flashIntensity: this.settings.flashIntensity, damageNumbers: this.settings.damageNumbers, healthBars: this.settings.healthBars, debugOverlay: this.settings.debugOverlay && (import.meta.env.DEV || __E2E__) };
  }
  setView(cam: ViewCamera, visible: Set<string>): void {
    this.view = cam;
    this.visibleActors = visible;
  }
  cameraLead(): { x: number; y: number } {
    return this.lead;
  }
  onFx(e: SimEvent, screen: { x: number; y: number } | null): void {
    if (this.ctx) this.onSound?.(this.ctx, e);
    this.onUiEvent?.({ ...e, ...(screen ? { __sx: screen.x, __sy: screen.y } : {}) } as SimEvent);
  }
  throwPreviewPoints(): { x: number; y: number; z: number }[] {
    return this.throwPreview;
  }

  // --- frame loop ------------------------------------------------------------------------------------------

  frame(dt: number): void {
    const t0 = performance.now();
    this.clock.hidden = document.hidden;
    const inWorld = this.inWorld;
    this.clock.paused = this.paused || !inWorld || this.busy;
    if (inWorld && this.ctx) {
      const r = this.clock.advance(dt, (sdt) => this.step(sdt));
      this.alpha = r.alpha;
      if (r.steps > 0) this.svc?.touch((p) => (p.playTime += r.steps * SIM_DT));
      if (this.mode === 'raid' && this.ctx.sim.outcome && !this.busy) void this.endRaid();
      if (this.mode === 'tutorial' && this.ctx.sim.outcome && !this.busy) void this.finishTutorial(false);
    }
    this.updateLead(dt);
    this.updateThrowPreview();
    const now = performance.now();
    this.toasts = this.toasts.filter((t) => t.until > now);
    this.simStepMs = now - t0;
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 600) this.frameTimes.shift();
    this.onRender?.();
    if (this.perfLog) {
      this.perfLog.dt.push(dt);
      this.perfLog.sim.push(this.simStepMs);
      this.perfLog.app.push(performance.now() - t0);
    }
  }

  private updateLead(dt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const pl = ctx.sim.actors.find((a) => a.kind === 'player');
    if (!pl) return;
    const dx = pl.aim.targetX - pl.x;
    const dy = pl.aim.targetY - pl.y;
    const d = Math.hypot(dx, dy);
    const scoped = pl.handling.adsT > 0.5 && ['dmr', 'bolt'].includes(ctx.content.item(ctx.sim.store.items[pl.handling.weaponId ?? '']?.definitionId ?? 'core.weapon.p9').weapon?.class ?? '');
    const maxLead = scoped ? 10 : 6;
    const f = scoped ? 0.55 : 0.35;
    const len = Math.min(maxLead, d * f);
    const tx = d > 0.01 ? (dx / d) * len : 0;
    const ty = d > 0.01 ? (dy / d) * len : 0;
    const k = 1 - Math.exp(-dt * 6);
    // Snap the last fraction of the glide: an exponential tail would keep nudging the whole-pixel camera by one
    // pixel now and then for seconds after the cursor stopped (visible creep).
    this.lead.x = Math.abs(tx - this.lead.x) < LEAD_SNAP ? tx : this.lead.x + (tx - this.lead.x) * k;
    this.lead.y = Math.abs(ty - this.lead.y) < LEAD_SNAP ? ty : this.lead.y + (ty - this.lead.y) * k;
  }

  private updateThrowPreview(): void {
    this.throwPreview = [];
    const ctx = this.ctx;
    if (!ctx || !this.throwHeld || this.input.uiCapture) return;
    const pl = ctx.sim.actors.find((a) => a.kind === 'player');
    if (!pl || !pl.alive) return;
    const o = throwOrigin(pl);
    const v = launchVelocity(o, { x: pl.aim.targetX, y: pl.aim.targetY }, 11);
    this.throwPreview = predictTrajectory(ctx.geo, ctx.sim, pl.floor, o, v, 2.8);
  }

  private buildCommand(): PlayerCommand {
    const ctx = this.ctx!;
    const cmd = idleCommand();
    const inp = this.input;
    const rect = this.rectProvider();
    const cursor = inp.cursorClient;
    if (cursor) {
      const v = clientToView(rect, cursor.x, cursor.y);
      cmd.aim = resolveAim(ctx, this.view, v.sx, v.sy, (a) => this.visibleActors.has(a.id) || ctx.sim.mode === 'base');
    } else {
      const pl = ctx.sim.actors.find((a) => a.kind === 'player');
      if (pl) cmd.aim = { x: pl.aim.targetX, y: pl.aim.targetY, z: pl.aim.targetZ, actorId: null, viewDistPx: 999 };
    }
    if (inp.uiCapture) return cmd;
    cmd.moveX = (inp.isHeld('right') ? 1 : 0) - (inp.isHeld('left') ? 1 : 0);
    cmd.moveY = (inp.isHeld('down') ? 1 : 0) - (inp.isHeld('up') ? 1 : 0);
    cmd.sprint = inp.isHeld('sprint');
    cmd.crouchToggle = inp.consume('crouch');
    cmd.fireHeld = inp.fireHeld();
    cmd.firePressed = inp.consumeFirePress();
    cmd.adsHeld = inp.adsHeld();
    cmd.reload = inp.consume('reload');
    // Tap R = magazine swap (on press); holding R past RELOAD_HOLD_TIME = top up from loose rounds, once per hold.
    if (inp.isHeld('reload')) {
      if (this.reloadHeldSince === null || cmd.reload || ctx.sim.time < this.reloadHeldSince) {
        this.reloadHeldSince = ctx.sim.time;
        this.reloadHoldFired = false;
      }
      if (!this.reloadHoldFired && ctx.sim.time - this.reloadHeldSince >= RELOAD_HOLD_TIME - 1e-9) {
        cmd.reloadHold = true;
        this.reloadHoldFired = true;
      }
    } else this.reloadHeldSince = null;
    cmd.fireMode = inp.consume('fireMode');
    cmd.interact = inp.consume('interact');
    if (inp.consume('weapon1')) cmd.weaponSlot = 'primary1';
    if (inp.consume('weapon2')) cmd.weaponSlot = 'primary2';
    if (inp.consume('weapon3')) cmd.weaponSlot = 'secondary';
    for (let i = 0; i < 4; i++) if (inp.consume(`quick${i + 1}` as 'quick1')) cmd.quickslot = i;
    cmd.melee = inp.consume('melee');
    cmd.dodge = inp.consume('dodge');
    // Throw: hold G to preview the arc (same integrator as the real throw), release to throw.
    const gHeld = inp.isHeld('throw');
    inp.consume('throw');
    if (this.throwHeld && !gHeld) cmd.throwPressed = true;
    this.throwHeld = gHeld;
    return cmd;
  }

  private step(dt: number): void {
    const ctx = this.ctx!;
    const cmd = this.buildCommand();
    const ops = this.opQueue.splice(0);
    const out = stepSim(ctx, { cmd, ops }, dt);
    for (const r of out.opResults) if (!r.ok && r.error) this.toast(this.content.t(r.error), 'warn');
    const fx = ctx.sim.fx;
    ctx.sim.fx = [];
    for (const e of fx) {
      this.fxQueue.push(e);
      if (e.t === 'ui' || e.t === 'message' || e.t === 'objective' || e.t === 'event' || e.t === 'extracted' || e.t === 'died') this.handleSimUi(e);
    }
    if (this.mode === 'base') this.baseTick(dt);
    else if (this.mode === 'tutorial') this.tutorialTick(dt, fx);
    else if (this.mode === 'raid') {
      if (!ctx.sim.outcome && ctx.sim.time - ctx.sim.lastCheckpointTime >= RAID_CHECKPOINT_SECONDS) {
        ctx.sim.lastCheckpointTime = ctx.sim.time;
        void this.checkpointRaid();
      }
    }
    if (this.fxQueue.length > 2000) this.fxQueue.splice(0, this.fxQueue.length - 2000);
  }

  private handleSimUi(e: SimEvent): void {
    if (e.t === 'message') this.toast(this.content.t(e.key, e.params), 'info');
    else if (e.t === 'objective') this.toast(`${this.content.t('toast.discovered')}: ${this.content.t(e.key)}`, 'good');
    else if (e.t === 'ui') {
      if (e.kind === 'loot') this.openPanel('loot', e.id);
      else if (e.kind === 'lootClosed') {
        if (this.panel?.name === 'loot') this.closePanel();
      } else if (e.kind === 'note') this.openPanel('note', e.id);
      else if (e.kind === 'npc') this.openPanel('npc', e.id);
      else if (e.kind === 'station' || e.kind === 'range' || e.kind === 'switch') this.openPanel(`station:${e.id}`, e.id);
    }
    this.onUiEvent?.(e);
  }

  // --- base mode -------------------------------------------------------------------------------------------

  private baseTick(dt: number): void {
    const p = this.profile;
    const ctx = this.ctx;
    if (!p || !ctx) return;
    // Crafting time only advances while the shelter simulation runs.
    const done = tickCrafting(p, dt);
    for (const jobId of done) void this.tx(`craftdone:${jobId}`, (d) => completeCraft(d, this.content, jobId, `craftdone:${jobId}`), 'craft.done');
    this.baseQuestTimer += dt;
    if (this.baseQuestTimer < 0.25) return;
    this.baseQuestTimer = 0;
    this.syncShelterLoadout();
    this.updateGuidance();
    const r = ctx.sim.range;
    const pl = ctx.sim.actors.find((a) => a.kind === 'player');
    const events: { t: 'custom' | 'head'; target: string; amount: number }[] = [];
    if (r) {
      if (r.reloads > this.lastRangeCounters.reload && ctx.geo.regionAt(pl?.x ?? 0, pl?.y ?? 0)?.id === 'core.region.range') events.push({ t: 'custom', target: 'range_reload', amount: r.reloads - this.lastRangeCounters.reload });
      if (r.headHits > this.lastRangeCounters.head) events.push({ t: 'head', target: 'head', amount: r.headHits - this.lastRangeCounters.head });
      if (r.wallBlocks > this.lastRangeCounters.wall) events.push({ t: 'custom', target: 'range_wall_block', amount: r.wallBlocks - this.lastRangeCounters.wall });
      if (r.lowCoverHits > this.lastRangeCounters.low) events.push({ t: 'custom', target: 'range_low_cover', amount: r.lowCoverHits - this.lastRangeCounters.low });
      this.q05Feedback(ctx, pl, r.wallBlocks - this.lastRangeCounters.wall, r.lowCoverHits - this.lastRangeCounters.low);
      this.lastRangeCounters = { head: r.headHits, wall: r.wallBlocks, low: r.lowCoverHits, reload: r.reloads };
    }
    if (events.length === 0) return;
    const relevant = events.some((ev) => this.questWants(ev.t === 'head' ? 'HitPart' : 'CustomValidated', ev.target));
    if (!relevant) return;
    void this.tx(`basequest:${this.nextNonce()}`, (d) => {
      for (const ev of events) {
        if (ev.t === 'custom') applyQuestEvent(d, this.content, { type: 'Custom', target: ev.target, amount: ev.amount });
        else applyQuestEvent(d, this.content, { type: 'HitPart', part: 'head', context: 'range', amount: ev.amount });
      }
    });
  }

  /**
   * Q05 drill feedback while the quest is active: entering the marked turret zone explains what happens there, and
   * every training round the wall stops (and the low-cover hit) is announced with the objective's progress.
   */
  private q05Feedback(ctx: SimContext, pl: ActorState | undefined, wallDelta: number, lowDelta: number): void {
    const p = this.profile;
    const q = this.content.quests.get(Q05_QUEST);
    const st = p?.quests[Q05_QUEST];
    if (!p || !q || !pl || st?.status !== 'active') {
      this.q05Inside = false;
      return;
    }
    const wall = q.objectives.find((o) => o.target === 'range_wall_block');
    const low = q.objectives.find((o) => o.target === 'range_low_cover');
    const wallDone = wall ? (st.progress[wall.id] ?? 0) : 0;
    const zone = ctx.geo.map.turrets?.[0]?.zone;
    const inside = !!zone && rectContains(zone, pl.x, pl.y);
    if (wall && wallDone < wall.count) {
      if (inside && !this.q05Inside) this.toast(this.content.t('q05.toast.enter'), 'info', 5200);
      if (wallDelta > 0) this.toast(this.content.t('q05.toast.block', { n: Math.min(wall.count, wallDone + wallDelta), count: wall.count }), 'good', 2200);
    }
    if (low && lowDelta > 0 && (st.progress[low.id] ?? 0) < low.count) this.toast(this.content.t('q05.toast.low'), 'good', 2200);
    this.q05Inside = inside;
  }

  /** Rent a weapon at the range rack for this shelter visit (into its class slot; the loadout's other weapons stay). */
  rentRangeWeapon(defId: string): void {
    if (this.mode !== 'base') return;
    this.rangeRental = defId;
    this.queueOp({ op: 'rangeWeapon', defId });
  }

  /** Equipping / unequipping in the shelter UI changes the profile: mirror it into the running shelter sim. */
  private syncShelterLoadout(): void {
    const p = this.profile;
    const ctx = this.ctx;
    if (!p || !ctx || this.mode !== 'base') return;
    const loadout = profileTrainingLoadout(p.store, this.content);
    const sig = JSON.stringify(loadout);
    if (sig === this.loadoutSig) return;
    this.loadoutSig = sig;
    const pl = ctx.sim.actors.find((a) => a.kind === 'player');
    if (!pl) return;
    pl.action = null;
    for (const s of ['primary1', 'primary2', 'secondary', 'melee'] as const) {
      const id = ctx.sim.store.containers[`eq:${pl.id}:${s}`]?.items[0];
      if (id) destroyItem(ctx.sim.store, id);
    }
    for (const w of loadout) issueTrainingWeapon(ctx, pl, w);
    // Changing the own loadout ends the rental: the player now carries exactly what they equipped.
    this.rangeRental = null;
    if (!ctx.sim.store.containers[`eq:${pl.id}:${pl.activeSlot}`]?.items.length) pl.activeSlot = firstArmedSlot(ctx.sim, pl);
    pl.handling.weaponId = null;
  }

  /**
   * Recompute who the player should go to in the shelter; newly appeared report / deliver / contract guides are
   * announced once with a toast naming the NPC (HUD markers and edge arrows read `guides` every frame).
   */
  updateGuidance(): void {
    const p = this.profile;
    if (!p || this.mode !== 'base') {
      this.guides = [];
      return;
    }
    // Optional range drills (Q05 spots) are marked only while the player is inside the shooting range.
    const pl = this.ctx?.sim.actors.find((a) => a.kind === 'player');
    const inRange = !!pl && this.ctx!.geo.regionAt(pl.x, pl.y)?.id === 'core.region.range';
    const list = [...shelterGuides(p, this.content), ...(inRange ? rangeDrillGuides(p, this.content) : [])];
    const prev = this.guideKeys;
    this.guides = list;
    this.guideKeys = new Set(list.map(guideKey));
    for (const g of list) {
      if (prev?.has(guideKey(g))) continue;
      const text = guideToast(g, this.content);
      if (text) this.toast(text, 'good', 5200);
    }
  }

  /** Guidance markers for the current tutorial step (none outside the tutorial). */
  tutorialMarks(): GuideMark[] {
    const t = this.tutorial;
    if (this.mode !== 'tutorial' || !t || t.finished) return [];
    const g = t.target();
    if (!g) return [];
    return [{ key: g.key, x: g.x, y: g.y, z: g.z, icon: '▼', label: this.content.t(g.labelKey), name: this.content.t(g.nameKey), tone: 'task' }];
  }

  // --- tutorial --------------------------------------------------------------------------------------------------

  /** Start (or resume at the saved step) the first-run controls course. Nothing here touches the economy. */
  enterTutorial(): void {
    const p = this.profile;
    if (!p) return;
    this.ctx = createTutorialSim(this.content, `${p.seed}|tutorial`);
    this.tutorial = new TutorialDirector(this.ctx, p.tutorial.step);
    this.mapVersion++;
    this.mode = 'tutorial';
    this.paused = false;
    this.panel = null;
    this.guides = [];
    this.clock.reset();
    this.input.uiCapture = false;
    this.toasts = [];
    this.audio.loop('amb', 'amb.shelter', 0.6);
    this.audio.loop('music', 'music.base', 0.5);
    if (p.tutorial.step > 0) this.toast(this.content.t('tutorial.resume', { n: this.tutorial.step + 1, total: TUTORIAL_STEPS.length }), 'info');
  }

  private tutorialTick(dt: number, fx: SimEvent[]): void {
    const t = this.tutorial;
    if (!t || !this.svc) return;
    const done = t.update(dt, fx, this.panel?.name ?? null);
    for (const g of t.gifts.splice(0)) this.toast(this.content.t('tutorial.gift', { item: this.content.t(this.content.item(g).nameKey) }), 'info');
    if (!done) return;
    this.audio.play('ui.confirm');
    this.toast(this.content.t('tutorial.step_done', { title: this.content.t(`tutorial.s.${done}.title`) }), 'good', 1800);
    // Everything was taken: close the loot view so the next lesson (open the bag with Tab) starts from the game view.
    if (done === 'loot' && this.panel?.name === 'loot') this.closePanel();
    // Persist the next lesson so a reload resumes there (the course itself restarts from its map).
    const next = Math.min(t.step, TUTORIAL_STEPS.length - 1);
    void this.tx(`tutorial:${next}:${this.nextNonce()}`, (d) => {
      d.tutorial.step = Math.max(d.tutorial.step, next);
    });
  }

  /** Leave the course for the shelter: completed (extracted) or skipped. Marks the tutorial done in the save. */
  async finishTutorial(skipped: boolean): Promise<void> {
    if (this.mode !== 'tutorial' || this.busy || !this.svc) return;
    this.busy = true;
    const r = await this.tx(`tutorial:done:${this.svc.profile.slotId}`, (d) => {
      d.tutorial = { step: TUTORIAL_STEPS.length, done: true, skipped };
    });
    this.busy = false;
    if (!r.ok) {
      // Save failed (toast already shown): hold here instead of retrying every frame.
      this.paused = true;
      this.panel = { name: 'pause', arg: 'save_error' };
      this.input.uiCapture = true;
      return;
    }
    this.tutorial = null;
    this.enterBase();
    this.toast(this.content.t(skipped ? 'tutorial.skipped' : 'tutorial.complete'), 'good', 6000);
  }

  skipTutorial(): void {
    if (this.panel) this.closePanel();
    void this.finishTutorial(true);
  }

  questWants(type: string, target: string): boolean {
    const p = this.profile;
    if (!p) return false;
    for (const q of this.content.quests.values()) {
      const st = p.quests[q.id];
      if (!st || st.status !== 'active') continue;
      for (const o of q.objectives) {
        if (o.type !== type) continue;
        if ((o.target === target || o.part === target) && (st.progress[o.id] ?? 0) < o.count) return true;
      }
    }
    return false;
  }

  nextNonce(): string {
    return `${Date.now().toString(36)}-${(++this.nonce).toString(36)}`;
  }

  /** Run a profile transaction; toasts on failure. */
  async tx<T>(txId: string, fn: (d: ProfileState) => T, successKey?: string): Promise<TxOutcome<T>> {
    if (!this.svc) return { ok: false, applied: false, reason: 'no-profile' };
    const r = await this.svc.run(txId, fn);
    if (!r.ok) {
      this.toast(this.content.t(r.reason), 'error');
      this.audio.play('ui.error');
    } else if (r.applied && successKey) {
      this.toast(this.content.t(successKey), 'good');
      this.audio.play('ui.confirm');
    }
    this.onRender?.();
    return r;
  }

  enterBase(spawn?: { x: number; y: number }): void {
    const p = this.profile;
    if (!p) return;
    ensureContracts(p, this.content);
    ensureMarket(p, this.content);
    for (const t of this.content.traders.keys()) ensureTraderStock(p, this.content, t);
    refreshQuests(p, this.content);
    this.tutorial = null;
    if (!spawn) this.rangeRental = null;
    this.loadoutSig = JSON.stringify(profileTrainingLoadout(p.store, this.content));
    this.ctx = createBaseSim(this.content, {
      seed: `${p.seed}|base|${p.generation}`,
      flags: p.flags,
      perks: aggregatePerks(this.content, p.perks),
      // The player's own equipped weapons (training copies); a range rental only for this shelter visit.
      loadout: profileTrainingLoadout(p.store, this.content),
      weaponDefId: spawn ? this.rangeRental : null,
      extraObstacles: buildingObstacles(p, this.content),
      extraInteractables: buildingInteractables(p, this.content),
      ...(spawn ? { spawn } : {}),
    });
    this.ctx.sim.debug = { ...this.ctx.sim.debug };
    this.lastRangeCounters = { head: 0, wall: 0, low: 0, reload: 0 };
    this.mapVersion++;
    this.mode = 'base';
    this.paused = false;
    this.panel = null;
    this.clock.reset();
    this.input.uiCapture = false;
    this.audio.loop('amb', 'amb.shelter', 0.6);
    this.audio.loop('music', 'music.base', 0.5);
    // A fresh arrival (new game, continue, back from a raid) re-announces pending turn-ins; a geometry rebuild
    // after construction (spawn kept) does not.
    if (!spawn) this.guideKeys = null;
    this.updateGuidance();
  }

  /** Rebuild the shelter geometry after construction changes, keeping the player position. */
  rebuildBase(): void {
    if (this.mode !== 'base' || !this.ctx) return;
    const pl = this.ctx.sim.actors.find((a) => a.kind === 'player');
    this.enterBase(pl ? { x: pl.x, y: pl.y } : undefined);
  }

  // --- title / slots -----------------------------------------------------------------------------------------

  async newGame(slotId: number, name: string): Promise<void> {
    const seed = `slot${slotId}-${Date.now().toString(36)}-${Math.floor(performance.now() * 1000).toString(36)}`;
    const p = newProfile(this.content, slotId, name || `생존자 ${slotId}`, seed, Date.now());
    p.settings = { ...this.settings };
    await this.store.commit(slotId, p, null, `newgame:${slotId}:${seed}`);
    this.svc = new ProfileService(this.store, p);
    // A brand-new slot starts in the controls course (skippable); the shelter follows when it is finished.
    if (!p.tutorial.done) this.enterTutorial();
    else this.enterBase();
  }

  async continueGame(slotId: number, allowBackup = false): Promise<boolean> {
    const r = await this.store.load(slotId, this.content, allowBackup);
    if ('kind' in r) {
      if (r.kind === 'corrupt') this.pendingRecovery = { slotId, failure: r };
      return false;
    }
    this.pendingRecovery = null;
    const lr = r as LoadResult;
    this.svc = new ProfileService(this.store, lr.profile);
    this.settings = { ...this.settings, ...lr.profile.settings };
    this.applySettings();
    if (lr.recoveredFrom) {
      // Persist the restored backup as the new current snapshot (the corrupted record is rotated out).
      await this.svc.checkpoint(lr.raid ?? undefined);
      this.toast(this.content.t('save.recovered'), 'warn');
    }
    if (lr.quarantined > 0) this.toast(this.content.t('save.quarantined', { n: lr.quarantined }), 'warn');
    if (lr.profile.activeRaid) {
      if (lr.raid) {
        // The procedural layout is rebuilt from the snapshot's layout seed (identical to the one it was played on).
        this.ctx = makeContext(lr.raid, this.content, raidGeometry(this.content, lr.raid));
        this.mapVersion++;
        this.mode = 'raid';
        this.paused = true;
        this.panel = { name: 'pause', arg: 'resumed' };
        this.clock.reset(lr.raid.tick);
        this.startRaidAudio();
        return true;
      }
      // Raid snapshot unrecoverable: close the raid as lost (loadout already left the profile at deployment).
      await this.svc.run(`raidlost:${lr.profile.activeRaid.raidId}`, (d) => {
        d.activeRaid = null;
        d.generation++;
      }, { raid: null });
      this.toast(this.content.t('save.raid_lost'), 'error');
    }
    if (!this.svc.profile.tutorial.done) this.enterTutorial();
    else this.enterBase();
    return true;
  }

  async backToTitle(): Promise<void> {
    if (this.mode === 'raid' && this.ctx && this.svc) await this.checkpointRaid();
    else if (this.svc) await this.svc.checkpoint(undefined);
    this.mode = 'title';
    this.ctx = null;
    this.tutorial = null;
    this.svc = null;
    this.panel = null;
    this.paused = false;
    this.audio.stopLoop('amb');
    this.audio.loop('music', 'music.title', 0.5);
  }

  // --- raid ------------------------------------------------------------------------------------------------------

  async deploy(destId: string): Promise<boolean> {
    if (!this.svc || this.busy) return false;
    this.busy = true;
    const holder: { ctx: SimContext | null } = { ctx: null };
    const counter = this.svc.profile.raidCounter + 1;
    const r = await this.svc.run(
      `deploy:${this.svc.profile.slotId}:${counter}`,
      (d) => prepareDeploy(d, this.content, destId, Date.now()),
      {
        raid: (launch, draft) => {
          const created = createRaidSim(this.content, { ...launch, flags: { ...launch.flags } });
          created.sim.credits = draft.currency;
          holder.ctx = created.ctx;
          return created.sim;
        },
        pinRaid: true,
      },
    );
    this.busy = false;
    if (!r.ok || !r.applied || !holder.ctx) {
      if (!r.ok) this.toast(this.content.t(r.reason), 'error');
      return false;
    }
    this.ctx = holder.ctx;
    this.mapVersion++;
    this.mode = 'raid';
    this.paused = false;
    this.panel = null;
    this.input.uiCapture = false;
    this.clock.reset();
    this.startRaidAudio();
    this.toasts = [];
    const f = this.ctx.sim.env;
    this.toast(`${this.content.t(this.content.map(this.ctx.sim.mapId).nameKey)} · ${this.content.t(this.content.timePhase(f.phase).nameKey)} · ${this.content.t(this.content.weather(f.weather).nameKey)}`, 'info');
    return true;
  }

  /** Re-apply the loops for the current mode (after the first-gesture unlock). Loops are keyed, so this never duplicates BGM. */
  resyncAudio(): void {
    if (this.mode === 'title' || this.mode === 'boot') {
      this.audio.stopLoop('amb');
      this.audio.loop('music', 'music.title', 0.5);
    } else if (this.mode === 'base' || this.mode === 'tutorial') {
      this.audio.loop('amb', 'amb.shelter', 0.6);
      this.audio.loop('music', 'music.base', 0.5);
    } else if (this.mode === 'raid') this.startRaidAudio();
  }

  private startRaidAudio(): void {
    const sim = this.ctx?.sim;
    if (!sim) return;
    const w = this.content.weather(sim.env.weather);
    this.audio.loop('amb', sim.env.phase === 'Night' && w.id === 'Clear' ? 'amb.night' : `amb.${w.ambience}`, 0.7);
    this.audio.loop('music', 'music.raid', 0.35);
  }

  queueOp(op: RaidOp): void {
    this.opQueue.push(op);
  }

  async checkpointRaid(): Promise<void> {
    // Only a real raid is persisted as a raid snapshot (the tutorial sim runs raid rules but is never saved).
    if (!this.svc || !this.ctx || this.mode !== 'raid' || this.ctx.sim.mode !== 'raid' || this.ctx.sim.training || this.ctx.sim.outcome) return;
    this.ctx.sim.rng = this.ctx.rng.getState();
    const snap = structuredClone({ ...this.ctx.sim, fx: [] });
    await this.svc.checkpoint(snap);
  }

  private async endRaid(): Promise<void> {
    if (!this.svc || !this.ctx || this.busy) return;
    this.busy = true;
    const sim = this.ctx.sim;
    const r = await this.svc.run(`raidend:${sim.raidId}`, (d) => commitRaidEnd(d, this.content, sim), { raid: null });
    this.busy = false;
    if (r.ok && r.applied) {
      this.lastSummary = r.value;
      this.mode = 'summary';
      this.panel = { name: 'summary', arg: null };
      this.input.uiCapture = true;
      this.audio.play(r.value.outcome === 'extracted' ? 'ui.quest' : 'ui.error');
    } else if (r.ok && !r.applied) {
      this.lastSummary = this.svc.profile.lastRaidSummary;
      this.mode = 'summary';
      this.panel = { name: 'summary', arg: null };
    } else {
      this.toast(this.content.t(r.reason), 'error');
      // Keep the finished raid frozen; retry on next frame is avoided by pausing until the user acts.
      this.paused = true;
      this.panel = { name: 'pause', arg: 'save_error' };
    }
  }

  continueFromSummary(): void {
    this.lastSummary = null;
    this.enterBase();
    const p = this.profile;
    if (p?.chapter.completed && !p.chapter.epilogueSeen) this.openPanel('chapter', null);
  }

  // --- panels & pause -------------------------------------------------------------------------------------------

  openPanel(name: string, arg: string | null): void {
    this.panel = { name, arg };
    this.input.uiCapture = true;
    this.input.releaseAll();
    this.audio.play('ui.click');
    if (name === 'npc' && arg) void this.onTalk(arg);
  }

  closePanel(): void {
    if (this.panel?.name === 'loot') this.queueOp({ op: 'closeLoot' });
    // Settings opened from the pause menu return to it: the game is still paused behind them.
    if (this.panel?.name === 'settings' && this.paused && this.inWorld) {
      this.panel = { name: 'pause', arg: null };
      return;
    }
    const wasPause = this.panel?.name === 'pause';
    this.panel = null;
    this.input.uiCapture = false;
    this.input.clearEdges();
    if (wasPause) this.paused = false;
  }

  togglePause(): void {
    if (!this.inWorld) return;
    if (this.panel && this.panel.name !== 'pause') {
      this.closePanel();
      return;
    }
    if (this.panel?.name === 'pause') {
      this.closePanel();
      return;
    }
    this.paused = true;
    this.panel = { name: 'pause', arg: null };
    this.input.uiCapture = true;
    this.input.releaseAll();
    if (this.mode === 'raid') void this.checkpointRaid();
  }

  private async onTalk(npcInteractId: string): Promise<void> {
    const p = this.profile;
    if (!p) return;
    const target = `npc.${npcInteractId.replace('core.npc.', '')}`;
    if (this.questWants('Interact', target)) await this.tx(`talk:${target}:${p.generation}:${this.nextNonce()}`, (d) => applyQuestEvent(d, this.content, { type: 'Interact', target }));
  }

  toast(text: string, kind: Toast['kind'] = 'info', ms = 3200): void {
    // Identical messages in the same frame (e.g. a POI and an interior sharing a name) show once; extend its timer.
    const same = this.toasts.find((t) => t.text === text && t.kind === kind);
    if (same) {
      same.until = Math.max(same.until, performance.now() + ms);
      return;
    }
    this.toasts.push({ id: ++this.toastSeq, text, kind, until: performance.now() + ms });
    if (this.toasts.length > 6) this.toasts.shift();
  }

  applySettings(): void {
    this.audio.setVolumes(this.settings.volumes);
    this.input.aimToggleMode = this.settings.aimToggle;
    const b = this.settings.bindings;
    for (const k of Object.keys(b)) (this.input.bindings as Record<string, string[]>)[k] = b[k]!;
    document.documentElement.style.setProperty('--ui-scale', String(this.settings.uiScale / 100));
    document.documentElement.dataset['shapes'] = this.settings.shapeCues ? 'on' : 'off';
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    this.settings = { ...this.settings, ...patch, volumes: { ...this.settings.volumes, ...(patch.volumes ?? {}) } };
    this.applySettings();
    await this.store.setMeta('settings', this.settings);
    if (this.svc) this.svc.touch((p) => (p.settings = { ...this.settings }));
  }
}
