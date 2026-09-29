import Phaser from 'phaser';
import type { ContentRegistry } from '../content/registry';
import { TILE_PX, VIEW_H, VIEW_W, worldToView, type ViewCamera, clampFocus } from '../core/coords';
import { hitboxOf, activeWeaponItem, equippedItem, type SimContext } from '../world/context';
import type { ObstacleRuntime } from '../world/geometry';
import { MELEE_ARC_Z, MELEE_HALF_CONE, meleeArcRadius } from '../world/melee';
import { inIframes, type ActorState, type SimEvent } from '../world/state';
import { birdSheet, BIRDS, FRAME_COUNT, FRAME_H, FRAME_W, FEET_Y, FRAMES, simpleDot, weaponSprite } from './sprites';
import { canopyTexture, obstacleTexture, renderGround, roofTexture } from './tiles';
import { Px } from './pixel';

export interface SceneSettings {
  cameraShake: number;
  flashIntensity: number;
  damageNumbers: boolean;
  healthBars: boolean;
  debugOverlay: boolean;
}

/** What the scene needs from the game application (the scene never mutates authoritative state). */
export interface SceneHost {
  content: ContentRegistry;
  frame(dtSec: number): void;
  currentCtx(): SimContext | null;
  renderAlpha(): number;
  mapKey(): string;
  drainFx(): SimEvent[];
  sceneSettings(): SceneSettings;
  setView(cam: ViewCamera, visible: Set<string>): void;
  onFx(e: SimEvent, screen: { x: number; y: number } | null): void;
  cameraLead(): { x: number; y: number };
  /** Predicted throw arc (world units) while the throw key is held; empty otherwise. */
  throwPreviewPoints(): { x: number; y: number; z: number }[];
}

interface ActorView {
  body: Phaser.GameObjects.Sprite;
  weapon: Phaser.GameObjects.Image | null;
  weaponKey: string | null;
  shadow: Phaser.GameObjects.Image;
  hpBar: Phaser.GameObjects.Rectangle;
  hpBack: Phaser.GameObjects.Rectangle;
  alpha: number;
  walkPhase: number;
  lastX: number;
  lastY: number;
  /** Sim time until which the sprite shows the white melee hit flash. */
  flashUntil: number;
  flashOn: boolean;
}

/**
 * Melee swing arc (presentation only): sweeps across the ±70° strike cone, then fades. Timed on simulation time so
 * it freezes with the game when paused.
 */
interface Slash {
  x: number;
  y: number;
  ang: number;
  reach: number;
  hit: boolean;
  born: number;
}

/** TUNABLE (presentation): melee swing arc lifetime and the target hit-flash duration, seconds. */
const SLASH_LIFE = 0.26;
const MELEE_FLASH = 0.12;
const MELEE_HALF_ARC = MELEE_HALF_CONE;

interface ObView {
  img: Phaser.GameObjects.Image;
  ob: ObstacleRuntime;
  tall: boolean;
}

interface Particle {
  obj: Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle;
  vx: number;
  vy: number;
  life: number;
  max: number;
  gravity: number;
  fade: boolean;
}

/** Cosmetic-only PRNG (never used for game rules). */
class CosmeticRng {
  private s = 0x9e3779b9;
  next(): number {
    this.s ^= this.s << 13;
    this.s ^= this.s >>> 17;
    this.s ^= this.s << 5;
    return (this.s >>> 0) / 4294967296;
  }
}

const WEAPON_KEY = (defId: string) => defId.split('.').pop() ?? 'p9';

export class WorldScene extends Phaser.Scene {
  host!: SceneHost;
  private builtKey = '';
  private layer: Phaser.GameObjects.GameObject[] = [];
  private obViews: ObView[] = [];
  private doorViews = new Map<string, Phaser.GameObjects.Image[]>();
  private roofViews: { img: Phaser.GameObjects.Image; rect: { x: number; y: number; w: number; h: number } }[] = [];
  private canopies: { img: Phaser.GameObjects.Image; x: number; y: number }[] = [];
  private actorViews = new Map<string, ActorView>();
  private containerViews = new Map<string, Phaser.GameObjects.Image>();
  private tracer!: Phaser.GameObjects.Graphics;
  private overlayG!: Phaser.GameObjects.Graphics;
  private debugG!: Phaser.GameObjects.Graphics;
  private weatherG!: Phaser.GameObjects.Graphics;
  private dark!: Phaser.GameObjects.Image;
  private darkKey = '';
  private flash!: Phaser.GameObjects.Rectangle;
  private hurt!: Phaser.GameObjects.Rectangle;
  private particles: Particle[] = [];
  private telegraphs: { actorId: string; tx: number; ty: number; until: number }[] = [];
  private slashes: Slash[] = [];
  private shake = 0;
  private focus = { x: 0, y: 0 };
  private rng = new CosmeticRng();
  private lastFrame = 0;
  private lightningT = 0;
  private smokeViews = new Map<string, Phaser.GameObjects.Image>();
  private thrownViews = new Map<string, Phaser.GameObjects.Image>();
  private lightViews: Phaser.GameObjects.Image[] = [];
  visible = new Set<string>();

  constructor() {
    super('world');
  }

  init(data: { host: SceneHost }): void {
    this.host = data.host;
  }

  create(): void {
    this.makeBaseTextures();
    this.tracer = this.add.graphics().setDepth(1e6);
    this.overlayG = this.add.graphics().setDepth(2e6);
    this.debugG = this.add.graphics().setDepth(5e6);
    this.weatherG = this.add.graphics().setDepth(3.5e6).setScrollFactor(0);
    this.dark = this.add.image(VIEW_W / 2, VIEW_H / 2, '__WHITE').setScrollFactor(0).setDepth(3e6).setVisible(false);
    this.flash = this.add.rectangle(0, 0, VIEW_W, VIEW_H, 0xffffff, 0).setOrigin(0, 0).setScrollFactor(0).setDepth(4e6);
    this.hurt = this.add.rectangle(0, 0, VIEW_W, VIEW_H, 0xb01818, 0).setOrigin(0, 0).setScrollFactor(0).setDepth(4e6);
    this.cameras.main.setRoundPixels(true);
    this.cameras.main.setBackgroundColor('#0d0e11');
    this.lastFrame = performance.now();
  }

  private addCanvasTexture(key: string, px: Px): void {
    if (this.textures.exists(key)) this.textures.remove(key);
    this.textures.addCanvas(key, px.toCanvas());
  }

  private makeBaseTextures(): void {
    for (const b of BIRDS) {
      const sheet = birdSheet(b);
      const key = `bird:${b.id}`;
      const tex = this.textures.addCanvas(key, sheet.toCanvas())!;
      for (let i = 0; i < FRAME_COUNT; i++) tex.add(i, 0, i * FRAME_W, 0, FRAME_W, FRAME_H);
    }
    for (const k of ['p9', 'h45', 'sm9', 'sm45', 'c556', 'ar556', 'ar762', 'sgp', 'sga', 'dmr', 'bolt', 'lmg']) {
      const ws = weaponSprite(k);
      this.addCanvasTexture(`wpn:${k}`, ws.px);
    }
    this.addCanvasTexture('dot:spark', simpleDot(1, 0xffe08a));
    this.addCanvasTexture('dot:smoke', simpleDot(10, 0xb8bcc0, true));
    this.addCanvasTexture('dot:glow', simpleDot(12, 0xffd9a0, true));
    this.addCanvasTexture('dot:flash', simpleDot(4, 0xfff0b0, true));
    this.addCanvasTexture('dot:shadow', (() => {
      const p = new Px(14, 5);
      p.ellipse(7, 2.5, 6.5, 2.2, 0x000000, 80);
      return p;
    })());
    const feather = new Px(3, 2);
    feather.rect(0, 0, 3, 1, 0xd8d8d0).set(1, 1, 0xa0a0a0);
    this.addCanvasTexture('dot:feather', feather);
    const grenade = new Px(4, 4);
    grenade.ellipse(2, 2, 1.6, 1.8, 0x4a5a3a).outline(0x101010);
    this.addCanvasTexture('dot:grenade', grenade);
    const flare = new Px(5, 9);
    flare.rect(2, 3, 1, 6, 0x8a8a8a).ellipse(2.5, 2, 2, 2, 0xff3030);
    this.addCanvasTexture('prop:flare', flare);
    const pile = new Px(20, 12);
    pile.ellipse(10, 7, 9, 4.5, 0x6a6a6e).noise(1, 2, 18, 10, 0x8a7a6a, 0.3, 3).noise(1, 2, 18, 10, 0x4a4a4e, 0.2, 4).outline(0x1a1a1a);
    this.addCanvasTexture('prop:scrap', pile);
    const cart = new Px(22, 16);
    cart.rect(1, 3, 20, 8, 0x7a5a36).rect(1, 3, 20, 1, 0x9a7448).ellipse(5, 13, 2.5, 2.5, 0x2a2a2a).ellipse(17, 13, 2.5, 2.5, 0x2a2a2a).rect(4, 0, 14, 3, 0x4a6a3a).outline(0x141414);
    this.addCanvasTexture('prop:cart', cart);
    const bag = new Px(12, 10);
    bag.ellipse(6, 6, 5.5, 4, 0x5b6b4a).rect(4, 1, 4, 2, 0x3e4a33).outline(0x141414);
    this.addCanvasTexture('prop:deathbag', bag);
    const dropTex = new Px(10, 8);
    dropTex.rect(1, 2, 8, 5, 0x8a7a5a).rect(1, 2, 8, 1, 0xb0a070).outline(0x141414);
    this.addCanvasTexture('prop:drop', dropTex);
  }

  // --- map build ------------------------------------------------------------------------------------------------

  private clearMap(): void {
    for (const o of this.layer) o.destroy();
    this.layer = [];
    this.obViews = [];
    this.doorViews.clear();
    this.roofViews = [];
    this.canopies = [];
    for (const v of this.actorViews.values()) this.destroyActorView(v);
    this.actorViews.clear();
    for (const v of this.containerViews.values()) v.destroy();
    this.containerViews.clear();
    for (const v of this.smokeViews.values()) v.destroy();
    this.smokeViews.clear();
    for (const v of this.thrownViews.values()) v.destroy();
    this.thrownViews.clear();
    this.lightViews = [];
    for (const p of this.particles) p.obj.destroy();
    this.particles = [];
  }

  private buildMap(ctx: SimContext): void {
    this.clearMap();
    const map = ctx.geo.map;
    const gkey = `ground:${map.id}`;
    if (this.textures.exists(gkey)) this.textures.remove(gkey);
    this.textures.addCanvas(gkey, renderGround(map, ctx.geo.grounds));
    this.layer.push(this.add.image(0, 0, gkey).setOrigin(0, 0).setDepth(-1e6));
    // Obstacles, sliced into 1u-deep strips so y-sorting stays correct next to long N-S walls.
    for (const ob of ctx.geo.obstacles) {
      const render = ob.profile.render;
      if (render === 'none') continue;
      const b = ob.box;
      const wPx = Math.max(1, Math.round((b.x1 - b.x0) * TILE_PX));
      const depthU = b.y1 - b.y0;
      const hPx = Math.max(1, Math.round((b.z1 - b.z0) * TILE_PX));
      const slices = Math.max(1, Math.ceil(depthU - 1e-6));
      const variant = ob.def.variant ?? (ob.index % 7);
      for (let s = 0; s < slices; s++) {
        const sy0 = b.y0 + s;
        const sy1 = Math.min(b.y1, b.y0 + s + 1);
        const front = s === slices - 1;
        const dPx = Math.max(1, Math.round((sy1 - sy0) * TILE_PX));
        const key = `ob:${render}:${wPx}:${dPx}:${front ? hPx : 0}:${variant}`;
        if (!this.textures.exists(key)) this.addCanvasTexture(key, obstacleTexture(render, wPx, dPx, hPx, variant, front));
        const img = this.add.image(Math.round(b.x0 * TILE_PX), Math.round(sy0 * TILE_PX - b.z1 * TILE_PX), key).setOrigin(0, 0);
        img.setDepth(sy1 * 100 + (ob.profile.foliage ? 0.5 : 0));
        this.layer.push(img);
        const view: ObView = { img, ob, tall: b.z1 > 1.9 && !ob.profile.foliage };
        this.obViews.push(view);
        if (ob.doorId) {
          const list = this.doorViews.get(ob.doorId) ?? [];
          list.push(img);
          this.doorViews.set(ob.doorId, list);
        }
      }
    }
    for (const d of map.decor) {
      if (d.kind === 'canopy' || d.kind === 'canopy_pine') {
        const key = `canopy:${d.kind}:${d.variant % 3}`;
        if (!this.textures.exists(key)) this.addCanvasTexture(key, canopyTexture(d.kind, d.variant));
        const img = this.add.image(Math.round(d.x * TILE_PX), Math.round(d.y * TILE_PX - (d.kind === 'canopy_pine' ? 2.2 : 3.2) * TILE_PX), key).setOrigin(0.5, 1);
        img.setDepth(d.y * 100 + 60);
        this.layer.push(img);
        this.canopies.push({ img, x: d.x, y: d.y });
      }
    }
    for (const inter of map.interiors) {
      const key = `roof:${inter.id}`;
      const w = Math.round(inter.rect.w * TILE_PX);
      const h = Math.round(inter.rect.h * TILE_PX);
      if (!this.textures.exists(key)) this.addCanvasTexture(key, roofTexture(w, h, inter.roof));
      const img = this.add.image(Math.round(inter.rect.x * TILE_PX), Math.round(inter.rect.y * TILE_PX - 2.9 * TILE_PX), key).setOrigin(0, 0);
      img.setDepth(2.5e5 + inter.rect.y);
      this.layer.push(img);
      this.roofViews.push({ img, rect: inter.rect });
    }
    for (const l of map.lights) {
      const img = this.add.image(l.x * TILE_PX, l.y * TILE_PX - 1.2 * TILE_PX, 'dot:glow').setDepth(3.1e6).setBlendMode(Phaser.BlendModes.ADD);
      img.setScale(l.radius / 3).setTint(l.color).setAlpha(0);
      this.layer.push(img);
      this.lightViews.push(img);
    }
    this.darkKey = '';
    const pl = ctx.sim.actors.find((a) => a.kind === 'player');
    if (pl) this.focus = { x: pl.x, y: pl.y };
  }

  private darknessTexture(radiusPx: number, alpha: number): string {
    const key = `dark:${Math.round(radiusPx)}:${Math.round(alpha * 100)}`;
    if (this.textures.exists(key)) return key;
    const cv = document.createElement('canvas');
    cv.width = VIEW_W * 2;
    cv.height = VIEW_H * 2;
    const g = cv.getContext('2d')!;
    const grad = g.createRadialGradient(VIEW_W, VIEW_H, radiusPx * 0.55, VIEW_W, VIEW_H, radiusPx);
    grad.addColorStop(0, 'rgba(6,8,16,0)');
    grad.addColorStop(1, `rgba(6,8,16,${alpha})`);
    g.fillStyle = grad;
    g.fillRect(0, 0, cv.width, cv.height);
    this.textures.addCanvas(key, cv);
    return key;
  }

  // --- actors -----------------------------------------------------------------------------------------------------

  private spriteFor(ctx: SimContext, a: ActorState): string {
    if (a.kind === 'player') return 'bird:player';
    if (a.kind === 'dummy') return 'bird:dummy';
    if (a.kind === 'npc' && a.archetypeId) return `bird:${ctx.content.npc(a.archetypeId).sprite}`;
    if (a.kind === 'enemy' && a.archetypeId) return `bird:${ctx.content.enemy(a.archetypeId).sprite}`;
    return 'bird:dummy';
  }

  private makeActorView(ctx: SimContext, a: ActorState): ActorView {
    const body = this.add.sprite(0, 0, this.spriteFor(ctx, a), 0).setOrigin(0.5, FEET_Y / FRAME_H);
    const shadow = this.add.image(0, 0, 'dot:shadow').setOrigin(0.5, 0.5);
    const hpBack = this.add.rectangle(0, 0, 14, 2, 0x000000, 0.6).setOrigin(0.5, 0.5).setVisible(false);
    const hpBar = this.add.rectangle(0, 0, 14, 2, 0x50d050, 1).setOrigin(0, 0.5).setVisible(false);
    if (a.kind === 'turret') body.setVisible(false);
    return { body, weapon: null, weaponKey: null, shadow, hpBar, hpBack, alpha: a.kind === 'enemy' ? 0 : 1, walkPhase: 0, lastX: a.x, lastY: a.y, flashUntil: -1, flashOn: false };
  }

  private destroyActorView(v: ActorView): void {
    v.body.destroy();
    v.weapon?.destroy();
    v.shadow.destroy();
    v.hpBar.destroy();
    v.hpBack.destroy();
  }

  // --- frame -----------------------------------------------------------------------------------------------------

  override update(): void {
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.host.frame(dt);
    const ctx = this.host.currentCtx();
    if (!ctx) {
      if (this.builtKey) {
        this.clearMap();
        this.builtKey = '';
      }
      this.cameras.main.setBackgroundColor('#0d0e11');
      return;
    }
    const key = this.host.mapKey();
    if (key !== this.builtKey) {
      this.buildMap(ctx);
      this.builtKey = key;
    }
    this.renderSim(ctx, dt);
  }

  private computeVisibility(ctx: SimContext, pl: ActorState | undefined): void {
    this.visible.clear();
    const sim = ctx.sim;
    if (!pl) return;
    const w = ctx.content.weather(sim.env.weather);
    const t = ctx.content.timePhase(sim.env.phase);
    let nv = 0;
    const acc = equippedItem(sim, pl.id, 'accessory');
    if (acc) nv = ctx.content.item(acc.definitionId).accessory?.nightVision ?? 0;
    const phaseVision = t.vision + (1 - t.vision) * nv;
    const range = 30 * w.vision * phaseVision;
    const eye = { x: pl.x, y: pl.y, z: hitboxOf(ctx.content, pl).eyeZ };
    for (const a of sim.actors) {
      if (a === pl) continue;
      if (sim.mode === 'base' || a.kind !== 'enemy') {
        this.visible.add(a.id);
        continue;
      }
      const d = Math.hypot(a.x - pl.x, a.y - pl.y);
      if (d > range && sim.time - a.handling.lastShotTime > 0.3) continue;
      const prof = hitboxOf(ctx.content, a);
      const head = { x: a.x, y: a.y, z: prof.eyeZ };
      const chest = { x: a.x, y: a.y, z: 0.9 };
      if (!ctx.geo.visionBlocked(sim, eye, head, pl.floor, 1.4) || !ctx.geo.visionBlocked(sim, eye, chest, pl.floor, 1.4)) this.visible.add(a.id);
    }
  }

  private renderSim(ctx: SimContext, dt: number): void {
    const sim = ctx.sim;
    const alpha = this.host.renderAlpha();
    const settings = this.host.sceneSettings();
    const pl = sim.actors.find((a) => a.kind === 'player');
    this.computeVisibility(ctx, pl);
    // Camera focus with cursor lead (presentation only: never feeds back into aim/ballistics).
    if (pl) {
      const ix = pl.px + (pl.x - pl.px) * alpha;
      const iy = pl.py + (pl.y - pl.py) * alpha;
      const lead = this.host.cameraLead();
      const target = { x: ix + lead.x, y: iy + lead.y - 0.8 };
      const k = 1 - Math.exp(-dt * 10);
      // Snap the tail of the glide so the whole-pixel scroll comes to rest instead of creeping for seconds.
      const snap = 1 / 64;
      this.focus.x = Math.abs(target.x - this.focus.x) < snap ? target.x : this.focus.x + (target.x - this.focus.x) * k;
      this.focus.y = Math.abs(target.y - this.focus.y) < snap ? target.y : this.focus.y + (target.y - this.focus.y) * k;
    }
    const f = clampFocus(this.focus.x, this.focus.y, ctx.geo.map.width, ctx.geo.map.height);
    let sx = Math.round(f.fx * TILE_PX - VIEW_W / 2);
    let sy = Math.round(f.fy * TILE_PX - VIEW_H / 2);
    if (this.shake > 0 && settings.cameraShake > 0) {
      sx += Math.round((this.rng.next() - 0.5) * this.shake * settings.cameraShake * 4);
      sy += Math.round((this.rng.next() - 0.5) * this.shake * settings.cameraShake * 4);
      this.shake = Math.max(0, this.shake - dt * 6);
    }
    this.cameras.main.setScroll(sx, sy);
    const cam: ViewCamera = { cx: -sx, cy: -sy, k: 1 };
    this.host.setView(cam, this.visible);
    // Environment background tint.
    const w = ctx.content.weather(sim.env.weather);
    const phase = ctx.content.timePhase(sim.env.phase);
    // Actors.
    const seen = new Set<string>();
    for (const a of sim.actors) {
      seen.add(a.id);
      let v = this.actorViews.get(a.id);
      if (!v) {
        v = this.makeActorView(ctx, a);
        this.actorViews.set(a.id, v);
      }
      this.updateActorView(ctx, a, v, alpha, dt, settings);
    }
    for (const [id, v] of this.actorViews) {
      if (!seen.has(id)) {
        this.destroyActorView(v);
        this.actorViews.delete(id);
      }
    }
    // Containers (drops, corpses marker handled by actor corpse sprite; props for pile/cart/deathbag/drop).
    const cseen = new Set<string>();
    for (const c of Object.values(sim.containers)) {
      let tex: string | null = null;
      if (c.kind === 'drop') tex = 'prop:drop';
      else if (c.kind === 'deathbag') tex = 'prop:deathbag';
      else if (c.typeId === 'core.ct.scrap') tex = 'prop:scrap';
      else if (c.typeId === 'core.ct.cart') tex = 'prop:cart';
      else if (c.typeId === 'core.ct.flare_crate') tex = 'prop:flare';
      if (!tex) continue;
      cseen.add(c.id);
      let img = this.containerViews.get(c.id);
      if (!img) {
        img = this.add.image(0, 0, tex).setOrigin(0.5, 0.8);
        this.containerViews.set(c.id, img);
      }
      img.setPosition(Math.round(c.x * TILE_PX), Math.round(c.y * TILE_PX));
      img.setDepth(c.y * 100 - 1);
      const vis = sim.mode === 'base' || !pl || Math.hypot(c.x - pl.x, c.y - pl.y) < 26;
      img.setVisible(vis);
    }
    for (const [id, img] of this.containerViews) {
      if (!cseen.has(id)) {
        img.destroy();
        this.containerViews.delete(id);
      }
    }
    // Doors.
    for (const [doorId, imgs] of this.doorViews) {
      const open = sim.doors[doorId]?.open ?? false;
      for (const img of imgs) img.setAlpha(open ? 0.18 : 1);
    }
    // Destructibles.
    for (const v of this.obViews) {
      if (v.ob.profile.destructible) {
        const hp = sim.obstacleHp[v.ob.id];
        if (hp !== undefined && hp <= 0) v.img.setVisible(false);
      }
    }
    // Occlusion fade (x-ray) for tall obstacles/canopies in front of the player; roofs hide when inside.
    if (pl) {
      const px = pl.x * TILE_PX;
      const pyTop = pl.y * TILE_PX - 30;
      const pyBot = pl.y * TILE_PX;
      for (const v of this.obViews) {
        if (!v.tall || v.ob.doorId) continue;
        const b = v.img.getBounds();
        const inFront = v.ob.box.y1 > pl.y + 0.05;
        const overlaps = px + 8 > b.x && px - 8 < b.right && pyBot > b.y && pyTop < b.bottom;
        v.img.setAlpha(inFront && overlaps ? 0.4 : 1);
      }
      for (const c of this.canopies) {
        const near = Math.abs(c.x - pl.x) < 1.6 && pl.y < c.y + 0.2 && pl.y > c.y - 3.6;
        c.img.setAlpha(near ? 0.35 : 1);
      }
      for (const r of this.roofViews) {
        const inside = pl.x > r.rect.x && pl.x < r.rect.x + r.rect.w && pl.y > r.rect.y && pl.y < r.rect.y + r.rect.h;
        const target = inside ? 0 : 1;
        const cur = r.img.alpha;
        r.img.setAlpha(cur + (target - cur) * Math.min(1, dt * 8));
      }
    }
    // Projectiles as tracers (from interpolated previous to current position).
    this.tracer.clear();
    for (const p of sim.projectiles) {
      const x0 = p.px + (p.x - p.px) * Math.max(0, alpha - 0.35);
      const y0 = p.py + (p.y - p.py) * Math.max(0, alpha - 0.35);
      const z0 = p.pz + (p.z - p.pz) * Math.max(0, alpha - 0.35);
      const x1 = p.px + (p.x - p.px) * alpha;
      const y1 = p.py + (p.y - p.py) * alpha;
      const z1 = p.pz + (p.z - p.pz) * alpha;
      this.tracer.lineStyle(1, p.tracer, p.team === 'player' ? 0.9 : 0.75);
      this.tracer.lineBetween(x0 * TILE_PX, (y0 - z0) * TILE_PX, x1 * TILE_PX, (y1 - z1) * TILE_PX);
    }
    // Thrown objects & smokes.
    const tseen = new Set<string>();
    for (const t of sim.thrown) {
      tseen.add(t.id);
      let img = this.thrownViews.get(t.id);
      if (!img) {
        img = this.add.image(0, 0, 'dot:grenade');
        this.thrownViews.set(t.id, img);
      }
      img.setPosition(t.x * TILE_PX, (t.y - t.z) * TILE_PX).setDepth(t.y * 100 + 2);
    }
    for (const [id, img] of this.thrownViews) if (!tseen.has(id)) {
      img.destroy();
      this.thrownViews.delete(id);
    }
    const sseen = new Set<string>();
    for (const s of sim.smokes) {
      sseen.add(s.id);
      let img = this.smokeViews.get(s.id);
      if (!img) {
        img = this.add.image(0, 0, 'dot:smoke').setDepth(2.4e5);
        this.smokeViews.set(s.id, img);
      }
      const life = Math.max(0, Math.min(1, (s.until - sim.time) / 2));
      img.setPosition(s.x * TILE_PX, (s.y - 1) * TILE_PX).setScale((s.radius * 2.4 * TILE_PX) / 22).setAlpha(0.85 * life);
    }
    for (const [id, img] of this.smokeViews) if (!sseen.has(id)) {
      img.destroy();
      this.smokeViews.delete(id);
    }
    // Overlay graphics: exits, telegraphs, interaction highlight.
    this.overlayG.clear();
    if (sim.mode === 'raid') {
      for (const ex of ctx.geo.map.exits) {
        const st = sim.exits[ex.id];
        const on = st?.enabled ?? true;
        const pulse = 0.35 + 0.25 * Math.sin(sim.time * 4);
        this.overlayG.lineStyle(1, on ? 0x62e08a : 0xe0a040, pulse + 0.2);
        this.overlayG.strokeRect(ex.x * TILE_PX, ex.y * TILE_PX, ex.w * TILE_PX, ex.h * TILE_PX);
        if (st && st.progress > 0) {
          this.overlayG.fillStyle(0x62e08a, 0.25);
          this.overlayG.fillRect(ex.x * TILE_PX, ex.y * TILE_PX, ex.w * TILE_PX * Math.min(1, st.progress / 5), ex.h * TILE_PX);
        }
      }
    }
    this.telegraphs = this.telegraphs.filter((t) => t.until > sim.time);
    for (const t of this.telegraphs) {
      const a = sim.actors.find((x) => x.id === t.actorId);
      if (!a || !a.alive || !this.visible.has(a.id)) continue;
      const k2 = 0.4 + 0.6 * Math.abs(Math.sin(sim.time * 20));
      this.overlayG.lineStyle(1, 0xff3030, k2);
      this.overlayG.lineBetween(a.x * TILE_PX, (a.y - 1.2) * TILE_PX, (a.x + a.aim.dirX * 14) * TILE_PX, (a.y + a.aim.dirY * 14 - 1.2) * TILE_PX);
    }
    if (sim.prompt) {
      this.overlayG.lineStyle(1, sim.prompt.blockedKey ? 0xe06040 : 0xf0e080, 0.8);
      this.overlayG.strokeCircle(sim.prompt.x * TILE_PX, sim.prompt.y * TILE_PX - 6, 7 + Math.sin(sim.time * 6));
    }
    this.drawSlashes(sim.time);
    // Throw preview uses the same integrator as the real throw (computed by the host, drawn here).
    this.drawThrowPreview(this.host.throwPreviewPoints());
    // Darkness (Dusk/Night, storm) with a vision hole around the player.
    let nv = 0;
    if (pl) {
      const acc = equippedItem(sim, pl.id, 'accessory');
      if (acc) nv = ctx.content.item(acc.definitionId).accessory?.nightVision ?? 0;
    }
    const darkness = Math.min(0.92, phase.darkness * (1 - nv * 0.7) + (1 - w.vision) * 0.8);
    if (darkness > 0.02 && pl) {
      const radius = Math.max(70, 30 * TILE_PX * w.vision * (phase.vision + (1 - phase.vision) * nv) * 0.42);
      const key = this.darknessTexture(Math.round(radius / 8) * 8, Math.round(darkness * 20) / 20);
      if (key !== this.darkKey) {
        this.dark.setTexture(key);
        this.darkKey = key;
      }
      const ps = worldToView(cam, pl.px + (pl.x - pl.px) * alpha, pl.py + (pl.y - pl.py) * alpha, 1);
      this.dark.setVisible(true).setPosition(ps.sx, ps.sy);
      for (const l of this.lightViews) l.setAlpha(Math.min(0.55, darkness));
    } else {
      this.dark.setVisible(false);
      for (const l of this.lightViews) l.setAlpha(0);
    }
    // Weather (cosmetic).
    this.weatherG.clear();
    if (sim.env.weather === 'Rain' || sim.env.weather === 'Storm') {
      const n = sim.env.weather === 'Storm' ? 110 : 60;
      this.weatherG.lineStyle(1, 0xa8c8e8, 0.35);
      for (let i = 0; i < n; i++) {
        const x = (this.rng.next() * (VIEW_W + 40)) - 20;
        const y = this.rng.next() * VIEW_H;
        this.weatherG.lineBetween(x, y, x - 3, y + 7);
      }
      if (sim.env.weather === 'Storm') {
        this.lightningT -= dt;
        if (this.lightningT <= 0) {
          this.lightningT = 4 + this.rng.next() * 7;
          this.flash.setFillStyle(0xdde8ff, 0.35 * settings.flashIntensity);
        }
      }
    }
    if (sim.env.weather === 'Cloudy' || sim.env.weather === 'Rain' || sim.env.weather === 'Storm') {
      this.weatherG.fillStyle(0x283040, sim.env.weather === 'Cloudy' ? 0.1 : 0.18);
      this.weatherG.fillRect(0, 0, VIEW_W, VIEW_H);
    }
    // Flash decay.
    if (this.flash.fillAlpha > 0) this.flash.setFillStyle(this.flash.fillColor, Math.max(0, this.flash.fillAlpha - dt * 1.6));
    if (this.hurt.fillAlpha > 0) this.hurt.setFillStyle(0xb01818, Math.max(0, this.hurt.fillAlpha - dt * 1.8));
    // FX from simulation events.
    for (const e of this.host.drainFx()) this.handleFx(ctx, e, cam, settings);
    this.updateParticles(dt);
    this.drawDebug(ctx, settings);
  }

  private updateActorView(ctx: SimContext, a: ActorState, v: ActorView, alpha: number, dt: number, settings: SceneSettings): void {
    const x = a.px + (a.x - a.px) * alpha;
    const y = a.py + (a.y - a.py) * alpha;
    const sx = Math.round(x * TILE_PX);
    const sy = Math.round(y * TILE_PX);
    const moved = Math.hypot(x - v.lastX, y - v.lastY);
    v.lastX = x;
    v.lastY = y;
    v.walkPhase += moved * 2.2;
    let frame: number = FRAMES.idle0;
    const roll = a.alive && a.action?.type === 'dodge' ? a.action : null;
    // Dodge roll: one full tumble in quarter-turn frames (pre-rendered; no runtime sprite rotation), with a small hop.
    const k = roll ? Math.max(0, Math.min(0.999, roll.elapsed / roll.duration)) : 0;
    if (!a.alive) frame = FRAMES.dead;
    else if (roll) frame = FRAMES.roll0 + Math.floor(k * 4);
    else if (a.stance === 'crouch') frame = a.moving ? (Math.floor(v.walkPhase) % 2 === 0 ? FRAMES.crouch0 : FRAMES.crouch1) : FRAMES.crouch0;
    else if (a.moving) frame = FRAMES.walk0 + (Math.floor(v.walkPhase) % 4);
    else frame = Math.floor(ctx.sim.time * 1.5 + (a.id.length % 3)) % 2 === 0 ? FRAMES.idle0 : FRAMES.idle1;
    v.body.setFrame(frame);
    v.body.setPosition(sx, roll ? sy - Math.round(Math.sin(Math.PI * k) * 3) : sy);
    // Rolling left mirrors the clockwise frames, so the tumble turns counter-clockwise along the roll.
    const rollLeft = roll ? (Math.abs(roll.dirX ?? 0) > 0.2 ? (roll.dirX ?? 0) < 0 : !a.aim.faceRight) : false;
    v.body.setFlipX(roll ? rollLeft : !a.aim.faceRight);
    v.body.setDepth(y * 100 + (a.alive ? 1 : -2));
    v.shadow.setPosition(sx, sy).setDepth(y * 100 - 3);
    const target = this.visible.has(a.id) || a.kind !== 'enemy' ? 1 : 0;
    v.alpha += (target - v.alpha) * Math.min(1, dt * 10);
    const vis = v.alpha > 0.02 && a.kind !== 'turret';
    // Invulnerability window of a roll reads as a slightly translucent body.
    v.body.setVisible(vis).setAlpha(v.alpha * (a.alive && inIframes(ctx.sim, a) ? 0.65 : 1));
    v.shadow.setVisible(vis && a.alive).setAlpha(v.alpha);
    if (a.kind === 'dummy' && !a.alive) v.body.setAlpha(0.5);
    // Melee hit flash: the struck sprite turns solid white for a moment (tint fill keeps the sprite's alpha).
    const flashOn = v.flashUntil > ctx.sim.time && a.alive;
    if (flashOn !== v.flashOn) {
      v.flashOn = flashOn;
      if (flashOn) v.body.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
      else v.body.setTint(0xffffff).setTintMode(Phaser.TintModes.MULTIPLY);
    }
    // Weapon.
    const aw = a.alive && a.kind !== 'npc' && a.kind !== 'dummy' ? activeWeaponItem(ctx, a) : null;
    const holstered = ctx.sim.mode === 'base' && a.kind === 'player' && ctx.geo.regionAt(a.x, a.y)?.id !== 'core.region.range';
    const wkey = aw && !holstered ? `wpn:${WEAPON_KEY(aw.item.definitionId)}` : null;
    if (wkey !== v.weaponKey) {
      v.weapon?.destroy();
      v.weapon = null;
      v.weaponKey = wkey;
      if (wkey) {
        v.weapon = this.add.image(0, 0, wkey).setOrigin(2 / this.textures.get(wkey).getSourceImage().width, 3 / 8);
      }
    }
    if (v.weapon) {
      const ang = Math.atan2(a.aim.dirY, a.aim.dirX);
      const handZ = a.handling.muzzleZ;
      v.weapon.setPosition(sx + Math.round(a.aim.dirX * 3), sy - Math.round(handZ * TILE_PX) + 1);
      v.weapon.setRotation(ang);
      v.weapon.setFlipY(!a.aim.faceRight);
      v.weapon.setDepth(y * 100 + (a.aim.dirY > 0.2 ? 1.5 : 0.5));
      v.weapon.setVisible(vis && !roll).setAlpha(v.alpha);
    }
    // Health bar (accessibility option; never shown for hidden enemies).
    const showHp = settings.healthBars && a.alive && (a.kind === 'enemy' || a.kind === 'dummy') && vis && a.hp < a.maxHp;
    v.hpBack.setVisible(showHp);
    v.hpBar.setVisible(showHp);
    if (showHp) {
      const top = sy - Math.round(hitboxOf(ctx.content, a).height * TILE_PX) - 6;
      v.hpBack.setPosition(sx, top).setDepth(1.9e6);
      v.hpBar.setPosition(sx - 7, top).setDepth(1.9e6 + 1);
      v.hpBar.width = Math.max(0, 14 * (a.hp / a.maxHp));
      v.hpBar.setFillStyle(a.hp / a.maxHp > 0.5 ? 0x50d050 : a.hp / a.maxHp > 0.25 ? 0xe0c040 : 0xe04040);
    }
  }

  private spawnParticle(tex: string, x: number, y: number, vx: number, vy: number, life: number, gravity: number, depth: number, tint?: number, scale = 1): void {
    if (this.particles.length > 400) return;
    const img = this.add.image(x, y, tex).setDepth(depth).setScale(scale);
    if (tint !== undefined) img.setTint(tint);
    this.particles.push({ obj: img, vx, vy, life, max: life, gravity, fade: true });
  }

  private updateParticles(dt: number): void {
    for (const p of this.particles) {
      p.life -= dt;
      p.vy += p.gravity * dt;
      p.obj.x += p.vx * dt;
      p.obj.y += p.vy * dt;
      if (p.fade) p.obj.setAlpha(Math.max(0, p.life / p.max));
    }
    const alive: Particle[] = [];
    for (const p of this.particles) {
      if (p.life > 0) alive.push(p);
      else p.obj.destroy();
    }
    this.particles = alive;
  }

  private handleFx(ctx: SimContext, e: SimEvent, cam: ViewCamera, settings: SceneSettings): void {
    const sim = ctx.sim;
    let screen: { x: number; y: number } | null = null;
    switch (e.t) {
      case 'shot': {
        const px = e.x * TILE_PX;
        const py = (e.y - e.z) * TILE_PX;
        const shooterVisible = e.actorId === 'player' || this.visible.has(e.actorId) || sim.mode === 'base';
        if (shooterVisible && !e.suppressed) this.spawnParticle('dot:flash', px + e.dirX * 3, py + e.dirY * 3, 0, 0, 0.05, 0, 2e5, undefined, 1.2);
        if (e.actorId === 'player') this.shake = Math.min(1, this.shake + 0.25);
        const sv = worldToView(cam, e.x, e.y, e.z);
        screen = { x: sv.sx, y: sv.sy };
        break;
      }
      case 'impact': {
        const px = e.x * TILE_PX;
        const py = (e.y - e.z) * TILE_PX;
        if (e.actor) {
          for (let i = 0; i < 4; i++) this.spawnParticle('dot:feather', px, py, (this.rng.next() - 0.5) * 40, -this.rng.next() * 30, 0.6, 60, e.y * 100 + 5);
        } else {
          const tint = e.material === 'wood' ? 0xc89a60 : e.material === 'metal' ? 0xfff0a0 : e.material === 'glass' ? 0xc8f0ff : e.material === 'water' ? 0x8ac0e0 : e.material === 'grass' || e.material === 'vegetation' ? 0x6a9a4a : 0xb0b0a8;
          for (let i = 0; i < 3; i++) this.spawnParticle('dot:spark', px, py, (this.rng.next() - 0.5) * 50, -this.rng.next() * 40, 0.25, 90, e.y * 100 + 5, tint);
        }
        break;
      }
      case 'penetrate':
        this.spawnParticle('dot:spark', e.x * TILE_PX, (e.y - e.z) * TILE_PX, 0, -10, 0.2, 0, e.y * 100 + 5, 0xffffff);
        break;
      case 'hit': {
        const v = worldToView(cam, e.x, e.y, e.z);
        screen = { x: v.sx, y: v.sy };
        if (e.actorId === 'player' && e.damage > 0) {
          this.hurt.setFillStyle(0xb01818, Math.min(0.45, 0.12 + e.damage / 120) * settings.flashIntensity);
          this.shake = Math.min(1.5, this.shake + 0.6);
        }
        break;
      }
      case 'explosion': {
        const px = e.x * TILE_PX;
        const py = e.y * TILE_PX;
        if (e.kind === 'frag') {
          for (let i = 0; i < 18; i++) this.spawnParticle('dot:spark', px, py - 4, (this.rng.next() - 0.5) * 160, -this.rng.next() * 120, 0.5, 200, e.y * 100 + 6, 0xffb040, 1.5);
          this.spawnParticle('dot:smoke', px, py - 6, 0, -12, 1.2, 0, e.y * 100 + 7, 0x606060, 1.4);
          this.shake = Math.min(2, this.shake + 1.2);
        } else if (e.kind === 'flash') {
          this.spawnParticle('dot:glow', px, py - 8, 0, 0, 0.4, 0, 2e5, 0xffffff, 3);
        }
        break;
      }
      case 'flash':
        this.flash.setFillStyle(0xffffff, Math.min(0.95, e.intensity) * settings.flashIntensity);
        break;
      case 'telegraph':
        this.telegraphs.push({ actorId: e.actorId, tx: e.tx, ty: e.ty, until: e.until });
        break;
      case 'melee': {
        const seen = e.actorId === 'player' || this.visible.has(e.actorId) || sim.mode === 'base';
        if (seen) {
          const it = equippedItem(sim, e.actorId, 'melee');
          const reach = it ? (ctx.content.item(it.definitionId).melee?.reach ?? 1) : 1;
          this.slashes.push({ x: e.x, y: e.y, ang: Math.atan2(e.dirY, e.dirX), reach, hit: e.hit, born: sim.time });
          if (this.slashes.length > 16) this.slashes.shift();
        }
        const tgt = e.hit && e.targetId ? sim.actors.find((a) => a.id === e.targetId) : undefined;
        if (tgt) {
          const view = this.actorViews.get(tgt.id);
          if (view) view.flashUntil = sim.time + MELEE_FLASH;
          const px = tgt.x * TILE_PX - e.dirX * 3;
          const py = (tgt.y - 0.9) * TILE_PX;
          this.spawnParticle('dot:flash', px, py, 0, 0, 0.07, 0, 2e5, 0xffffff, 1.1);
          for (let i = 0; i < 5; i++) this.spawnParticle('dot:spark', px, py, e.dirX * 45 + (this.rng.next() - 0.5) * 50, e.dirY * 45 - this.rng.next() * 35, 0.22, 90, tgt.y * 100 + 6, 0xfff0c0);
          if (e.actorId === 'player') this.shake = Math.min(1.2, this.shake + 0.35);
        }
        break;
      }
      case 'dodge': {
        // Kicked-up dust behind the roll's starting point (only for rollers the player can see).
        const seen = e.actorId === 'player' || this.visible.has(e.actorId) || sim.mode === 'base';
        if (seen) {
          const px = e.x * TILE_PX;
          const py = e.y * TILE_PX;
          for (let i = 0; i < 6; i++) this.spawnParticle('dot:smoke', px - e.dirX * 4 + (this.rng.next() - 0.5) * 6, py - 2, -e.dirX * 28 + (this.rng.next() - 0.5) * 30, -e.dirY * 28 - this.rng.next() * 14, 0.45, 0, e.y * 100 + 4, 0xa89a80, 0.55);
        }
        break;
      }
      case 'death': {
        const v = worldToView(cam, e.x, e.y, 1);
        screen = { x: v.sx, y: v.sy };
        for (let i = 0; i < 8; i++) this.spawnParticle('dot:feather', e.x * TILE_PX, e.y * TILE_PX - 14, (this.rng.next() - 0.5) * 60, -this.rng.next() * 50, 1.0, 50, e.y * 100 + 5);
        break;
      }
      default:
        break;
    }
    this.host.onFx(e, screen);
  }

  private drawDebug(ctx: SimContext, settings: SceneSettings): void {
    this.debugG.clear();
    if (!settings.debugOverlay) return;
    const sim = ctx.sim;
    for (const a of sim.actors) {
      if (!a.alive) continue;
      const prof = hitboxOf(ctx.content, a);
      for (const vol of prof.volumes) {
        const cx = (a.x + a.aim.dirX * vol.forward) * TILE_PX;
        const color = vol.part === 'head' ? 0xff4040 : vol.part === 'body' ? 0x40ff40 : 0x4080ff;
        this.debugG.lineStyle(1, color, 0.8);
        this.debugG.strokeRect(cx - vol.radius * TILE_PX, (a.y - vol.z1) * TILE_PX, vol.radius * 2 * TILE_PX, (vol.z1 - vol.z0) * TILE_PX);
      }
      const ax = a.x * TILE_PX;
      const ay = (a.y - prof.anchorZ) * TILE_PX;
      this.debugG.lineStyle(1, 0xffff00, 0.9);
      this.debugG.strokeCircle(ax, ay, 2);
      const aw = activeWeaponItem(ctx, a);
      if (aw) {
        const L = aw.def.weapon!.muzzleLength;
        this.debugG.lineStyle(1, a.aim.muzzleBlocked ? 0xff0000 : 0x00ffff, 1);
        this.debugG.lineBetween(a.x * TILE_PX, (a.y - a.handling.muzzleZ) * TILE_PX, (a.x + a.aim.dirX * L) * TILE_PX, (a.y + a.aim.dirY * L - a.handling.muzzleZ) * TILE_PX);
      }
      if (a.ai && a.ai.path.length) {
        this.debugG.lineStyle(1, 0xff80ff, 0.6);
        let px = a.x;
        let py = a.y;
        for (let i = a.ai.pathIndex; i < a.ai.path.length; i++) {
          const w = a.ai.path[i]!;
          this.debugG.lineBetween(px * TILE_PX, py * TILE_PX, w.x * TILE_PX, w.y * TILE_PX);
          px = w.x;
          py = w.y;
        }
        if (a.ai.coverX !== null) {
          this.debugG.lineStyle(1, 0x80ffff, 0.8);
          this.debugG.strokeRect(a.ai.coverX * TILE_PX - 3, a.ai.coverY! * TILE_PX - 3, 6, 6);
        }
      }
    }
    for (const p of sim.projectiles) {
      this.debugG.lineStyle(1, 0xffffff, 0.8);
      this.debugG.lineBetween(p.px * TILE_PX, (p.py - p.pz) * TILE_PX, p.x * TILE_PX, (p.y - p.z) * TILE_PX);
    }
    for (const n of this.recentNoise) {
      this.debugG.lineStyle(1, 0xffa040, 0.35);
      this.debugG.strokeCircle(n.x * TILE_PX, n.y * TILE_PX, n.r * TILE_PX);
    }
    this.recentNoise = this.recentNoise.filter((n) => n.until > sim.time);
  }

  private recentNoise: { x: number; y: number; r: number; until: number }[] = [];
  noteNoise(x: number, y: number, r: number, until: number): void {
    this.recentNoise.push({ x, y, r, until });
    if (this.recentNoise.length > 60) this.recentNoise.shift();
  }

  /** Melee swing arcs: the blade edge sweeps the strike cone in the first 40 % of its life, then fades out. */
  private drawSlashes(now: number): void {
    const g = this.overlayG;
    const alive: Slash[] = [];
    for (const s of this.slashes) {
      const age = now - s.born;
      if (age >= SLASH_LIFE || age < -1) continue;
      alive.push(s);
      const k = Math.max(0, age) / SLASH_LIFE;
      const sweep = Math.min(1, k / 0.4);
      const fade = k < 0.4 ? 1 : 1 - (k - 0.4) / 0.6;
      const a0 = s.ang - MELEE_HALF_ARC;
      const a1 = a0 + 2 * MELEE_HALF_ARC * sweep;
      const cx = s.x * TILE_PX;
      const cy = (s.y - MELEE_ARC_Z) * TILE_PX;
      // Drawn a little beyond the reach so the edge reads clearly past the struck body, not on top of it.
      // Same radius as the simulation's hit edge (world/melee.ts), so the arc shows exactly what a swing reaches.
      const r = meleeArcRadius(s.reach) * TILE_PX;
      const inner = r * 0.5;
      const color = s.hit ? 0xffa63a : 0xbcd4ff;
      if (a1 - a0 < 1e-3) continue;
      // Built from triangles and line segments (the primitives the rest of the overlay uses).
      const N = 12;
      const at = (rr: number, t: number) => {
        const a = a0 + (a1 - a0) * t;
        return { x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr };
      };
      // Smear: a translucent ring sector over the swept part of the cone, denser towards the leading edge.
      for (let i = 0; i < N; i++) {
        const t0 = i / N;
        const t1 = (i + 1) / N;
        const o0 = at(r, t0);
        const o1 = at(r, t1);
        const i0 = at(inner, t0);
        const i1 = at(inner, t1);
        g.fillStyle(color, (0.08 + 0.26 * t1) * fade);
        g.fillTriangle(o0.x, o0.y, o1.x, o1.y, i0.x, i0.y);
        g.fillTriangle(i0.x, i0.y, o1.x, o1.y, i1.x, i1.y);
      }
      // Blade edge: a soft coloured halo under a bright core line, strongest at the leading end.
      const stroke = (width: number, rr: number, from: number, col: number, alpha: number) => {
        g.lineStyle(width, col, alpha * fade);
        for (let i = Math.floor(from * N); i < N; i++) {
          const p0 = at(rr, i / N);
          const p1 = at(rr, (i + 1) / N);
          g.lineBetween(p0.x, p0.y, p1.x, p1.y);
        }
      };
      stroke(5, r - 1, 0.25, color, 0.6);
      stroke(2, r, 0.05, 0xffffff, 0.95);
      stroke(2, r * 0.74, 0.45, color, 0.8);
      // Leading tip.
      g.fillStyle(0xffffff, 0.9 * fade);
      g.fillCircle(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, 1.5);
    }
    this.slashes = alive;
  }

  /** Draw a predicted throw arc (points in world units) for this frame. */
  drawThrowPreview(points: { x: number; y: number; z: number }[]): void {
    if (points.length < 2) return;
    this.overlayG.lineStyle(1, 0xf0f0a0, 0.7);
    for (let i = 1; i < points.length; i += 2) {
      const a = points[i - 1]!;
      const b = points[i]!;
      this.overlayG.lineBetween(a.x * TILE_PX, (a.y - a.z) * TILE_PX, b.x * TILE_PX, (b.y - b.z) * TILE_PX);
    }
    const end = points[points.length - 1]!;
    this.overlayG.strokeCircle(end.x * TILE_PX, end.y * TILE_PX, 4);
  }
}
