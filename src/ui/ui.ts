import type { GameApp } from '../game/app';
import type { SaveStore, SlotSummary } from '../save/saveStore';
import type { SimEvent } from '../world/state';
import { btn, fmtCredits, fmtTime, h } from './dom';
import { Hud } from './hud';
import { closeMenus, refreshCellSize } from './inventoryView';
import {
  boardPanel,
  buildPanel,
  chapterPanel,
  craftPanel,
  deployPanel,
  generatorPanel,
  mapPanel,
  marketPanel,
  notePanel,
  npcPanel,
  pausePanel,
  raidInventoryPanel,
  rangePanel,
  recoveryPanel,
  settingsPanel,
  stashPanel,
  summaryPanel,
  type UiCtx,
} from './panels';

/** DOM UI root: title/slot screen, modal panels, toasts and the HUD. Re-renders panels only when their signature changes. */
/** Panels toggled by the inventory key itself (Tab closes them; Shift+Tab moves focus inside). */
const INVENTORY_PANELS = new Set(['inventory', 'loot', 'station:stash']);

/** Keyboard-reachable controls of a subtree, in DOM (tab) order. */
function focusablesIn(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex="0"]')].filter((el) => el.getClientRects().length > 0);
}

export class UIRoot {
  private layer = document.getElementById('ui-layer')!;
  private toastLayer = document.getElementById('toast-layer')!;
  private hud: Hud;
  private lastSig = '';
  private dirty = true;
  private slots: { slotId: number; summary: SlotSummary | null }[] = [];
  private uictx: UiCtx;
  private lastPanel: { name: string; arg: string | null } | null = null;
  private lastToastSig = '';
  private lastRender = 0;
  private titleName: Record<number, string> = {};

  constructor(
    private readonly app: GameApp,
    private readonly store: SaveStore,
  ) {
    this.hud = new Hud(app);
    this.uictx = { app, content: app.content, invalidate: () => this.invalidate(), close: () => this.closePanel(), state: {} };
    app.onRender = () => this.frame();
    app.onUiEvent = (e: SimEvent) => this.hud.onEvent(e as SimEvent & { __sx?: number; __sy?: number });
    app.input.onToggle = (a) => this.onToggle(a);
    window.addEventListener('resize', () => {
      refreshCellSize();
      this.invalidate();
    });
    refreshCellSize();
    // Modal dialogs keep keyboard focus inside themselves (Tab / Shift+Tab wrap around). Runs before the game input
    // handler on window, which leaves Tab alone while a dialog is open (see InputManager.tabNavigates).
    document.addEventListener('keydown', (e) => this.trapFocus(e));
  }

  private trapFocus(e: KeyboardEvent): void {
    if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return;
    const dlg = this.layer.querySelector<HTMLElement>('[role="dialog"]');
    if (!dlg) return;
    const p = this.app.panel;
    if (p && INVENTORY_PANELS.has(p.name) && !e.shiftKey) return; // plain Tab closes the inventory
    const items = focusablesIn(dlg);
    if (items.length === 0) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = i < 0 ? (e.shiftKey ? items.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + items.length) % items.length;
    items[next]!.focus();
  }

  invalidate(): void {
    this.dirty = true;
  }

  async refreshSlots(): Promise<void> {
    this.slots = await this.store.listSlots();
    this.invalidate();
  }

  private closePanel(): void {
    closeMenus();
    this.app.closePanel();
    this.invalidate();
  }

  private onToggle(a: string): void {
    const app = this.app;
    this.app.audio.unlock();
    if (!app.inWorld) {
      if (a === 'pause' && app.panel) this.closePanel();
      return;
    }
    if (a === 'pause') {
      closeMenus();
      app.togglePause();
    } else if (a === 'inventory') {
      if (app.panel && (app.panel.name === 'inventory' || app.panel.name === 'loot' || app.panel.name === 'station:stash')) this.closePanel();
      else if (!app.panel || app.panel.name === 'map') {
        if (app.mode === 'raid' || app.mode === 'tutorial') app.openPanel(app.ctx?.sim.loot ? 'loot' : 'inventory', app.ctx?.sim.loot?.containerId ?? null);
        else app.openPanel('station:stash', 'stash');
      }
    } else if (a === 'map') {
      if (app.panel?.name === 'map') this.closePanel();
      else if (!app.panel) app.openPanel('map', null);
    } else if (a === 'debug' && (import.meta.env.DEV || __E2E__)) {
      void app.updateSettings({ debugOverlay: !app.settings.debugOverlay });
    }
    this.invalidate();
  }

  private panelSig(): string {
    const app = this.app;
    const p = app.panel;
    const prof = app.profile;
    let live = '';
    if ((app.mode === 'raid' || app.mode === 'tutorial') && app.ctx && p && (p.name === 'loot' || p.name === 'inventory')) {
      const sim = app.ctx.sim;
      const lootC = p.arg ? sim.store.containers[p.arg] : undefined;
      const wc = p.arg ? sim.containers[p.arg] : undefined;
      const bagId = sim.store.containers['eq:player:backpack']?.items[0];
      const bag = bagId ? sim.store.containers[`bag:${bagId}`] : undefined;
      live = JSON.stringify([lootC?.items, wc?.searched, bag?.items, sim.actors[0]?.action?.type, Object.values(sim.store.items).length, sim.store.containers['eq:player:primary1']?.items, sim.store.containers['eq:player:secondary']?.items, sim.actors[0]?.quickslots]);
    }
    if (p?.name === 'station:workbench' || p?.name === 'station:medical') live += JSON.stringify(prof?.crafting.jobs.map((j) => Math.ceil(j.remaining * 4)));
    if (p?.name === 'station:range_terminal') live += JSON.stringify(app.ctx?.sim.range) + app.ctx?.sim.shotLog.length;
    if (p?.name === 'map') live += Math.floor((app.ctx?.sim.time ?? 0) * 2);
    return `${app.mode}|${p?.name}|${p?.arg}|${app.busy}|${prof ? prof.updatedAt + '|' + prof.ledger.committed.length + '|' + prof.currency : ''}|${this.slots.map((s) => s.summary?.updatedAt ?? 0).join(',')}|${JSON.stringify(this.uictx.state)}|${app.pendingRecovery?.slotId ?? ''}|${live}`;
  }

  /**
   * Per-open panel state. A conversation always starts on the talk tab (where quest turn-ins live), the build tool
   * starts with nothing selected, and the archive / inventory open on their own tab. Tabs chosen while the panel is
   * open keep working because this only runs when a new panel object is opened.
   */
  private syncPanelOpen(): void {
    const app = this.app;
    const p = app.panel;
    app.input.tabNavigates = app.mode === 'title' || app.mode === 'boot' || (!!p && !INVENTORY_PANELS.has(p.name));
    if (p === this.lastPanel) return;
    this.lastPanel = p;
    document.body.dataset['panel'] = p ? 'open' : '';
    if (!p) {
      // Hand keyboard focus back to the game when a panel closes (instead of leaving it on a removed button).
      const ae = document.activeElement;
      if (app.mode !== 'title' && (!ae || ae === document.body || this.layer.contains(ae))) document.getElementById('game-frame')?.focus({ preventScroll: true });
      return;
    }
    const s = this.uictx.state;
    if (p.name === 'npc' && p.arg) s[`npc:${p.arg}`] = 'talk';
    else if (p.name === 'station:build') {
      delete s['bld'];
      delete s['moveGuid'];
      delete s['hover'];
    } else if (p.name === 'station:archive') s['invTab'] = 'notes';
    else if (p.name === 'station:stash' || p.name === 'inventory') s['invTab'] = 'stash';
    this.invalidate();
  }

  private frame(): void {
    this.syncPanelOpen();
    this.hud.update();
    this.renderToasts();
    const now = performance.now();
    const sig = this.panelSig();
    if (!this.dirty && sig === this.lastSig) return;
    if (!this.dirty && now - this.lastRender < 120) return;
    this.dirty = false;
    this.lastSig = sig;
    this.lastRender = now;
    this.render();
  }

  private renderToasts(): void {
    const sig = this.app.toasts.map((t) => t.id).join(',');
    if (sig === this.lastToastSig) return;
    this.lastToastSig = sig;
    this.toastLayer.replaceChildren(...this.app.toasts.map((t) => h('div', { class: `toast ${t.kind}` }, t.text)));
  }

  private render(): void {
    const app = this.app;
    const u = this.uictx;
    // Keep keyboard focus stable across re-renders: same control by test id, else the same tab position.
    const ae = document.activeElement as HTMLElement | null;
    const inLayer = !!ae && this.layer.contains(ae);
    const focusedTestId = inLayer ? ae!.dataset['testid'] : undefined;
    const focusIndex = inLayer ? focusablesIn(this.layer).indexOf(ae!) : -1;
    let view: HTMLElement | null = null;
    if (app.mode === 'title' || app.mode === 'boot') {
      view = app.pendingRecovery ? recoveryPanel(u) : app.panel?.name === 'settings' ? settingsPanel(u) : this.title();
    } else if (app.panel) {
      const p = app.panel;
      try {
        view = this.panelFor(p.name, p.arg);
      } catch (e) {
        console.error(e);
        view = h('div', { class: 'overlay' }, h('div', { class: 'panel narrow' }, h('div', { class: 'panel-body' }, `UI 오류: ${String(e)}`, btn('닫기', () => this.closePanel()))));
      }
    }
    this.layer.replaceChildren(...(view ? [view] : []));
    let target: HTMLElement | null = focusedTestId ? this.layer.querySelector<HTMLElement>(`[data-testid="${focusedTestId}"]`) : null;
    if (!target && focusIndex >= 0) target = focusablesIn(this.layer)[focusIndex] ?? null;
    if (target) target.focus({ preventScroll: true });
    else if (view && app.panel) (view.querySelector('.panel .btn') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  private panelFor(name: string, arg: string | null): HTMLElement | null {
    const u = this.uictx;
    const app = this.app;
    switch (name) {
      case 'pause':
        return pausePanel(u, arg);
      case 'settings':
        return settingsPanel(u);
      case 'summary':
        return summaryPanel(u);
      case 'chapter':
        return chapterPanel(u);
      case 'map':
        return mapPanel(u);
      case 'note':
        return arg ? notePanel(u, arg) : null;
      case 'npc':
        return arg ? npcPanel(u, arg) : null;
      case 'inventory':
        return app.mode === 'raid' || app.mode === 'tutorial' ? raidInventoryPanel(u, null) : stashPanel(u);
      case 'loot':
        return raidInventoryPanel(u, arg);
    }
    if (name.startsWith('station:')) {
      const st = name.slice(8);
      switch (st) {
        case 'deploy':
          return deployPanel(u);
        case 'stash':
          return stashPanel(u);
        case 'shelf':
          return stashPanel(u, { shelf: true });
        case 'workbench':
          return craftPanel(u, 'workbench');
        case 'medical':
          return craftPanel(u, 'medical');
        case 'board':
          return boardPanel(u);
        case 'market':
          return marketPanel(u);
        case 'archive':
          return stashPanel(u);
        case 'generator':
        case 'power':
          return generatorPanel(u);
        case 'build':
          return buildPanel(u);
        case 'range_rack':
          return rangePanel(u, 'rack');
        case 'range_terminal':
          return rangePanel(u, 'terminal');
      }
    }
    return null;
  }

  private title(): HTMLElement {
    const app = this.app;
    const cards = this.slots.map((s) => {
      const sum = s.summary;
      const nameInput = h('input', { type: 'text', value: this.titleName[s.slotId] ?? '', attrs: { placeholder: '생존자 이름', maxlength: '16', 'aria-label': `슬롯 ${s.slotId} 이름`, 'data-testid': `slot-name-${s.slotId}` }, oninput: (e) => (this.titleName[s.slotId] = (e.target as HTMLInputElement).value) });
      const fileInput = h('input', { type: 'file', attrs: { accept: 'application/json,.json', 'aria-label': `슬롯 ${s.slotId} 가져오기`, 'data-testid': `slot-import-${s.slotId}` }, style: 'display:none', onchange: async (e) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        if (!f) return;
        try {
          const pkg = JSON.parse(await f.text());
          if (sum && !window.confirm(`슬롯 ${s.slotId}의 기존 저장을 가져온 데이터로 교체할까요?`)) return;
          const r = await this.store.importInto(s.slotId, pkg, app.content);
          if (r.ok) app.toast('가져오기 완료', 'good');
          else app.toast(`가져오기 실패: ${r.errors.join(', ')}`, 'error', 6000);
        } catch (err) {
          app.toast(`가져오기 실패: ${String(err)}`, 'error', 6000);
        }
        await this.refreshSlots();
      } });
      return h(
        'div',
        { class: 'slot', attrs: { 'data-testid': `slot-${s.slotId}` } },
        h('h3', null, `슬롯 ${s.slotId}${sum ? ` — ${sum.name}` : ''}`),
        sum ? h('div', { class: 'meta' }, `Lv.${sum.level} · ${app.content.t(`act.${Math.min(5, sum.act)}.name`)} · ${fmtCredits(sum.currency)}${sum.inRaid ? ' · 출격 중' : ''}${sum.chapterComplete ? ' · Chapter 1 완료' : ''}`, h('br'), `플레이 ${fmtTime(sum.playTime)} · ${new Date(sum.updatedAt).toLocaleString('ko-KR')}`) : h('div', { class: 'meta' }, '비어 있음'),
        sum
          ? h('div', { class: 'row' }, btn('이어하기', () => void app.continueGame(s.slotId).then(() => this.invalidate()), { class: 'primary', testid: `slot-continue-${s.slotId}` }), btn('내보내기', async () => {
              try {
                const pkg = await this.store.exportSlot(s.slotId);
                const blob = new Blob([JSON.stringify(pkg)], { type: 'application/json' });
                const a = h('a', { attrs: { href: URL.createObjectURL(blob), download: `ashen-return-slot${s.slotId}.json` } });
                document.body.append(a);
                a.click();
                a.remove();
              } catch (err) {
                app.toast(String(err), 'error');
              }
            }, { class: 'small', testid: `slot-export-${s.slotId}` }), btn('가져오기', () => fileInput.click(), { class: 'small' }), btn('삭제', async () => {
              if (!window.confirm(`슬롯 ${s.slotId}를 삭제할까요? 되돌릴 수 없습니다.`)) return;
              await this.store.deleteSlot(s.slotId);
              await this.refreshSlots();
            }, { class: 'small danger', testid: `slot-delete-${s.slotId}` }))
          : h('div', { class: 'row' }, nameInput, btn('새로 시작', () => void app.newGame(s.slotId, this.titleName[s.slotId] ?? '').then(() => this.invalidate()), { class: 'primary', testid: `slot-new-${s.slotId}` }), btn('가져오기', () => fileInput.click(), { class: 'small' })),
        fileInput,
      );
    });
    return h(
      'div',
      { class: 'title-screen', attrs: { 'data-testid': 'title' } },
      h('div', { class: 'title-logo' }, '잿빛 귀환: 격리구역'),
      h('div', { class: 'title-sub' }, 'Ashen Return: Quarantine Zone — Chapter 1 · 싱글플레이 PvE 탈출형 슈터'),
      h('div', { class: 'slots' }, ...cards),
      h('div', { class: 'row' }, btn('설정', () => app.openPanel('settings', null), { testid: 'title-settings' })),
      h('div', { class: 'controls-help' }, 'WASD 이동 · 마우스 조준 · 좌클릭 발사 · 우클릭 정밀 조준 · R 재장전 (0.25초 안에 두 번: 빠른 장전) · B 발사 모드 · Shift 달리기 · C 웅크리기 · E 상호작용 · Tab 인벤토리 · 1,2 주무기 · 3 보조무기 · 4~7 퀵슬롯 · V 근접 · G(누르고 조준, 떼면) 투척 · M 지도 · Esc 일시정지'),
      h('div', { class: 'controls-help' }, '저장은 이 브라우저의 IndexedDB에 보관됩니다. 서버나 로그인이 필요 없습니다.'),
    );
  }
}
