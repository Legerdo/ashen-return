import type { ItemDef } from '../content/types';
import { Px, shade } from '../presentation/pixel';
import { weaponSprite } from '../presentation/sprites';

/** Procedural 16px-per-cell item icons (pixel art, rendered once per definition and cached as data URLs). */
const cache = new Map<string, string>();
const CELL = 16;
const O = 0x141418;

const VARIANT_COLOR: Record<string, number> = { fmj: 0xd8b050, ap: 0x5aa0e0, hp: 0xe06050, buck: 0xc03a30, slug: 0xe8e0c0 };
const TIER_COLOR = [0x9a9a9a, 0x6ab04a, 0x4a8ae0, 0xa060d0, 0xe0a030];

export function itemIcon(def: ItemDef): string {
  const hit = cache.get(def.id);
  if (hit) return hit;
  const w = def.size.w * CELL;
  const hgt = def.size.h * CELL;
  const p = new Px(w, hgt);
  const cx = w / 2;
  const cy = hgt / 2;
  switch (def.kind) {
    case 'weapon': {
      const ws = weaponSprite(def.id.split('.').pop()!);
      const sx = Math.max(1, Math.floor((w - 4) / ws.px.w));
      const scale = Math.min(sx, Math.floor((hgt - 4) / ws.px.h), 3);
      const ox = Math.floor((w - ws.px.w * scale) / 2);
      const oy = Math.floor((hgt - ws.px.h * scale) / 2);
      for (let y = 0; y < ws.px.h; y++)
        for (let x = 0; x < ws.px.w; x++) {
          const i = (y * ws.px.w + x) * 4;
          if (ws.px.data[i + 3]! === 0) continue;
          const c = (ws.px.data[i]! << 16) | (ws.px.data[i + 1]! << 8) | ws.px.data[i + 2]!;
          p.rect(ox + x * scale, oy + y * scale, scale, scale, shade(c, 1.6));
        }
      break;
    }
    case 'ammo': {
      const col = VARIANT_COLOR[def.ammo!.variant] ?? 0xd8b050;
      p.rect(2, 7, 12, 7, 0x5a4a32).rect(2, 7, 12, 1, 0x7a6a4a);
      for (let i = 0; i < 4; i++) {
        p.rect(3 + i * 3, 2, 2, 6, 0xc8a040);
        p.rect(3 + i * 3, 1, 2, 2, col);
      }
      break;
    }
    case 'magazine':
      p.rect(cx - 3, 3, 6, hgt - 6, 0x3a3c40).rect(cx - 3, 3, 6, 2, 0x6a6c70).rect(cx - 1, 1, 2, 3, 0xc8a040);
      if (def.tags.includes('extended')) p.rect(cx - 3, hgt - 8, 6, 5, 0x5a5c60);
      break;
    case 'attachment':
      if (def.attachment!.slot === 'muzzle') p.rect(2, cy - 2, w - 4, 4, def.id.endsWith('suppressor') ? 0x2a2c30 : 0x55585e).rect(2, cy - 2, w - 4, 1, 0x7a7e84);
      else if (def.attachment!.slot === 'grip') p.rect(cx - 2, 3, 4, 10, 0x3a3c40).rect(cx - 4, 2, 8, 2, 0x55585e);
      else p.rect(2, cy - 3, w - 6, 6, 0x4a4035).rect(w - 5, cy - 4, 3, 8, 0x5a5045);
      break;
    case 'armor': {
      const t = def.armor!.tier;
      if (def.armor!.slot === 'vest') {
        p.rect(8, 8, w - 16, hgt - 12, 0x4a5a3a).rect(10, 5, 6, 4, 0x4a5a3a).rect(w - 16, 5, 6, 4, 0x4a5a3a).rect(12, 14, w - 24, 8, 0x3a4a2e);
      } else {
        p.ellipse(cx, cy + 2, w / 2 - 4, hgt / 2 - 5, 0x4d5540).rect(4, cy + 4, w - 8, 2, 0x3a4030);
      }
      p.rect(w - 8, hgt - 8, 6, 6, TIER_COLOR[t]!);
      break;
    }
    case 'medical':
      if (def.medical!.type === 'bandage') p.ellipse(cx, cy, 6, 5, 0xf0f0e8).ellipse(cx, cy, 2, 2, 0xd0d0c8);
      else if (def.medical!.type === 'firstaid') p.rect(2, 4, w - 4, hgt - 8, 0xe8e8e0).rect(cx - 1, cy - 5, 3, 10, 0xd03030).rect(cx - 5, cy - 1, 10, 3, 0xd03030);
      else p.rect(cx - 3, 3, 6, 10, 0xf0f0f0).rect(cx - 3, 3, 6, 3, 0x3080d0);
      break;
    case 'throwable': {
      const c = def.throwable!.type === 'frag' ? 0x4a5a3a : def.throwable!.type === 'smoke' ? 0x7a7e84 : 0xd8d8b0;
      p.ellipse(cx, cy + 1, 5, 6, c).rect(cx - 1, 1, 3, 3, 0x8a8a8a).rect(cx + 2, 2, 3, 1, 0xc8a040);
      break;
    }
    case 'melee':
      if (def.id.endsWith('knife')) p.line(cx, 2, cx, hgt - 10, 0xc8ccd0).rect(cx - 1, hgt - 10, 3, 7, 0x3a2a1a);
      else p.line(cx - 2, 2, cx + 1, hgt - 3, 0x6a2a2a).line(cx - 3, 2, cx + 1, 2, 0x6a2a2a);
      break;
    case 'backpack':
      p.ellipse(cx, cy + 3, w / 2 - 4, hgt / 2 - 6, 0x5b6b4a).rect(cx - 6, 5, 12, 5, 0x3e4a33).rect(cx - 8, cy + 6, 16, 3, 0x4a5a3a);
      break;
    case 'accessory':
      if (def.id.endsWith('nvg')) p.rect(4, cy - 3, 10, 6, 0x2a2c30).rect(w - 14, cy - 3, 10, 6, 0x2a2c30).ellipse(9, cy, 2, 2, 0x40ff60).ellipse(w - 9, cy, 2, 2, 0x40ff60);
      else p.line(3, hgt - 3, w - 4, 3, 0xe0e0d8).line(4, hgt - 3, w - 3, 4, 0xa8a8a0);
      break;
    case 'key':
      p.ellipse(5, cy, 3.5, 3.5, 0xd8b040).ellipse(5, cy, 1.4, 1.4, 0x000000, 0).rect(7, cy - 1, 7, 2, 0xd8b040).rect(11, cy + 1, 1, 2, 0xd8b040).rect(13, cy + 1, 1, 3, 0xd8b040);
      break;
    case 'quest':
      if (def.id.endsWith('relief_package')) p.rect(3, 6, w - 6, hgt - 9, 0xc8a878).rect(cx - 2, 8, 4, hgt - 13, 0xd03030).rect(8, cy - 1, w - 16, 3, 0xd03030);
      else if (def.id.endsWith('relay_module')) p.rect(2, 3, w - 4, hgt - 6, 0x2a5a3a).noise(3, 4, w - 6, hgt - 8, 0xc8a040, 0.15, 5).rect(w - 6, 5, 3, 3, 0x40ff80);
      else p.rect(4, 4, w - 8, hgt - 8, 0x303848).rect(8, 8, w - 16, hgt - 16, 0x60a0ff).noise(8, 8, w - 16, hgt - 16, 0xc0e0ff, 0.2, 9);
      break;
    case 'tool':
      p.rect(2, 8, w - 4, hgt - 11, 0xb03a2a).rect(cx - 3, 4, 6, 5, 0x5a5a5a).rect(2, 8, w - 4, 2, 0xd05a4a);
      break;
    case 'valuable':
    case 'material':
    default: {
      const id = def.id;
      const col =
        id.includes('scrap') ? 0x7a7a7e : id.includes('part') ? 0x9a9aa0 : id.includes('cloth') ? 0xe0d8c8 : id.includes('antiseptic') ? 0x80c0e0 : id.includes('metal') ? 0xa0a4a8 : id.includes('powder') ? 0x4a4040 : id.includes('chem') ? 0x80d080 : id.includes('wire') ? 0xc86a30 : id.includes('power') ? 0x3a4a6a : id.includes('battery') ? 0x40a060 : id.includes('fuel') ? 0xc03030 : id.includes('ring') ? 0xe0c040 : id.includes('spoon') ? 0xd0d0d8 : id.includes('watch') ? 0xc8a040 : id.includes('radio') ? 0x6a5040 : id.includes('lens') ? 0x60a0c0 : id.includes('sample') ? 0xd04060 : id.includes('chip') ? 0x40c080 : 0xe8e0c8;
      if (id.includes('part')) {
        p.ellipse(cx, cy, 5.5, 5.5, col);
        for (let a = 0; a < 8; a++) p.rect(cx + Math.cos((a * Math.PI) / 4) * 6 - 1, cy + Math.sin((a * Math.PI) / 4) * 6 - 1, 2, 2, col);
        p.ellipse(cx, cy, 2, 2, 0x303030);
      } else if (id.includes('wire')) {
        p.ellipse(cx, cy, 6, 5, col).ellipse(cx, cy, 3.5, 2.5, 0x000000, 0);
      } else if (id.includes('ring')) {
        p.ellipse(cx, cy + 1, 5, 5, col).ellipse(cx, cy + 1, 3, 3, 0x202020).set(cx, cy - 4, 0x80f0ff);
      } else if (id.includes('note') || id.includes('market')) {
        p.rect(3, 2, 10, 12, 0xe8e0c8).line(5, 5, 11, 5, 0x606060).line(5, 8, 11, 8, 0x606060).line(5, 11, 9, 11, 0x606060);
      } else if (w >= 32 && hgt >= 32) {
        p.rect(4, 6, w - 8, hgt - 10, col).rect(4, 6, w - 8, 3, shade(col, 1.25));
        if (id.includes('power')) p.line(cx + 2, 10, cx - 3, cy + 2, 0xffe040).line(cx - 3, cy + 2, cx + 3, cy + 2, 0xffe040).line(cx + 3, cy + 2, cx - 2, hgt - 8, 0xffe040);
      } else {
        p.ellipse(cx, cy, 5.5, 5, col).noise(3, 3, w - 6, hgt - 6, shade(col, 0.75), 0.2, id.length);
      }
    }
  }
  p.outline(O);
  const url = p.toDataURL();
  cache.set(def.id, url);
  return url;
}
