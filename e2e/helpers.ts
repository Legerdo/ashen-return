import { expect, type Page } from '@playwright/test';

/** Loose typing for the dev/e2e-only test API (window.__ASHEN_TEST__). */
type Api = Record<string, (...args: unknown[]) => unknown>;

export interface BootInfo {
  errors: string[];
}

/** Boot the game page and collect uncaught page errors (console noise is ignored). */
export async function boot(page: Page, path = '/index.html'): Promise<BootInfo> {
  const info: BootInfo = { errors: [] };
  page.on('pageerror', (e) => info.errors.push(String(e.stack ?? e)));
  await page.goto(path);
  await page.waitForFunction(() => (window as unknown as { __BOOTED__?: boolean }).__BOOTED__ === true, null, { timeout: 30_000 });
  return info;
}

/** Call a test API method in the page. Arguments/results must be JSON-serializable. */
export async function api<T = unknown>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return (await page.evaluate(
    async ({ m, a }) => {
      const t = (window as unknown as { __ASHEN_TEST__: Api }).__ASHEN_TEST__;
      if (!t || typeof t[m] !== 'function') throw new Error(`test api missing: ${m}`);
      return await t[m]!(...a);
    },
    { m: method, a: args },
  )) as T;
}

export async function waitMode(page: Page, mode: string, timeout = 20_000): Promise<void> {
  await expect.poll(() => api<string>(page, 'mode'), { timeout, message: `mode → ${mode}` }).toBe(mode);
}

/**
 * A new slot starts in the controls tutorial: skip it with its real HUD button and land in the shelter.
 * (e2e/tutorial.spec.ts plays the course itself with real input.)
 */
export async function skipTutorial(page: Page): Promise<void> {
  await waitMode(page, 'tutorial');
  await page.getByTestId('tutorial-skip').click();
  await waitMode(page, 'base');
  await expect.poll(async () => (await profile(page))?.tutorial ?? null).toEqual({ step: 15, done: true, skipped: true });
}

/** New slot N → (skip tutorial) → shelter. */
export async function newSlot(page: Page, slot: number, name: string): Promise<void> {
  await page.getByTestId(`slot-name-${slot}`).fill(name);
  await page.getByTestId(`slot-new-${slot}`).click();
  await skipTutorial(page);
}

export interface ProfileLite {
  currency: number;
  level: number;
  exp: number;
  flags: Record<string, boolean>;
  quests: Record<string, { status: string; progress: Record<string, number> }>;
  perks: string[];
  perkPoints: number;
  buildings: { buildingId: string; guid: string; x: number; y: number }[];
  facilities: Record<string, number>;
  notes: Record<string, { found: boolean; read: boolean }>;
  keys: { registered: string[] };
  market: { generation: number; offers: { offerId: string; itemId: string; qty: number; price: number }[] };
  generation: number;
  chapter: { act: number; completed: boolean; epilogueSeen: boolean };
  activeRaid: { raidId: string } | null;
  store: { items: Record<string, { definitionId: string; quantity: number; ownerContainerId: string | null }>; containers: Record<string, { items: string[] }> };
  traders: Record<string, { trust: number }>;
  contracts: { offers: { id: string; templateId: string; status: string; progress: number }[]; completed: string[] };
  stats: { raids: number; extractions: number; deaths: number; kills: number };
  lastDeathBag: unknown;
  tutorial: { step: number; done: boolean; skipped: boolean };
}

export const profile = (page: Page) => api<ProfileLite | null>(page, 'profile');

export async function questStatus(page: Page, id: string): Promise<string | undefined> {
  const p = await profile(page);
  return p?.quests[id]?.status;
}

/** Item definition counts across every profile-owned item (for conservation checks). */
export function defCounts(p: ProfileLite): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of Object.values(p.store.items)) out[it.definitionId] = (out[it.definitionId] ?? 0) + it.quantity;
  return out;
}

export async function teleport(page: Page, x: number, y: number): Promise<void> {
  expect(await api<boolean>(page, 'teleport', x, y)).toBe(true);
  await page.waitForTimeout(120);
}

/** Give keyboard focus to the game frame without clicking (a click would fire the weapon). */
export async function focusGame(page: Page): Promise<void> {
  await page.evaluate(() => (document.getElementById('game-frame') as HTMLElement).focus({ preventScroll: true }));
}

export async function press(page: Page, code: string, holdMs = 60): Promise<void> {
  await focusGame(page);
  await page.keyboard.down(code);
  await page.waitForTimeout(holdMs);
  await page.keyboard.up(code);
  await page.waitForTimeout(60);
}

/** Move the real mouse onto a world point; iterate because the camera leads toward the cursor. */
export async function aimAt(page: Page, x: number, y: number, z = 1.0): Promise<{ x: number; y: number }> {
  let c = { x: 0, y: 0 };
  for (let i = 0; i < 8; i++) {
    c = await api<{ x: number; y: number }>(page, 'worldToClient', x, y, z);
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(90);
  }
  return c;
}

/** Hold the fire button for ms (real pointer input). */
export async function fire(page: Page, ms = 80): Promise<void> {
  await page.mouse.down({ button: 'left' });
  await page.waitForTimeout(ms);
  await page.mouse.up({ button: 'left' });
}

export async function closePanels(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const panel = await api<unknown>(page, 'panel');
    if (!panel) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
}

/** Evidence screenshot: test-results/screens/<project>-<name>.png */
export async function shot(page: Page, project: string, name: string): Promise<void> {
  await page.screenshot({ path: `test-results/screens/${project}-${name}.png` });
}

export async function talkTo(page: Page, npc: 'mechanic' | 'medic' | 'comms'): Promise<void> {
  const spots = { mechanic: [7.5, 4.9], medic: [17.5, 4.9], comms: [45.5, 4.9] } as const;
  await closePanels(page);
  await teleport(page, spots[npc][0], spots[npc][1]);
  await press(page, 'KeyE');
  await expect(page.getByTestId(`panel-npc-core.npc.${npc}`)).toBeVisible();
}

export async function openStation(page: Page, x: number, y: number, testid: string): Promise<void> {
  await closePanels(page);
  await teleport(page, x, y);
  await press(page, 'KeyE');
  await expect(page.getByTestId(testid)).toBeVisible();
}
