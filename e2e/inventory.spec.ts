import { expect, test, type Page } from '@playwright/test';
import { api, boot, closePanels, focusGame, newSlot, openStation, shot, talkTo, waitMode } from './helpers';

/**
 * INV-UI through the real DOM inventory with real mouse/keyboard input (starter stash of a new slot + one real
 * trader purchase): category filter, drag to a cell, rotate while dragging (R), split (context menu), merge (drag
 * onto the stack), compare tooltip, equip (double-click), unload / load a magazine, favorite lock, quick move
 * (Shift+click), stable sort; in a raid: use a bandage and drop an item on the ground. Every step checks the
 * profile/raid store behind the UI.
 */

interface It {
  instanceId: string;
  definitionId: string;
  quantity: number;
  ownerContainerId: string | null;
  gridPosition: { x: number; y: number } | null;
  rotation: 0 | 1;
  lockTags: string[];
  mag: { rounds: string[] } | null;
}
interface Prof {
  store: { items: Record<string, It>; containers: Record<string, { items: string[]; w: number; h: number; kind: string }> };
  currency: number;
}

const prof = (page: Page) => api<Prof>(page, 'profile');
const inStash = (p: Prof, def: string) => p.store.containers['stash']!.items.map((id) => p.store.items[id]!).filter((i) => i.definitionId === def);

async function cellSize(page: Page, container: string): Promise<{ x: number; y: number; cell: number }> {
  const p = await prof(page);
  const box = (await page.locator(`[data-container="${container}"]`).boundingBox())!;
  return { x: box.x, y: box.y, cell: (box.width - 2) / p.store.containers[container]!.w };
}

/** Real pointer drag of an item (grabbed at its top-left cell) onto a grid cell, optionally pressing R mid-drag. */
async function drag(page: Page, itemId: string, container: string, to: { x: number; y: number }, rotate = false): Promise<void> {
  const g = await cellSize(page, container);
  const b = (await page.locator(`[data-item="${itemId}"]`).boundingBox())!;
  const sx = b.x + g.cell / 2;
  const sy = b.y + g.cell / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 12, sy + 9, { steps: 4 });
  if (rotate) await page.keyboard.press('r');
  await page.mouse.move(g.x + to.x * g.cell + g.cell / 2, g.y + to.y * g.cell + g.cell / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

/** Drag an item onto another item element (stack merge). */
async function dragOnto(page: Page, itemId: string, targetId: string): Promise<void> {
  const b = (await page.locator(`[data-item="${itemId}"]`).boundingBox())!;
  const t = (await page.locator(`[data-item="${targetId}"]`).boundingBox())!;
  await page.mouse.move(b.x + 8, b.y + 8);
  await page.mouse.down();
  await page.mouse.move(b.x + 20, b.y + 18, { steps: 4 });
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

async function menu(page: Page, itemId: string, label: string | RegExp): Promise<void> {
  await page.locator(`[data-item="${itemId}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: label }).click();
  await page.waitForTimeout(250);
}

/** A free top-left cell for a w×h footprint in a profile grid. */
function freeCell(p: Prof, cid: string, w: number, h: number, defs: Record<string, { w: number; h: number }>): { x: number; y: number } {
  const c = p.store.containers[cid]!;
  const occ = new Set<string>();
  for (const id of c.items) {
    const it = p.store.items[id]!;
    const fp = defs[it.definitionId] ?? { w: 1, h: 1 };
    const [fw, fh] = it.rotation === 1 ? [fp.h, fp.w] : [fp.w, fp.h];
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) occ.add(`${it.gridPosition!.x + x},${it.gridPosition!.y + y}`);
  }
  for (let y = c.h - h; y >= 0; y--)
    for (let x = c.w - w; x >= 0; x--) {
      let ok = true;
      for (let yy = 0; yy < h && ok; yy++) for (let xx = 0; xx < w && ok; xx++) if (occ.has(`${x + xx},${y + yy}`)) ok = false;
      if (ok) return { x, y };
    }
  throw new Error('no free cell');
}

test('@p0 @inv inventory UI: filter, drag, rotate, split, merge, compare, equip, load, lock, quick move, sort; raid use + drop', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const info = await boot(page);
  await newSlot(page, 1, '인벤토리');
  const sizes = await page.evaluate(() => {
    const t = (window as unknown as { __ASHEN_TEST__: { app: { content: { items: Map<string, { size: { w: number; h: number } }> } } } }).__ASHEN_TEST__;
    return Object.fromEntries([...t.app.content.items.entries()].map(([id, d]) => [id, d.size]));
  });

  // A real purchase for the compare step: a second pistol (H45) from the mechanic. The starter wallet cannot afford
  // it, so the test tops up credits through the logged debug grant first (disclosed shortcut).
  expect(await api<boolean>(page, 'giveCredits', 3000)).toBe(true);
  await talkTo(page, 'mechanic');
  await page.getByTestId('tab-buy').click();
  await page.getByTestId('buy-core.weapon.h45').click();
  await expect.poll(async () => inStash(await prof(page), 'core.weapon.h45').length).toBe(1);
  await closePanels(page);

  await focusGame(page);
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('panel-stash')).toBeVisible();

  // Filter: "탄약·탄창" dims everything but ammo and magazines; "전체" clears it.
  await page.getByTestId('inv-filter').selectOption('ammo');
  const p0 = await prof(page);
  await expect(page.locator('[data-filtered="out"]').first()).toBeVisible();
  for (const id of p0.store.containers['stash']!.items) {
    const d = p0.store.items[id]!.definitionId;
    const match = d.startsWith('core.ammo.') || d.startsWith('core.mag.');
    expect(await page.locator(`[data-item="${id}"]`).getAttribute('data-filtered'), `${d} filtered state`).toBe(match ? null : 'out');
  }
  await shot(page, testInfo.project.name, 'inv-01-filter');
  await page.getByTestId('inv-filter').selectOption('all');
  await expect(page.locator('[data-filtered="out"]')).toHaveCount(0);

  // Drag the carbine to a free cell, then drag it again rotating with R.
  const carbine = inStash(p0, 'core.weapon.c556')[0]!;
  const cs = sizes['core.weapon.c556']!;
  const dest = freeCell(p0, 'stash', cs.w, cs.h, sizes);
  await drag(page, carbine.instanceId, 'stash', dest);
  await expect.poll(async () => (await prof(page)).store.items[carbine.instanceId]!.gridPosition).toEqual(dest);
  const p1 = await prof(page);
  const rotDest = freeCell(p1, 'stash', cs.h, cs.w, sizes);
  await drag(page, carbine.instanceId, 'stash', rotDest, true);
  await expect.poll(async () => (await prof(page)).store.items[carbine.instanceId]!.rotation).toBe(1);
  expect((await prof(page)).store.items[carbine.instanceId]!.gridPosition).toEqual(rotDest);

  // Split the 45-round 9mm stack from the context menu, then merge it back by dragging onto the other half.
  const nine = inStash(await prof(page), 'core.ammo.9.fmj')[0]!;
  expect(nine.quantity).toBe(45);
  await menu(page, nine.instanceId, '절반 나누기');
  await expect.poll(async () => inStash(await prof(page), 'core.ammo.9.fmj').map((i) => i.quantity).sort((a, b) => a - b)).toEqual([22, 23]);
  const halves = inStash(await prof(page), 'core.ammo.9.fmj');
  const other = halves.find((i) => i.instanceId !== nine.instanceId)!;
  await dragOnto(page, other.instanceId, nine.instanceId);
  await expect.poll(async () => inStash(await prof(page), 'core.ammo.9.fmj').map((i) => i.quantity)).toEqual([45]);

  // Compare: the H45 tooltip compares against the equipped P9 (▲/▼ markers).
  const h45 = inStash(await prof(page), 'core.weapon.h45')[0]!;
  const hb = (await page.locator(`[data-item="${h45.instanceId}"]`).boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await expect(page.locator('.tooltip')).toBeVisible();
  await expect(page.locator('.tooltip')).toContainText(/[▲▼]/);
  await shot(page, testInfo.project.name, 'inv-02-compare');
  await page.mouse.move(5, 5);

  // Equip the carbine with a double-click.
  await page.locator(`[data-item="${carbine.instanceId}"]`).dblclick();
  await expect.poll(async () => (await prof(page)).store.items[carbine.instanceId]!.ownerContainerId).toMatch(/^eq:player:primary[12]$/);

  // Unload a carbine magazine, then fill it again from the loose 5.56 rounds (context menu).
  const mag = inStash(await prof(page), 'core.mag.c556')[0]!;
  const full = mag.mag!.rounds.length;
  expect(full).toBeGreaterThan(0);
  await menu(page, mag.instanceId, '탄창 비우기');
  await expect.poll(async () => (await prof(page)).store.items[mag.instanceId]!.mag!.rounds.length).toBe(0);
  await menu(page, mag.instanceId, /탄창 채우기: 5\.56/);
  await expect.poll(async () => (await prof(page)).store.items[mag.instanceId]!.mag!.rounds.length).toBe(full);

  // Favorite lock: ★, and the menu no longer offers to throw it away.
  const cloth = inStash(await prof(page), 'core.mat.cloth')[0]!;
  await menu(page, cloth.instanceId, '즐겨찾기 잠금');
  await expect.poll(async () => (await prof(page)).store.items[cloth.instanceId]!.lockTags).toContain('favorite');
  await page.locator(`[data-item="${cloth.instanceId}"]`).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '즐겨찾기 해제' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '버리기' })).toHaveCount(0);
  // Close the menu by clicking elsewhere inside the panel (outside clicks dismiss it).
  await page.locator('[data-testid="panel-stash"] .panel-head h2').click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByTestId('panel-stash')).toBeVisible();

  // Stable sort: the favorite stays in its cell, everything else is re-packed from the top-left.
  const favCell = (await prof(page)).store.items[cloth.instanceId]!.gridPosition;
  await page.getByTestId('sort-stash').click();
  await expect.poll(async () => {
    const p = await prof(page);
    return p.store.containers['stash']!.items.slice(0, 1).map((id) => p.store.items[id]!.instanceId);
  }).toEqual([cloth.instanceId]);
  const ps = await prof(page);
  expect(ps.store.items[cloth.instanceId]!.gridPosition).toEqual(favCell);
  await shot(page, testInfo.project.name, 'inv-03-sorted');

  // Quick move (Shift+click) the H45 into the bag.
  await page.locator(`[data-item="${h45.instanceId}"]`).click({ modifiers: ['Shift'] });
  await expect.poll(async () => (await prof(page)).store.items[h45.instanceId]!.ownerContainerId).toMatch(/^bag:/);
  await closePanels(page);

  // Raid: use a bandage on a bleeding wound, then drop a spare magazine on the ground.
  expect(await api<boolean>(page, 'setFlag', 'deploy_allowed')).toBe(true);
  await openStation(page, 32, 2.3, 'panel-deploy');
  await page.getByTestId('deploy-go').click();
  await waitMode(page, 'raid', 30_000);
  await api(page, 'setDebug', { god: true, freezeAI: true });
  expect(await api<boolean>(page, 'setPlayerCondition', 70, true)).toBe(true);
  await focusGame(page);
  await page.keyboard.press('Tab');
  await expect(page.locator('[role="dialog"]')).toBeVisible();
  const carried = await api<{ id: string; def: string; qty: number; container: string }[]>(page, 'carried');
  const band = carried.find((c) => c.def === 'core.med.bandage')!;
  await menu(page, band.id, '사용');
  await expect.poll(async () => (await api<{ bleeding: boolean }>(page, 'player')).bleeding, { timeout: 10_000 }).toBe(false);
  await expect.poll(async () => (await api<{ def: string; qty: number }[]>(page, 'carried')).find((c) => c.def === 'core.med.bandage')?.qty ?? 0).toBe(band.qty - 1);
  const spare = (await api<{ id: string; def: string; container: string }[]>(page, 'carried')).find((c) => c.def === 'core.mag.p9' && c.container.startsWith('bag:'))!;
  await menu(page, spare.id, '버리기 (바닥)');
  await expect.poll(async () => (await api<{ kind: string; itemIds: string[] }[]>(page, 'containers')).some((w) => w.kind === 'drop' && w.itemIds.includes(spare.id))).toBe(true);
  await shot(page, testInfo.project.name, 'inv-04-raid');
  expect(info.errors).toEqual([]);
});
