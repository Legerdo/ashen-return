import type { SimContext } from '../world/context';
import type { SimEvent } from '../world/state';
import type { AudioEngine } from './audio';

/** Bullet-impact material (obstacle materials and, for ground hits, the ground's footstep family) → impact sound. */
const IMPACT_SOUND: Record<string, string> = {
  concrete: 'concrete',
  brick: 'concrete',
  debris: 'concrete',
  wood: 'wood',
  metal: 'metal',
  glass: 'glass',
  vegetation: 'vegetation',
  sandbag: 'dirt',
  fabric: 'dirt',
  flesh: 'flesh',
  dirt: 'dirt',
  water: 'water',
  // Ground hits (combatResolve reports ground.footstep): grass is the most common raid ground.
  grass: 'vegetation',
  foliage: 'vegetation',
  mud: 'dirt',
  gravel: 'dirt',
  snow: 'dirt',
};
const STEP_SOUNDS = new Set(['grass', 'dirt', 'mud', 'water', 'concrete', 'wood', 'gravel', 'metal', 'snow', 'foliage']);
const RELOAD_SOUND: Record<string, string> = {
  magOut: 'reload.magOut',
  magDrop: 'reload.magOut',
  magIn: 'reload.magIn',
  chamber: 'reload.chamber',
  shell: 'reload.shell',
  pump: 'reload.pump',
  open: 'reload.chamber',
  close: 'reload.chamber',
};
const EXPLOSIONS = new Set(['frag', 'flash', 'smoke']);

export interface SoundCue {
  id: string;
  /** World position for spatialized playback; null = non-positional (player-local / UI). */
  x: number | null;
  y: number | null;
  gain: number;
  /** Audible range in world units for positional cues. */
  range: number;
}

const weaponKey = (defId: string): string => defId.split('.').pop() ?? 'p9';

/**
 * Pure mapping from simulation feedback events to audio cues. Presentation only: enemy hearing is driven by
 * simulation NoiseEvents, never by what the browser plays, and volume settings never change AI behavior.
 */
export function soundCueFor(ctx: SimContext, e: SimEvent): SoundCue | null {
  const sim = ctx.sim;
  const actorPos = (id: string): { x: number; y: number } | null => {
    const a = sim.actors.find((x) => x.id === id);
    return a ? { x: a.x, y: a.y } : null;
  };
  switch (e.t) {
    case 'shot':
      return { id: e.suppressed ? 'gun.suppressed' : `gun.${weaponKey(e.weaponDefId)}`, x: e.x, y: e.y, gain: e.actorId === 'player' ? 0.85 : 1, range: e.suppressed ? 32 : 72 };
    case 'dryfire':
      return e.actorId === 'player' ? { id: 'gun.dry', x: null, y: null, gain: 0.8, range: 0 } : null;
    case 'impact':
      return { id: `impact.${e.actor ? 'flesh' : (IMPACT_SOUND[e.material] ?? 'concrete')}`, x: e.x, y: e.y, gain: 0.55, range: 26 };
    case 'penetrate':
      return { id: `impact.${IMPACT_SOUND[e.material] ?? 'concrete'}`, x: e.x, y: e.y, gain: 0.35, range: 20 };
    case 'hit':
      return e.actorId === 'player' && e.damage > 0 ? { id: 'voice.hurt', x: null, y: null, gain: 0.8, range: 0 } : null;
    case 'footstep': {
      const m = STEP_SOUNDS.has(e.material) ? e.material : 'dirt';
      const mine = e.actorId === 'player';
      return { id: `step.${m}`, x: e.x, y: e.y, gain: mine ? 0.32 : e.loud ? 0.95 : 0.6, range: e.loud ? 20 : 12 };
    }
    case 'reload': {
      const id = RELOAD_SOUND[e.step];
      const p = actorPos(e.actorId);
      return id && p ? { id, x: p.x, y: p.y, gain: e.actorId === 'player' ? 0.7 : 0.6, range: 14 } : null;
    }
    case 'explosion':
      return { id: `explosion.${EXPLOSIONS.has(e.kind) ? e.kind : 'frag'}`, x: e.x, y: e.y, gain: 1, range: 90 };
    case 'smoke':
      return { id: 'explosion.smoke', x: e.x, y: e.y, gain: 0.7, range: 30 };
    case 'melee': {
      const p = actorPos(e.actorId);
      return p ? { id: 'melee.swing', x: p.x, y: p.y, gain: 0.7, range: 12 } : null;
    }
    case 'dodge': {
      // A roll is a heavy body thud on the ground it starts from (the ground's footstep family, played loud).
      const m = STEP_SOUNDS.has(e.material) ? e.material : 'dirt';
      return { id: `step.${m}`, x: e.x, y: e.y, gain: e.actorId === 'player' ? 0.75 : 1, range: 16 };
    }
    case 'door': {
      const d = ctx.geo.map.doors.find((x) => x.id === e.doorId);
      if (!d) return null;
      return { id: e.open ? 'door.open' : 'door.close', x: (d.x0 + d.x1) / 2, y: (d.y0 + d.y1) / 2, gain: 0.8, range: 22 };
    }
    case 'pickup':
      return { id: 'ui.pickup', x: null, y: null, gain: 0.6, range: 0 };
    case 'search':
      return { id: 'ui.search', x: null, y: null, gain: 0.35, range: 0 };
    case 'heal':
      return e.actorId === 'player' ? { id: 'heal.bandage', x: null, y: null, gain: 0.7, range: 0 } : null;
    case 'alert': {
      const a = sim.actors.find((x) => x.id === e.actorId);
      if (!a || !a.archetypeId) return null;
      const voice = ctx.content.enemies.get(a.archetypeId)?.voice ?? 'coo';
      return { id: `voice.alert.${voice}`, x: a.x, y: a.y, gain: 0.8, range: 26 };
    }
    case 'event':
      return e.state === 'active' ? { id: 'machine.pulse', x: null, y: null, gain: 0.6, range: 0 } : e.state === 'success' ? { id: 'ui.quest', x: null, y: null, gain: 0.6, range: 0 } : null;
    case 'extracted':
      return { id: 'ui.quest', x: null, y: null, gain: 0.8, range: 0 };
    default:
      return null;
  }
}

/** Plays cues through the bus-routed engine, spatialized relative to the player. */
export class SoundDirector {
  constructor(private readonly audio: AudioEngine) {}

  handle(ctx: SimContext, e: SimEvent): void {
    const cue = soundCueFor(ctx, e);
    if (!cue) return;
    if (cue.x === null || cue.y === null) {
      this.audio.play(cue.id, { gain: cue.gain });
      return;
    }
    const pl = ctx.sim.actors.find((a) => a.kind === 'player');
    if (!pl) return;
    this.audio.playAt(cue.id, cue.x, cue.y, pl.x, pl.y, cue.range, cue.gain);
  }
}
