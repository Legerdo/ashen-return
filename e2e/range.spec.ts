import { expect, test, type Page } from '@playwright/test';
import { aimAt, api, boot, closePanels, fire, openStation, press, shot, skipTutorial, teleport } from './helpers';

/**
 * Stage 1 gate (Combat Vertical Slice): P9, AR556, SG-P and DMR can really be equipped, fired and reloaded at the
 * ShootingRange2D through the real UI and real input (rack panel click, mouse aim, left/right mouse, R key).
 * Hits are read from the simulation shot log (real ballistics against the range dummies); the only hook used is
 * teleport between the rack and the firing line.
 */

interface WeaponState {
  defId: string;
  chamber: string | null;
  magRounds: number | null;
  magCapacity: number | null;
  tube: number | null;
  tubeCapacity: number | null;
  fireMode: string | null;
  action: string | null;
}

interface ShotEntry {
  shotId: string;
  pelletId: number;
  weaponId: string;
  ammoId: string;
  firstHit: string;
  part: string | null;
  actualHPLoss: number;
}

const weapon = (page: Page) => api<WeaponState | null>(page, 'weapon');
const loaded = (w: WeaponState) => (w.chamber ? 1 : 0) + (w.magRounds ?? 0) + (w.tube ?? 0);

async function rent(page: Page, key: string): Promise<void> {
  await openStation(page, 23, 16.0, 'panel-rack');
  await page.getByTestId(`rack-${key}`).click();
  await expect.poll(async () => (await weapon(page))?.defId, { timeout: 5000 }).toBe(`core.weapon.${key}`);
  await closePanels(page);
}

async function waitIdle(page: Page, timeout = 10_000): Promise<void> {
  await expect.poll(async () => (await weapon(page))?.action ?? null, { timeout }).toBeNull();
}

test('@p0 @range Stage 1 gate: P9 / AR556 / SG-P / DMR equip, fire, hit and reload at the range', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const info = await boot(page);
  await page.getByTestId('slot-new-2').click();
  await skipTutorial(page);

  const cases = [
    { key: 'p9', target: { x: 29, y: 17 }, shots: 3, hold: 60, ads: false },
    { key: 'ar556', target: { x: 29, y: 17 }, shots: 1, hold: 350, ads: false }, // automatic burst
    { key: 'sgp', target: { x: 26, y: 17 }, shots: 2, hold: 60, ads: false },
    { key: 'dmr', target: { x: 34, y: 17 }, shots: 3, hold: 60, ads: true },
  ] as const;

  for (const c of cases) {
    await rent(page, c.key);
    const w0 = (await weapon(page))!;
    expect(w0.defId).toBe(`core.weapon.${c.key}`);
    expect(loaded(w0), `${c.key} arrives loaded`).toBeGreaterThan(0);
    await teleport(page, 24.2, 18.6);
    await page.waitForTimeout(250);
    // The range reloads from an unlimited training reserve: nothing to carry, no stamina cost.
    await expect(page.locator('.hud-weapon')).toContainText('훈련 탄약 무제한');
    expect((await api<{ def: string }[]>(page, 'carried')).filter((i) => i.def.startsWith('core.mag.') || i.def.startsWith('core.ammo.')).length, `${c.key}: no spare magazines / loose rounds issued`).toBe(0);
    const log0 = (await api<ShotEntry[]>(page, 'shotLog', 400)).length;
    const before = loaded((await weapon(page))!);
    await aimAt(page, c.target.x, c.target.y, 1.05);
    if (c.ads) {
      await page.mouse.down({ button: 'right' });
      await page.waitForTimeout(700); // stabilise (ADS)
    }
    for (let i = 0; i < c.shots; i++) {
      await page.mouse.down({ button: 'left' });
      await page.waitForTimeout(c.hold);
      await page.mouse.up({ button: 'left' });
      await page.waitForTimeout(c.key === 'sgp' ? 1100 : c.key === 'dmr' ? 450 : 220); // pump / semi cadence
    }
    if (c.ads) await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(400);
    await shot(page, testInfo.project.name, `range-${c.key}-fire`);
    const after = (await weapon(page))!;
    const fired = before - loaded(after);
    expect(fired, `${c.key} consumed rounds`).toBeGreaterThanOrEqual(c.key === 'ar556' ? 2 : c.shots);
    const log = (await api<ShotEntry[]>(page, 'shotLog', 400)).slice(log0);
    expect(log.length, `${c.key} shot log entries`).toBeGreaterThan(0);
    expect(log.every((l) => l.weaponId === `core.weapon.${c.key}`)).toBe(true);
    if (c.key === 'sgp') expect(Math.max(...log.map((l) => l.pelletId))).toBe(7); // 8 pellets per shell
    const hits = log.filter((l) => l.firstHit.startsWith('actor:'));
    expect(hits.length, `${c.key} hit a range dummy (real ballistics)`).toBeGreaterThan(0);
    // Reload with the real R key and let the (tactical / tube) reload finish.
    await press(page, 'KeyR');
    await page.waitForTimeout(300);
    const reloading = await weapon(page);
    expect(reloading!.action, `${c.key} reload started`).not.toBeNull();
    await waitIdle(page, c.key === 'sgp' ? 12_000 : 8000);
    const r = (await weapon(page))!;
    if (r.magCapacity !== null) {
      expect(r.magRounds, `${c.key} fresh magazine inserted`).toBe(r.magCapacity);
      expect(r.chamber).not.toBeNull();
    } else {
      expect(r.tube, `${c.key} tube refilled`).toBe(r.tubeCapacity);
      expect(r.chamber).not.toBeNull();
    }
    await shot(page, testInfo.project.name, `range-${c.key}-reloaded`);
  }

  // Dev/e2e-only debug overlay (F3: hitboxes, aim anchor, shot segments) — captured for visual review; the release
  // build has no toggle (A24 checks the release bundle carries no hook code).
  const overlay = () => page.evaluate(() => (window as unknown as { __ASHEN_TEST__: { app: { settings: { debugOverlay: boolean } } } }).__ASHEN_TEST__.app.settings.debugOverlay);
  await teleport(page, 24.2, 18.6);
  await aimAt(page, 29, 17, 1.05);
  await press(page, 'F3');
  await expect.poll(overlay).toBe(true);
  await fire(page, 60);
  await page.waitForTimeout(120);
  await shot(page, testInfo.project.name, 'range-debug-overlay');
  await press(page, 'F3');
  await expect.poll(overlay).toBe(false);

  // The terminal shows the real shot log (UI read-out of the simulation).
  await openStation(page, 25.5, 16.0, 'panel-terminal');
  await expect(page.getByTestId('panel-terminal')).toContainText('dmr');
  await shot(page, testInfo.project.name, 'range-terminal');
  await closePanels(page);
  const stats = await api<{ reloads: number }>(page, 'rangeStats');
  expect(stats.reloads).toBeGreaterThanOrEqual(3);
  expect(info.errors).toEqual([]);
});
