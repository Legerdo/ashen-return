import { expect, test, type Page } from '@playwright/test';
import { aimAt, api, boot, defCounts, focusGame, profile, shot, teleport, waitMode } from './helpers';

/**
 * First-run controls tutorial, played through with real input (Chromium + Firefox): every lesson is completed with
 * the real keys / mouse (WASD, Shift, Space, C, E, Tab, left / right click, R, V, G, 4, M) and the course ends with a real
 * 5 s extraction into the shelter. Hooks only read state (player / tutorial / containers / toasts / profile), map
 * world points to the screen for the mouse, slow the clock for the melee-arc screenshot, and teleport once to the
 * shooting bench (disclosed). Nothing in the course touches the profile economy.
 */

interface Tut {
  step: number;
  id: string | null;
  progress: number;
  finished: boolean;
  target: { key: string; x: number; y: number } | null;
}
interface Pl {
  x: number;
  y: number;
  stance: string;
  action: string | null;
  bleeding: boolean;
  hp: number;
  stamina: number;
  staminaMax: number;
}

const tut = (page: Page) => api<Tut | null>(page, 'tutorial');
const player = (page: Page) => api<Pl>(page, 'player');
const WALK_UPS = 3;

async function lesson(page: Page, id: string, timeout = 8000): Promise<void> {
  await expect.poll(async () => (await tut(page))?.id ?? 'done', { timeout, message: `lesson → ${id}` }).toBe(id);
  await expect(page.getByTestId('tutorial-box')).toHaveAttribute('data-step', id);
}

async function tap(page: Page, code: string, holdMs = 70): Promise<void> {
  await focusGame(page);
  await page.keyboard.down(code);
  await page.waitForTimeout(holdMs);
  await page.keyboard.up(code);
  await page.waitForTimeout(80);
}

/** Walk with the real movement keys: one axis at a time, key held for the time the distance needs, re-measured. */
async function walkTo(page: Page, x: number, y: number, tol = 0.35): Promise<void> {
  await focusGame(page);
  for (let i = 0; i < 16; i++) {
    const p = await player(page);
    const dx = x - p.x;
    const dy = y - p.y;
    if (Math.abs(dx) <= tol && Math.abs(dy) <= tol) return;
    const horizontal = Math.abs(dx) > tol && (Math.abs(dx) >= Math.abs(dy) || Math.abs(dy) <= tol);
    const d = horizontal ? dx : dy;
    const key = horizontal ? (d > 0 ? 'KeyD' : 'KeyA') : d > 0 ? 'KeyS' : 'KeyW';
    const ms = Math.max(40, Math.min(2500, (Math.abs(d) / WALK_UPS) * 1000 * (Math.abs(d) > 1 ? 0.92 : 0.8)));
    await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    await page.keyboard.up(key);
    await page.waitForTimeout(90);
  }
  const p = await player(page);
  expect(Math.hypot(p.x - x, p.y - y), `walked to (${x}, ${y}); at (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`).toBeLessThan(0.8);
}

async function waitIdle(page: Page, timeout = 8000): Promise<void> {
  await expect.poll(async () => (await player(page)).action, { timeout }).toBeNull();
}

test('@p0 @tutorial first-run controls course with real input: 15 lessons → extraction → shelter', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const info = await boot(page);
  const snap = (n: string) => shot(page, testInfo.project.name, `tutorial-${n}`);
  await page.getByTestId('slot-name-1').fill('훈련병');
  await page.getByTestId('slot-new-1').click();
  await waitMode(page, 'tutorial');
  const start = (await profile(page))!;
  expect(start.tutorial).toEqual({ step: 0, done: false, skipped: false });
  const box = page.getByTestId('tutorial-box');
  await expect(box).toContainText('기초 훈련 1 / 15');
  await expect(box).not.toContainText('⟦');
  await expect(page.getByTestId('hud-keys')).toContainText('장전');
  await expect(page.locator('[data-guide="tut:move"]:visible')).toHaveCount(1);
  await page.mouse.move(640, 360);
  await page.waitForTimeout(300);
  await snap('01-move');

  // 1 move (WASD) → the marked spot.
  await lesson(page, 'move');
  const spot = (await tut(page))!.target!;
  await walkTo(page, spot.x, spot.y, 0.4);
  await lesson(page, 'sprint');
  expect((await profile(page))!.tutorial.step, 'lesson progress is saved').toBeGreaterThanOrEqual(1);

  // 2 sprint (Shift + W): stamina never drains in the training area.
  await focusGame(page);
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1200);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');
  await lesson(page, 'dodge');
  const ps = await player(page);
  expect(ps.stamina).toBe(ps.staminaMax);

  // 2b dodge roll (Space) twice, toward the aim: east, then back west. The clock is slowed once to photograph the tumble.
  await expect(box).toContainText('Space');
  const r0 = await player(page);
  await aimAt(page, r0.x + 4, r0.y, 1);
  await api(page, 'timeScale', 0.25);
  await tap(page, 'Space');
  // ~35 % into the 0.42 s roll (0.6 s real at ×0.25).
  await page.waitForTimeout(520);
  await snap('01b-dodge');
  await api(page, 'timeScale', 1);
  await expect.poll(async () => (await tut(page))?.progress ?? -1).toBe(1);
  await waitIdle(page);
  const r1 = await player(page);
  expect(r1.x - r0.x, 'rolled ~3u east').toBeGreaterThan(2.4);
  await page.waitForTimeout(500); // recovery before the next roll
  await aimAt(page, r1.x - 4, r1.y, 1);
  await tap(page, 'Space');
  await lesson(page, 'crouch');
  await waitIdle(page);
  expect((await player(page)).stamina, 'rolls are free in the training area').toBe(ps.staminaMax);

  // 3 crouch (C), then stand up again.
  await tap(page, 'KeyC');
  await lesson(page, 'door');
  await tap(page, 'KeyC');
  await expect.poll(async () => (await player(page)).stance).toBe('stand');

  // 4 open the door (E).
  await expect(page.locator('[data-guide="tut:door"]:visible')).toHaveCount(1);
  await walkTo(page, 9, 11);
  await walkTo(page, 13.2, 11);
  await aimAt(page, 15, 11, 1);
  await tap(page, 'KeyE');
  await lesson(page, 'loot');

  // 5 search the crate (E) and take everything.
  await walkTo(page, 16.5, 11);
  await walkTo(page, 16.5, 7.3);
  await walkTo(page, 20, 7.3);
  await expect(page.locator('[data-guide="tut:crate"]:visible')).toHaveCount(1);
  await aimAt(page, 20, 6, 0.5);
  await tap(page, 'KeyE');
  await expect(page.getByTestId('panel-loot')).toBeVisible();
  await expect.poll(async () => (await api<{ id: string; searched: number }[]>(page, 'containers')).find((c) => c.id === 'ct:tut_crate')!.searched, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
  await snap('02-loot');
  await page.getByTestId('take-all').click();
  await lesson(page, 'inventory');
  await expect(page.getByTestId('panel-loot')).toBeHidden();
  const carried = await api<{ def: string }[]>(page, 'carried');
  expect(carried.map((c) => c.def)).toEqual(expect.arrayContaining(['core.med.bandage', 'core.throw.smoke']));

  // 6 open the bag (Tab), close it again (Tab).
  await tap(page, 'Tab');
  await lesson(page, 'shoot');
  await expect.poll(() => api<{ name: string } | null>(page, 'panel')).toMatchObject({ name: 'inventory' });
  await tap(page, 'Tab');
  await expect.poll(() => api<unknown>(page, 'panel')).toBeNull();

  // 7 fire (left click) at the near target until three hits land. Teleport to the bench (disclosed shortcut).
  await teleport(page, 28.6, 9.6);
  const near = (await tut(page))!.target!;
  await expect(page.locator(`[data-guide="${near.key}"]:visible`)).toHaveCount(1);
  for (let i = 0; i < 16 && (await tut(page))!.id === 'shoot'; i++) {
    await aimAt(page, near.x, near.y, 1.05);
    await page.mouse.down({ button: 'left' });
    await page.waitForTimeout(60);
    await page.mouse.up({ button: 'left' });
    await page.waitForTimeout(260);
  }
  await snap('03-shoot');
  await lesson(page, 'ads');

  // 8 aimed fire (hold right click) at the far target.
  const far = (await tut(page))!.target!;
  for (let i = 0; i < 20 && (await tut(page))!.id === 'ads'; i++) {
    const w = await api<{ chamber: string | null; magRounds: number | null }>(page, 'weapon');
    if (!w.chamber) {
      await tap(page, 'KeyR');
      await waitIdle(page);
    }
    await aimAt(page, far.x, far.y, 1.1);
    await page.mouse.down({ button: 'right' });
    await page.waitForTimeout(750);
    await page.mouse.down({ button: 'left' });
    await page.waitForTimeout(60);
    await page.mouse.up({ button: 'left' });
    await page.waitForTimeout(250);
    if (i === 0) await snap('04-ads');
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(100);
  }
  await lesson(page, 'reload');

  // 9 reload (R): a whole fresh magazine from the training reserve, in one go.
  await waitIdle(page);
  await tap(page, 'KeyR');
  await expect.poll(async () => (await player(page)).action).toBe('reload');
  await lesson(page, 'melee', 6000);
  await waitIdle(page);
  const w = await api<{ magRounds: number; magCapacity: number; chamber: string | null }>(page, 'weapon');
  expect(w.magRounds).toBe(w.magCapacity);
  await expect(page.locator('.hud-weapon')).toContainText('훈련 탄약 무제한');

  // 10 melee (V) on the close target; the clock is slowed only to photograph the swing arc and hit flash.
  const mel = (await tut(page))!.target!;
  await walkTo(page, 28.6, 15);
  await walkTo(page, mel.x - 0.8, 15);
  await aimAt(page, mel.x, mel.y, 1);
  await api(page, 'timeScale', 0.25);
  await tap(page, 'KeyV');
  // Knife strike at 40 % of its 0.5 s cycle (0.8 s real at ×0.25) + half of the arc's sweep.
  await page.waitForTimeout(1050);
  await snap('05-melee');
  await lesson(page, 'throw', 8000);
  await api(page, 'timeScale', 1);

  // 11 throw (hold G to see the arc, release to throw) at the marked spot.
  await walkTo(page, mel.x - 0.8, 16.6);
  await walkTo(page, 36, 16.6);
  const tspot = (await tut(page))!.target!;
  await waitIdle(page);
  await aimAt(page, tspot.x, tspot.y, 0);
  await focusGame(page);
  await page.keyboard.down('KeyG');
  await page.waitForTimeout(500);
  await snap('06-throw-preview');
  await page.keyboard.up('KeyG');
  await lesson(page, 'heal', 8000);

  // 12 heal: the lesson starts a bleed; the bandage on quickslot 4 (auto-assigned from the crate) stops it.
  const hurt = await player(page);
  expect(hurt.bleeding).toBe(true);
  await waitIdle(page);
  await tap(page, 'Digit4');
  await expect.poll(async () => (await player(page)).action).toBe('heal');
  await lesson(page, 'map', 8000);
  expect((await player(page)).bleeding).toBe(false);

  // 13 map (M), close it again (M).
  await tap(page, 'KeyM');
  await lesson(page, 'extract');
  await expect(page.getByTestId('panel-map')).toBeVisible();
  await tap(page, 'KeyM');
  await expect.poll(() => api<unknown>(page, 'panel')).toBeNull();

  // The pause menu offers skipping; resume instead.
  await tap(page, 'Escape');
  await expect(page.getByTestId('pause-skip-tutorial')).toBeVisible();
  await page.getByTestId('resume').click();
  await expect(page.getByTestId('panel-pause')).toBeHidden();

  // 14 extraction: walk into the green zone and hold for 5 s.
  await expect(page.locator('[data-guide="tut:exit"]:visible')).toHaveCount(1);
  await walkTo(page, 51.8, 16.6);
  const t0 = Date.now();
  await waitMode(page, 'base', 15_000);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(3500);
  await expect.poll(async () => (await api<string[]>(page, 'toasts')).some((t) => t.includes('기초 훈련 완료'))).toBe(true);
  const end = (await profile(page))!;
  expect(end.tutorial).toEqual({ step: 15, done: true, skipped: false });
  expect(end.activeRaid, 'the course never creates a raid record').toBeNull();
  expect(defCounts(end), 'training gear never touches the profile items').toEqual(defCounts(start));
  expect(end.currency).toBe(start.currency);
  await page.waitForTimeout(500);
  await snap('07-shelter');
  expect(info.errors).toEqual([]);
});
