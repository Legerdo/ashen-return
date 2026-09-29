import type { ContentRegistry } from '../content/registry';
import type { EquipSlot, ItemDef } from '../content/types';
import { footprint, type ContainerState, type ItemInstance, type ItemStore, type Placement } from '../inventory/store';
import { h } from './dom';
import { itemIcon } from './icons';

/** Backend for inventory UI: shelter (profile transactions) or raid (queued simulation ops). */
export interface InvAdapter {
  content: ContentRegistry;
  store(): ItemStore;
  move(itemId: string, target: Placement): void;
  equip(itemId: string, slot: EquipSlot): void;
  merge(fromId: string, toId: string): void;
  quickMove(itemId: string): void;
  primaryAction(itemId: string): void;
  contextActions(itemId: string): { label: string; run: () => void; danger?: boolean }[];
  isHidden(containerId: string, itemId: string): boolean;
  canDrag(itemId: string): boolean;
  describe(itemId: string): HTMLElement;
}

export const SLOT_LABELS: Record<EquipSlot, string> = {
  primary1: '주무기 1',
  primary2: '주무기 2',
  secondary: '보조무기',
  melee: '근접',
  helmet: '헬멧',
  vest: '조끼',
  backpack: '가방',
  accessory: '장신구',
};

function cellPx(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--cell').trim();
  const probe = document.createElement('div');
  probe.style.width = v || '34px';
  document.body.appendChild(probe);
  const w = probe.getBoundingClientRect().width || 34;
  probe.remove();
  return w;
}

let CELL = 34;
export function refreshCellSize(): void {
  CELL = cellPx();
}

interface DragState {
  itemId: string;
  def: ItemDef;
  rotation: 0 | 1;
  ghost: HTMLElement;
  srcEl: HTMLElement;
  adapter: InvAdapter;
  grabOffset: { x: number; y: number };
  moved: boolean;
  startX: number;
  startY: number;
}

let drag: DragState | null = null;
let tooltip: HTMLElement | null = null;
let menu: HTMLElement | null = null;

export function closeMenus(): void {
  menu?.remove();
  menu = null;
  tooltip?.remove();
  tooltip = null;
}

function showTooltip(adapter: InvAdapter, itemId: string, x: number, y: number): void {
  tooltip?.remove();
  tooltip = h('div', { class: 'tooltip' }, adapter.describe(itemId));
  document.body.appendChild(tooltip);
  const r = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.min(window.innerWidth - r.width - 8, x + 16)}px`;
  tooltip.style.top = `${Math.min(window.innerHeight - r.height - 8, y + 12)}px`;
}

function openMenu(adapter: InvAdapter, itemId: string, x: number, y: number): void {
  closeMenus();
  const acts = adapter.contextActions(itemId);
  if (acts.length === 0) return;
  menu = h('div', { class: 'ctxmenu', role: 'menu' }, ...acts.map((a) => h('button', { role: 'menuitem', class: a.danger ? 'bad' : '', onclick: (e) => {
    e.stopPropagation();
    closeMenus();
    a.run();
  } }, a.label)));
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(window.innerWidth - r.width - 6, x)}px`;
  menu.style.top = `${Math.min(window.innerHeight - r.height - 6, y)}px`;
  (menu.querySelector('button') as HTMLButtonElement | null)?.focus();
}

window.addEventListener('pointerdown', (e) => {
  if (menu && !menu.contains(e.target as Node)) closeMenus();
});

function itemEl(adapter: InvAdapter, it: ItemInstance, cont: ContainerState, inSlot: boolean): HTMLElement {
  const def = adapter.content.item(it.definitionId);
  const hidden = adapter.isHidden(cont.id, it.instanceId);
  const fp = footprint(def, it.rotation);
  const el = h('div', { class: `item${def.kind === 'quest' ? ' quest' : ''}${it.lockTags.includes('favorite') ? ' fav' : ''}${hidden ? ' hidden-item' : ''}`, data: { item: it.instanceId }, attrs: { 'aria-label': hidden ? '미확인 아이템' : adapter.content.t(def.nameKey), tabindex: '0' } });
  if (!inSlot) {
    if (cont.kind === 'grid' && it.gridPosition) {
      el.style.left = `${it.gridPosition.x * CELL}px`;
      el.style.top = `${it.gridPosition.y * CELL}px`;
    }
    el.style.width = `${fp.w * CELL}px`;
    el.style.height = `${fp.h * CELL}px`;
  }
  if (!hidden) {
    const img = h('img', { attrs: { alt: '', src: itemIcon(def) } });
    if (it.rotation === 1 && !inSlot) img.style.transform = 'rotate(90deg)';
    if (it.rotation === 1 && !inSlot) {
      img.style.width = `${fp.h * CELL}px`;
      img.style.height = `${fp.w * CELL}px`;
    }
    el.append(img);
    let qty = '';
    if (def.stackMax > 1 && it.quantity > 1) qty = String(it.quantity);
    if (it.mag) qty = `${it.mag.rounds.length}/${def.magazine!.capacity}`;
    if (def.weapon) {
      const inMag = it.weapon?.magazineId ? (adapter.store().items[it.weapon.magazineId]?.mag?.rounds.length ?? 0) : (it.weapon?.tube?.length ?? 0);
      qty = `${inMag}+${it.weapon?.chamber ? 1 : 0}`;
    }
    if (def.medical?.type === 'firstaid') qty = `${Math.round(it.medPool ?? 40)}`;
    if (qty) el.append(h('span', { class: 'qty' }, qty));
    if (def.armor) el.append(h('span', { class: 'tag' }, `${def.armor.tier}등급 ${Math.round(it.durability ?? 0)}`));
    else if (def.weapon && it.durability !== null) el.append(h('span', { class: 'tag' }, `${Math.round(it.durability)}%`));
    el.addEventListener('pointerenter', (e) => {
      if (!drag) showTooltip(adapter, it.instanceId, e.clientX, e.clientY);
    });
    el.addEventListener('pointermove', (e) => {
      if (tooltip && !drag) {
        tooltip.style.left = `${Math.min(window.innerWidth - tooltip.offsetWidth - 8, e.clientX + 16)}px`;
        tooltip.style.top = `${Math.min(window.innerHeight - tooltip.offsetHeight - 8, e.clientY + 12)}px`;
      }
    });
    el.addEventListener('pointerleave', () => {
      tooltip?.remove();
      tooltip = null;
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(adapter, it.instanceId, e.clientX, e.clientY);
    });
    el.addEventListener('dblclick', () => adapter.primaryAction(it.instanceId));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') adapter.primaryAction(it.instanceId);
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        const r = el.getBoundingClientRect();
        openMenu(adapter, it.instanceId, r.left, r.bottom);
      }
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.shiftKey) {
        e.preventDefault();
        adapter.quickMove(it.instanceId);
        return;
      }
      if (!adapter.canDrag(it.instanceId)) return;
      startDrag(adapter, it, def, el, e);
    });
  }
  return el;
}

function startDrag(adapter: InvAdapter, it: ItemInstance, def: ItemDef, el: HTMLElement, e: PointerEvent): void {
  e.preventDefault();
  closeMenus();
  const r = el.getBoundingClientRect();
  const ghost = h('div', { class: 'ghost' }, h('img', { attrs: { alt: '', src: itemIcon(def) } }));
  drag = { itemId: it.instanceId, def, rotation: it.rotation, ghost, srcEl: el, adapter, grabOffset: { x: Math.min(e.clientX - r.left, CELL / 2), y: Math.min(e.clientY - r.top, CELL / 2) }, moved: false, startX: e.clientX, startY: e.clientY };
  sizeGhost();
  positionGhost(e.clientX, e.clientY);
}

function sizeGhost(): void {
  if (!drag) return;
  const fp = footprint(drag.def, drag.rotation);
  drag.ghost.style.width = `${fp.w * CELL}px`;
  drag.ghost.style.height = `${fp.h * CELL}px`;
  const img = drag.ghost.querySelector('img')!;
  img.style.transform = drag.rotation === 1 ? 'rotate(90deg)' : '';
  if (drag.rotation === 1) {
    img.style.width = `${fp.h * CELL}px`;
    img.style.height = `${fp.w * CELL}px`;
  } else {
    img.style.width = '100%';
    img.style.height = '100%';
  }
}

function positionGhost(x: number, y: number): void {
  if (!drag) return;
  drag.ghost.style.left = `${x - drag.grabOffset.x}px`;
  drag.ghost.style.top = `${y - drag.grabOffset.y}px`;
}

function clearHighlights(): void {
  for (const el of document.querySelectorAll('.drop-ok, .drop-bad')) el.classList.remove('drop-ok', 'drop-bad');
}

window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 4) {
    drag.moved = true;
    document.body.appendChild(drag.ghost);
    drag.srcEl.classList.add('dragging');
    tooltip?.remove();
    tooltip = null;
  }
  if (!drag.moved) return;
  positionGhost(e.clientX, e.clientY);
  clearHighlights();
  const t = document.elementsFromPoint(e.clientX, e.clientY).find((el) => (el as HTMLElement).dataset['container'] || (el as HTMLElement).dataset['slot']) as HTMLElement | undefined;
  if (t) t.classList.add('drop-ok');
});

window.addEventListener('keydown', (e) => {
  if (drag && (e.key === 'r' || e.key === 'R' || e.code === 'KeyR')) {
    e.preventDefault();
    e.stopPropagation();
    if (drag.def.size.w !== drag.def.size.h) {
      drag.rotation = drag.rotation === 1 ? 0 : 1;
      sizeGhost();
    }
  }
  if (drag && e.key === 'Escape') {
    e.stopPropagation();
    endDrag();
  }
}, true);

function endDrag(): void {
  if (!drag) return;
  drag.ghost.remove();
  drag.srcEl.classList.remove('dragging');
  clearHighlights();
  drag = null;
}

window.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag;
  if (!d.moved) {
    endDrag();
    return;
  }
  const els = document.elementsFromPoint(e.clientX, e.clientY) as HTMLElement[];
  const itemTarget = els.find((el) => el.dataset['item'] && el.dataset['item'] !== d.itemId && !el.classList.contains('ghost'));
  const slotTarget = els.find((el) => el.dataset['slot']);
  const contTarget = els.find((el) => el.dataset['container']);
  endDrag();
  const store = d.adapter.store();
  const src = store.items[d.itemId];
  if (!src) return;
  if (itemTarget) {
    const other = store.items[itemTarget.dataset['item']!];
    if (other && other.definitionId === src.definitionId && d.adapter.content.item(src.definitionId).stackMax > 1) {
      d.adapter.merge(d.itemId, other.instanceId);
      return;
    }
  }
  if (slotTarget) {
    d.adapter.equip(d.itemId, slotTarget.dataset['slot'] as EquipSlot);
    return;
  }
  if (contTarget) {
    const cid = contTarget.dataset['container']!;
    const cont = store.containers[cid];
    if (!cont) return;
    if (cont.kind === 'grid') {
      const r = contTarget.getBoundingClientRect();
      const gx = Math.floor((e.clientX - d.grabOffset.x + CELL / 2 - r.left) / CELL);
      const gy = Math.floor((e.clientY - d.grabOffset.y + CELL / 2 - r.top) / CELL);
      d.adapter.move(d.itemId, { containerId: cid, x: Math.max(0, gx), y: Math.max(0, gy), rotation: d.rotation });
    } else d.adapter.move(d.itemId, { containerId: cid });
  }
});

/**
 * A grid/list container. `matches` (optional category filter) dims the items that do not match — they stay in
 * place and fully usable, so the layout never jumps while filtering.
 */
export function containerView(adapter: InvAdapter, containerId: string, title: string, extra?: HTMLElement | string, matches?: (def: ItemDef) => boolean): HTMLElement {
  const store = adapter.store();
  const cont = store.containers[containerId];
  if (!cont) return h('div', { class: 'muted' }, `${title}: 없음`);
  const grid = h('div', { class: `grid${cont.kind === 'list' ? ' list' : ''}`, data: { container: containerId }, attrs: { 'aria-label': title } });
  if (cont.kind === 'grid') {
    grid.style.width = `${cont.w * CELL + 2}px`;
    grid.style.height = `${cont.h * CELL + 2}px`;
  } else {
    grid.style.minWidth = `${CELL * 6}px`;
  }
  for (const id of cont.items) {
    const it = store.items[id];
    if (!it) continue;
    const el = itemEl(adapter, it, cont, false);
    if (matches && !matches(adapter.content.item(it.definitionId))) {
      el.classList.add('dim');
      el.dataset['filtered'] = 'out';
    }
    if (cont.kind === 'list') {
      const fp = footprint(adapter.content.item(it.definitionId), 0);
      el.style.width = `${Math.min(3, fp.w) * CELL}px`;
      el.style.height = `${Math.min(2, fp.h) * CELL}px`;
    }
    grid.append(el);
  }
  return h('div', { class: 'grid-wrap' }, h('div', { class: 'grid-title' }, h('span', null, title), extra ?? null), grid);
}

export function slotView(adapter: InvAdapter, containerId: string, slot: EquipSlot): HTMLElement {
  const store = adapter.store();
  const cont = store.containers[containerId];
  const el = h('div', { class: 'eqslot', data: { slot }, attrs: { 'aria-label': SLOT_LABELS[slot] } }, h('span', { class: 'label' }, SLOT_LABELS[slot]));
  const id = cont?.items[0];
  const it = id ? store.items[id] : undefined;
  if (it && cont) el.append(itemEl(adapter, it, cont, true));
  return el;
}
