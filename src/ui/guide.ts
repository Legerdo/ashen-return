import { VIEW_H, VIEW_W, viewToClient, worldToView, type DisplayRect, type ViewCamera } from '../core/coords';
import { h } from './dom';

/**
 * Guidance markers (DOM, crisp text): a head marker above an on-screen target and, when the target is off-screen,
 * an arrow pinned to the edge of the game view pointing at it (with its name and distance).
 */
export interface GuideMark {
  /** Stable identity (DOM element reuse). */
  key: string;
  x: number;
  y: number;
  /** Marker height above the ground (world units). */
  z: number;
  icon: string;
  label: string;
  name: string;
  tone: 'report' | 'task';
}

/** TUNABLE: inset of the edge arrows from the view border (view px); the bottom inset keeps them above the HUD. */
export const EDGE_INSET = { left: 26, right: 26, top: 30, bottom: 58 };
/** A marker counts as on-screen while its anchor is at least this far inside the view (view px). */
const ONSCREEN_MARGIN = 10;

export interface EdgePoint {
  x: number;
  y: number;
  angle: number;
}

/**
 * Where an off-screen target is pinned on the inset view box (view px): the ray from the box centre towards the
 * target leaves the box there (robust even when the camera is clamped at a map border and the player sits near a
 * view edge). The arrow angle points from the player (`from`) to the target.
 */
export function edgePoint(from: { x: number; y: number }, to: { x: number; y: number }, box: { x0: number; y0: number; x1: number; y1: number }): EdgePoint {
  const px = (box.x0 + box.x1) / 2;
  const py = (box.y0 + box.y1) / 2;
  const dx = to.x - px;
  const dy = to.y - py;
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  let t = Infinity;
  if (dx > 1e-9) t = Math.min(t, (box.x1 - px) / dx);
  if (dx < -1e-9) t = Math.min(t, (box.x0 - px) / dx);
  if (dy > 1e-9) t = Math.min(t, (box.y1 - py) / dy);
  if (dy < -1e-9) t = Math.min(t, (box.y0 - py) / dy);
  if (!Number.isFinite(t)) t = 0;
  t = Math.max(0, Math.min(1, t));
  return { x: Math.min(box.x1, Math.max(box.x0, px + dx * t)), y: Math.min(box.y1, Math.max(box.y0, py + dy * t)), angle };
}

export function onScreen(sx: number, sy: number): boolean {
  return sx >= ONSCREEN_MARGIN && sx <= VIEW_W - ONSCREEN_MARGIN && sy >= ONSCREEN_MARGIN && sy <= VIEW_H - ONSCREEN_MARGIN;
}

interface MarkEls {
  head: HTMLElement;
  headIcon: HTMLElement;
  headLabel: HTMLElement;
  edge: HTMLElement;
  edgeArrow: HTMLElement;
  edgeText: HTMLElement;
}

export class GuideLayer {
  private els = new Map<string, MarkEls>();

  constructor(private readonly root: HTMLElement) {}

  update(marks: GuideMark[], view: ViewCamera, rect: DisplayRect, player: { x: number; y: number }, bottomReserve = 0): void {
    const seen = new Set<string>();
    const pv = worldToView(view, player.x, player.y, 1);
    const box = { x0: EDGE_INSET.left, y0: EDGE_INSET.top, x1: VIEW_W - EDGE_INSET.right, y1: VIEW_H - EDGE_INSET.bottom - bottomReserve };
    for (const m of marks) {
      seen.add(m.key);
      const el = this.els.get(m.key) ?? this.make(m.key);
      const v = worldToView(view, m.x, m.y, m.z);
      const tone = `tone-${m.tone}`;
      if (onScreen(v.sx, v.sy)) {
        const c = viewToClient(rect, v.sx, v.sy);
        setText(el.headIcon, m.icon);
        setText(el.headLabel, m.label);
        el.head.className = `guide-head ${tone}`;
        el.head.style.left = `${c.clientX}px`;
        el.head.style.top = `${c.clientY}px`;
        show(el.head, true);
        show(el.edge, false);
      } else {
        const e = edgePoint({ x: pv.sx, y: pv.sy }, { x: v.sx, y: v.sy }, box);
        const c = viewToClient(rect, e.x, e.y);
        const dist = Math.round(Math.hypot(m.x - player.x, m.y - player.y));
        setText(el.edgeText, `${m.tone === 'report' ? `${m.icon} ` : ''}${m.name} · ${m.label} ${dist}m`);
        // The pill grows inward from the border it is pinned to, with the arrow at the border end.
        const side = e.x >= box.x1 - 0.5 ? 'right' : e.x <= box.x0 + 0.5 ? 'left' : e.y <= box.y0 + 0.5 ? 'top' : 'bottom';
        el.edge.className = `guide-edge ${tone} side-${side}`;
        el.edge.style.left = `${c.clientX}px`;
        el.edge.style.top = `${c.clientY}px`;
        el.edgeArrow.style.transform = `rotate(${e.angle}rad)`;
        show(el.edge, true);
        show(el.head, false);
      }
    }
    for (const [key, el] of this.els) {
      if (seen.has(key)) continue;
      el.head.remove();
      el.edge.remove();
      this.els.delete(key);
    }
  }

  clear(): void {
    for (const el of this.els.values()) {
      el.head.remove();
      el.edge.remove();
    }
    this.els.clear();
  }

  private make(key: string): MarkEls {
    const headIcon = h('span', { class: 'gi' });
    const headLabel = h('span', { class: 'gl' });
    const head = h('div', { class: 'guide-head', data: { guide: key, testid: `guide-head-${key}` } }, headIcon, headLabel);
    const edgeArrow = h('span', { class: 'ga', attrs: { 'aria-hidden': 'true' } });
    const edgeText = h('span', { class: 'gt' });
    const edge = h('div', { class: 'guide-edge', data: { guide: key, testid: `guide-edge-${key}` } }, edgeArrow, edgeText);
    head.style.display = 'none';
    edge.style.display = 'none';
    this.root.append(head, edge);
    const els = { head, headIcon, headLabel, edge, edgeArrow, edgeText };
    this.els.set(key, els);
    return els;
  }
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function show(el: HTMLElement, v: boolean): void {
  const want = v ? '' : 'none';
  if (el.style.display !== want) el.style.display = want;
}
