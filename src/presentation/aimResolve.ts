import { TILE_PX, viewToWorld, worldToView, type ViewCamera } from '../core/coords';
import type { AimInput } from '../combat/aim';
import { hitboxOf, type SimContext } from '../world/context';
import type { ActorState } from '../world/state';

/**
 * Cursor → effective aim target. Uses the same projection as rendering:
 *  - over a visible actor's billboard: aim point on that actor's depth plane (y = actor.y), z from the cursor row;
 *  - otherwise: the cursor ray intersected with the plane z = current muzzle height (level shot).
 * Nothing here can deal damage: it only produces an aim point for the real muzzle/ballistics pipeline.
 */
export function resolveAim(ctx: SimContext, cam: ViewCamera, sx: number, sy: number, visible: (a: ActorState) => boolean): AimInput {
  const sim = ctx.sim;
  const pl = sim.actors.find((a) => a.kind === 'player');
  const k = cam.k;
  let best: { a: ActorState; z: number; x: number } | null = null;
  for (const a of sim.actors) {
    if (a === pl || !a.alive || a.kind === 'npc' || !visible(a)) continue;
    const prof = hitboxOf(ctx.content, a);
    const r = Math.max(...prof.volumes.map((v) => v.radius));
    const foot = worldToView(cam, a.x, a.y, 0);
    const halfW = TILE_PX * k * (r + 0.06);
    const top = foot.sy - TILE_PX * k * (prof.height + 0.05);
    if (sx < foot.sx - halfW || sx > foot.sx + halfW || sy < top || sy > foot.sy) continue;
    const z = (foot.sy - sy) / (TILE_PX * k);
    const x = (sx - cam.cx) / (TILE_PX * k);
    if (!best || a.y > best.a.y) best = { a, z, x };
  }
  const anchorZ = pl ? hitboxOf(ctx.content, pl).anchorZ : 1.25;
  const anchor = pl ? worldToView(cam, pl.x, pl.y, anchorZ) : { sx, sy };
  const viewDistPx = Math.hypot(sx - anchor.sx, sy - anchor.sy) / k;
  if (best) return { x: best.x, y: best.a.y, z: best.z, actorId: best.a.id, viewDistPx };
  const mz = pl ? pl.handling.muzzleZ : 1;
  const w = viewToWorld(cam, sx, sy, mz);
  return { x: w.x, y: w.y, z: mz, actorId: null, viewDistPx };
}
