import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { aimAt, api, boot, closePanels, defCounts, fire, focusGame, openStation, press, profile, questStatus, shot, skipTutorial, talkTo, teleport, waitMode, type ProfileLite } from './helpers';

/**
 * A23 — full Chapter 1 play-through on the production e2e bundle (Chromium):
 * new slot → onboarding (Q01) → first haul (Q02) → level up → Q03 (outer route unlocked, survived) → different
 * time/weather → perk → crafting & construction (Q06) → power & comms restored (Q07) → black market (+ contract when
 * offered) → facility upgrade → commander killed → cipher module extracted & delivered (Q08) → epilogue → free roam on
 * both maps → browser reload → perks / buildings / market / notes / keys / progress restored.
 *
 * Real UI and input: NPC dialogs, deliveries and turn-ins, trader buys, crafting, building placement on the grid,
 * the generator, black market, perk unlock, key registration, E interaction, mouse aim + fire, 5 s extraction.
 * Disclosed test-hook shortcuts: teleport between far points, player invulnerability + frozen enemy AI during raids
 * (deterministic), and — only if the seeded loot comes up short — a logged material/credit grant (annotated).
 */

type Api<T> = Promise<T>;
interface Cont {
  id: string;
  kind: string;
  typeId: string;
  x: number;
  y: number;
  locked: boolean;
  searched: number;
  items: string[];
  itemIds: string[];
}
interface Summary {
  outcome: string;
  itemsIn: { defId: string; qty: number }[];
}

const containers = (page: Page): Api<Cont[]> => api<Cont[]>(page, 'containers');
const MATS = ['core.mat.scrap', 'core.mat.part', 'core.mat.wire'];

function note(testInfo: TestInfo, type: string, description: string): void {
  testInfo.annotations.push({ type, description });
  console.log(`[P1] ${type}: ${description}`);
}

async function home(page: Page, defId: string): Promise<number> {
  const p = (await profile(page))!;
  const ids = ['stash', 'incoming', 'shelf'].flatMap((c) => p.store.containers[c]?.items ?? []);
  return ids.reduce((s, id) => s + (p.store.items[id]?.definitionId === defId ? p.store.items[id]!.quantity : 0), 0);
}

async function deploy(page: Page, destId: string, envs: Set<string>): Promise<void> {
  await openStation(page, 32, 2.3, 'panel-deploy');
  await page.getByTestId(`dest-${destId}`).click();
  await page.getByTestId('deploy-go').click();
  await waitMode(page, 'raid', 30_000);
  await api(page, 'setDebug', { god: true, freezeAI: true });
  const s = await api<{ env: { phase: string; weather: string }; mapId: string }>(page, 'sim');
  envs.add(`${s.env.phase}/${s.env.weather}`);
  await page.waitForTimeout(300);
}

/** Stand next to a container, face it, press E; retry other spots if another target wins. */
async function openContainer(page: Page, c: Cont): Promise<boolean> {
  const spots = await api<{ x: number; y: number }[]>(page, 'reachSpots', c.x, c.y, 8);
  for (const s of spots) {
    await closePanels(page);
    await teleport(page, s.x, s.y);
    await aimAt(page, c.x, c.y, 0.6);
    await press(page, 'KeyE');
    await page.waitForTimeout(150);
    const sim = await api<{ loot: { containerId: string } | null }>(page, 'sim');
    if (sim.loot?.containerId === c.id) return true;
  }
  return false;
}

async function takeAll(page: Page, c: Cont): Promise<string[]> {
  if (!(await openContainer(page, c))) return [];
  await expect(page.getByTestId('panel-loot')).toBeVisible();
  await expect.poll(async () => (await containers(page)).find((x) => x.id === c.id)!.searched, { timeout: 20_000 }).toBeGreaterThanOrEqual(c.items.length);
  const before = (await api<{ def: string }[]>(page, 'carried')).map((i) => i.def);
  await page.getByTestId('take-all').click();
  await page.waitForTimeout(250);
  const after = (await api<{ def: string }[]>(page, 'carried')).map((i) => i.def);
  await closePanels(page);
  const taken = [...after];
  for (const d of before) taken.splice(taken.indexOf(d), 1);
  return taken;
}

/** Loot world containers holding any of `defs`, nearest to (x, y) first. */
async function lootFor(page: Page, defs: string[], x: number, y: number, max: number): Promise<string[]> {
  const got: string[] = [];
  const list = (await containers(page)).filter((c) => c.kind === 'world' && !c.locked && c.items.some((d) => defs.includes(d))).sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
  for (const c of list.slice(0, max)) got.push(...(await takeAll(page, c)));
  return got;
}

async function extract(page: Page, exitId: string): Promise<Summary> {
  await closePanels(page);
  const exits = await api<{ id: string; x: number; y: number; w: number; h: number; enabled: boolean }[]>(page, 'exits');
  const ex = exits.find((e) => e.id === exitId)!;
  expect(ex.enabled, `${exitId} enabled`).toBe(true);
  await teleport(page, ex.x + ex.w / 2, ex.y + ex.h / 2);
  await waitMode(page, 'summary', 25_000);
  const s = (await api<Summary>(page, 'summary'))!;
  expect(s.outcome).toBe('extracted');
  await page.getByTestId('summary-continue').click();
  await waitMode(page, 'base');
  return s;
}

async function turnIn(page: Page, npc: 'mechanic' | 'medic' | 'comms', qid: string): Promise<void> {
  await talkTo(page, npc);
  await page.getByTestId(`turnin-${qid}`).click();
  await expect.poll(() => questStatus(page, qid), { timeout: 10_000 }).toBe('completed');
  await page.waitForTimeout(300);
  await closePanels(page);
}

async function deliver(page: Page, npc: 'mechanic' | 'medic' | 'comms', qid: string): Promise<void> {
  await talkTo(page, npc);
  await page.getByTestId(`deliver-${qid}`).click();
  await page.waitForTimeout(400);
  await closePanels(page);
}

/** Only if the seeded loot was not enough: top up through a logged debug grant (annotated in the report). */
async function topUp(page: Page, testInfo: TestInfo, defId: string, need: number): Promise<void> {
  const have = await home(page, defId);
  if (have >= need) return;
  note(testInfo, 'debug-grant', `${defId} ×${need - have} (had ${have}, needed ${need})`);
  expect(await api<boolean>(page, 'giveProfile', defId, need - have)).toBe(true);
}

/** Real trader purchases through the buy tab; stops early when the line is locked, sold out or unaffordable. */
async function buyFrom(page: Page, testInfo: TestInfo, npc: 'mechanic' | 'medic' | 'comms', itemId: string, times: number): Promise<number> {
  await talkTo(page, npc);
  await page.getByTestId('tab-buy').click();
  let bought = 0;
  for (let i = 0; i < times; i++) {
    const b = page.getByTestId(`buy-${itemId}`);
    if ((await b.count()) === 0 || (await b.isDisabled())) break;
    const before = await home(page, itemId);
    await b.click();
    await expect.poll(() => home(page, itemId)).toBeGreaterThan(before);
    bought++;
  }
  note(testInfo, 'purchase', `${itemId} ×${bought} from ${npc} (wanted ${times})`);
  await closePanels(page);
  return bought;
}

async function craft(page: Page, recipeId: string, output: string): Promise<void> {
  const before = await home(page, output);
  await openStation(page, 9.5, 4.9, 'panel-craft-workbench');
  await page.getByTestId(`craft-${recipeId}`).click();
  await closePanels(page);
  await expect.poll(() => home(page, output), { timeout: 20_000 }).toBeGreaterThan(before);
}

async function build(page: Page, buildingId: string, x: number, y: number): Promise<void> {
  await openStation(page, 3.5, 15.9, 'panel-build');
  await page.getByTestId(`build-${buildingId}`).click();
  await page.locator(`.build-cell[data-bx="${x}"][data-by="${y}"]`).click();
  await expect.poll(async () => (await profile(page))!.buildings.some((b) => b.buildingId === buildingId), { timeout: 10_000 }).toBe(true);
  await waitMode(page, 'base');
  await closePanels(page);
}

// Fail fast on a missing button instead of burning the whole play-through budget. Tracing is off for this file:
// recording the thousands of scripted actions of a full play-through stalled the context teardown for >15 min
// (the same run passes in ~3 min untraced). Failures still leave a screenshot, error-context.md and the phase log.
test.use({ actionTimeout: 30_000, trace: 'off' });

test('@p1 new profile → Chapter 1 ending → free roam on both maps → reload restore', async ({ page }, testInfo) => {
  test.setTimeout(1_200_000);
  const info = await boot(page);
  const snap = (n: string) => shot(page, testInfo.project.name, `p1-${n}`);
  const envs = new Set<string>();
  const t0 = Date.now();
  const phase = (name: string) => console.log(`[P1] +${Math.round((Date.now() - t0) / 1000)}s ${name}`);

  // --- onboarding: Q01 -------------------------------------------------------------------------------------------
  phase('Q01 onboarding');
  await page.getByTestId('slot-name-3').fill('챕터 완주');
  await page.getByTestId('slot-new-3').click();
  await skipTutorial(page);
  await focusGame(page);
  await page.mouse.move(640, 520);
  await talkTo(page, 'mechanic');
  await closePanels(page);
  await teleport(page, 24, 18);
  await aimAt(page, 29, 17, 1.2);
  await fire(page);
  await page.waitForTimeout(300);
  await press(page, 'KeyR');
  await expect.poll(() => questStatus(page, 'core.quest.q01_ready'), { timeout: 10_000 }).toBe('ready');
  await turnIn(page, 'mechanic', 'core.quest.q01_ready');

  // Accept a recon contract when one is offered (completed in the Q03 raid); the black market covers the requirement otherwise.
  await openStation(page, 38.5, 3.2, 'panel-board');
  const offers = (await profile(page))!.contracts.offers;
  const recon = offers.find((o) => o.templateId === 'core.contract.recon' && o.status === 'offered');
  note(testInfo, 'contract-offers', offers.map((o) => o.templateId).join(', '));
  if (recon) {
    await page.getByTestId(`ct-accept-${recon.templateId}`).click();
    await expect.poll(async () => (await profile(page))!.contracts.offers.find((o) => o.id === recon.id)?.status).toBe('active');
  }
  await closePanels(page);

  // --- raid 1 (main): Q02 relief package, a note, the farm back-room key, materials -----------------------------
  phase('raid 1 (Q02)');
  await deploy(page, 'core.dest.quarantine_main', envs);
  await snap('01-raid1');
  const relief = (await containers(page)).find((c) => c.items.includes('core.quest.relief_package'))!;
  expect(relief).toBeTruthy();
  expect(await takeAll(page, relief)).toContain('core.quest.relief_package');
  // Note: the farm diary (discovered state is kept per note).
  const noteSpots = await api<{ x: number; y: number }[]>(page, 'reachSpots', 14, 64.4, 6);
  let noteRead = false;
  for (const s of noteSpots) {
    await teleport(page, s.x, s.y);
    await aimAt(page, 14, 64.4, 0.9);
    await press(page, 'KeyE');
    if (await page.getByTestId('panel-note').isVisible().catch(() => false)) {
      noteRead = true;
      await snap('02-note');
      break;
    }
    await closePanels(page);
  }
  expect(noteRead, 'farm diary opened').toBe(true);
  await closePanels(page);
  const keyBox = (await containers(page)).find((c) => c.items.includes('core.keyitem.farm_backroom'));
  if (keyBox) expect(await takeAll(page, keyBox)).toContain('core.keyitem.farm_backroom');
  await lootFor(page, MATS, 30, 70, 6);
  const s1 = await extract(page, 'exit.west_drain');
  expect(s1.itemsIn.some((i) => i.defId === 'core.quest.relief_package')).toBe(true);
  await deliver(page, 'medic', 'core.quest.q02_first_haul');
  await turnIn(page, 'medic', 'core.quest.q02_first_haul');
  expect((await profile(page))!.level, 'level up after the first haul').toBeGreaterThanOrEqual(2);
  expect(await questStatus(page, 'core.quest.q03_remember_road')).toBe('active');

  // Register the key at the comms officer (access right; item consumed once).
  if (keyBox) {
    await talkTo(page, 'comms');
    await page.getByTestId('tab-special').click();
    await page.getByTestId('register-core.key.farm_backroom').click();
    await expect.poll(async () => (await profile(page))!.keys.registered).toContain('core.key.farm_backroom');
    await closePanels(page);
  }

  // Perk: spend the level-up point through the growth tab (Tab → 성장).
  await focusGame(page);
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('panel-stash')).toBeVisible();
  await page.getByTestId('tab-perks').click();
  const perkBtn = page.locator('[data-testid^="perk-core.perk."]:not([disabled])').first();
  const perkId = (await perkBtn.getAttribute('data-testid'))!.replace('perk-', '');
  await perkBtn.click();
  await expect.poll(async () => (await profile(page))!.perks).toContain(perkId);
  await snap('03-perk');
  await closePanels(page);

  // --- raid 2 (main): Q03 landmarks, recon contract POI, materials ------------------------------------------------
  phase('raid 2 (Q03)');
  await deploy(page, 'core.dest.quarantine_main', envs);
  await teleport(page, 34, 80);
  await page.waitForTimeout(300);
  await teleport(page, 50, 38);
  await page.waitForTimeout(300);
  if (recon) {
    const c = (await profile(page))!.contracts.offers.find((o) => o.id === recon.id);
    const pois = await api<{ id: string; x: number; y: number }[]>(page, 'pois');
    const target = pois.find((poi) => (c as unknown as { objective: { target: string } } | undefined)?.objective.target === poi.id);
    if (target) {
      await teleport(page, target.x, target.y);
      await page.waitForTimeout(300);
    }
  }
  const visited = (await api<{ progress: { visited: string[] } }>(page, 'sim')).progress.visited;
  expect(visited).toEqual(expect.arrayContaining(['poi.water_tower', 'poi.red_pump']));
  await lootFor(page, MATS, 60, 40, 6);
  await extract(page, 'exit.west_drain');
  await turnIn(page, 'comms', 'core.quest.q03_remember_road');
  expect((await profile(page))!.flags['outer_route_unlocked']).toBe(true);
  if (recon) {
    const c = (await profile(page))!.contracts.offers.find((o) => o.id === recon.id);
    note(testInfo, 'contract', `recon ${recon.id} status after raid 2: ${c?.status ?? 'gone'}`);
    expect(c?.status, 'recon contract ready after visiting its POI and extracting').toBe('ready');
    await openStation(page, 38.5, 3.2, 'panel-board');
    await page.getByTestId(`ct-done-${recon.templateId}`).click();
    await expect.poll(async () => (await profile(page))!.contracts.completed).toContain(recon.id);
    note(testInfo, 'contract', `recon contract ${recon.id} completed through the board`);
    await closePanels(page);
  }

  // --- raid 3 (outer supply route): unlocked by Q03, survive it, materials -----------------------------------------
  phase('raid 3 (outer route)');
  await deploy(page, 'core.dest.outer_supply_route', envs);
  await snap('04-outer');
  await lootFor(page, MATS, 30, 55, 6);
  await extract(page, 'exit.rail_tunnel');

  // --- Q06: scrap & part delivery, first craft, workbench module --------------------------------------------------
  phase('Q06 craft & build');
  await topUp(page, testInfo, 'core.mat.scrap', 7);
  await topUp(page, testInfo, 'core.mat.part', 2);
  await deliver(page, 'mechanic', 'core.quest.q06_scrap');
  await craft(page, 'core.recipe.repair_kit', 'core.tool.repair_kit');
  await expect.poll(() => questStatus(page, 'core.quest.q06_scrap'), { timeout: 10_000 }).toBe('ready');
  await turnIn(page, 'mechanic', 'core.quest.q06_scrap');
  await build(page, 'core.building.workbench_module', 12, 20);
  await snap('05-workbench');

  // --- raid 4 (main): Q07 power unit from the pump room ----------------------------------------------------------
  phase('raid 4 (Q07 power unit)');
  await deploy(page, 'core.dest.quarantine_main', envs);
  const pumpCrate = (await containers(page)).find((c) => c.items.includes('core.mat.power_unit'));
  expect(pumpCrate, 'power unit placed while Q07 is active').toBeTruthy();
  expect(await takeAll(page, pumpCrate!)).toContain('core.mat.power_unit');
  await lootFor(page, MATS, 60, 36, 5);
  await extract(page, 'exit.west_drain');
  expect(await home(page, 'core.mat.power_unit')).toBeGreaterThanOrEqual(1);

  // Wire from the comms officer (real purchases), parts from the mechanic (trust unlocked by Q06) or loot.
  phase('Q07 relay, power module, generator');
  const wireNeed = 4 - (await home(page, 'core.mat.wire'));
  if (wireNeed > 0) await buyFrom(page, testInfo, 'comms', 'core.mat.wire', wireNeed);
  const partNeed = 2 - (await home(page, 'core.mat.part'));
  if (partNeed > 0) await buyFrom(page, testInfo, 'mechanic', 'core.mat.part', partNeed);
  await topUp(page, testInfo, 'core.mat.wire', 4);
  await topUp(page, testInfo, 'core.mat.part', 2);
  await topUp(page, testInfo, 'core.mat.scrap', 4);
  await craft(page, 'core.recipe.relay_module', 'core.quest.relay_module');
  if ((await profile(page))!.currency < 1200) {
    note(testInfo, 'debug-grant', `credits for the power & comms module (had ${(await profile(page))!.currency})`);
    await api(page, 'giveCredits', 1200 - (await profile(page))!.currency);
  }
  await build(page, 'core.building.power_comms', 12, 24);
  await openStation(page, 57.2, 8.9, 'panel-generator');
  await page.getByTestId('generator-restore').click();
  await expect.poll(async () => (await profile(page))!.flags['generator_restored']).toBe(true);
  await closePanels(page);
  await turnIn(page, 'comms', 'core.quest.q07_restore_power');
  await waitMode(page, 'base');
  const powered = (await profile(page))!;
  expect(powered.flags['power_restored']).toBe(true);
  expect(powered.flags['black_market_unlocked']).toBe(true);
  await snap('06-power');

  // --- black market purchase (deterministic offers) + final facility ------------------------------------------------
  phase('black market & facility');
  const market0 = (await profile(page))!.market;
  expect(market0.offers.length, 'black market offers generated').toBeGreaterThan(0);
  // Upper bound of one purchase click (ammo sells a stack of up to the remaining qty, everything else one unit).
  const cheapest = Math.min(...market0.offers.filter((o) => o.qty > 0).map((o) => o.price * (o.itemId.includes('.ammo.') ? o.qty : 1)));
  if ((await profile(page))!.currency < cheapest) {
    note(testInfo, 'debug-grant', `credits for one black-market purchase (had ${(await profile(page))!.currency}, cheapest ${cheapest})`);
    await api(page, 'giveCredits', cheapest - (await profile(page))!.currency);
  }
  await openStation(page, 48, 4.9, 'panel-market');
  const bmBtn = page.locator('[data-testid^="bm-"]:not([disabled])').first();
  await expect(bmBtn).toBeVisible();
  const cur0 = (await profile(page))!.currency;
  await bmBtn.click();
  await expect.poll(async () => (await profile(page))!.currency).toBeLessThan(cur0);
  await snap('07-market');
  const marketAfterBuy = (await profile(page))!.market;
  expect(marketAfterBuy.offers.map((o) => o.offerId)).toEqual(market0.offers.map((o) => o.offerId));
  await closePanels(page);
  // Re-opening the radio must not re-roll the offers.
  await openStation(page, 48, 4.9, 'panel-market');
  expect((await profile(page))!.market).toEqual(marketAfterBuy);
  await closePanels(page);
  const facilityCost = 2000;
  if ((await profile(page))!.currency < facilityCost) {
    note(testInfo, 'debug-grant', `credits for the workbench facility (had ${(await profile(page))!.currency})`);
    await api(page, 'giveCredits', facilityCost - (await profile(page))!.currency);
  }
  await openStation(page, 3.5, 15.9, 'panel-build');
  await page.getByTestId('facility-core.facility.workbench').click();
  await expect.poll(async () => (await profile(page))!.facilities['core.facility.workbench'] ?? 0).toBe(1);
  await closePanels(page);

  // --- raid 5 (main): the commander, the cipher module, extraction -------------------------------------------------
  phase('raid 5 (Q08 commander)');
  expect(await questStatus(page, 'core.quest.q08_last_signal')).toBe('active');
  await deploy(page, 'core.dest.quarantine_main', envs);
  await api(page, 'setDebug', { god: true, freezeAI: true, infiniteAmmo: true });
  // Make sure a firearm is in hand (primary 1 → secondary).
  for (const key of ['Digit1', 'Digit3']) {
    if (await api(page, 'weapon')) break;
    await press(page, key);
    await page.waitForTimeout(700);
  }
  expect(await api(page, 'weapon'), 'a firearm in hand for the commander fight').toBeTruthy();
  const boss = (await api<{ id: string; role: string; alive: boolean; x: number; y: number }[]>(page, 'enemies')).find((e) => e.role === 'boss');
  expect(boss, 'commander spawned for Q08').toBeTruthy();
  const bossSpot = await api<{ x: number; y: number } | null>(page, 'clearShotSpot', boss!.id, 5);
  expect(bossSpot).toBeTruthy();
  await teleport(page, bossSpot!.x, bossSpot!.y);
  let bossDead = false;
  for (let i = 0; i < 120 && !bossDead; i++) {
    const b = (await api<{ id: string; alive: boolean; x: number; y: number }[]>(page, 'enemies')).find((e) => e.id === boss!.id)!;
    if (!b.alive) {
      bossDead = true;
      break;
    }
    await aimAt(page, b.x, b.y, 1.1);
    await fire(page, 60);
    await page.waitForTimeout(160);
    if (i === 3) await snap('08-boss');
  }
  bossDead ||= !(await api<{ id: string; alive: boolean }[]>(page, 'enemies')).find((e) => e.id === boss!.id)!.alive;
  expect(bossDead, 'commander killed with real shots').toBe(true);
  const corpse = (await containers(page)).find((c) => c.kind === 'corpse' && c.items.includes('core.quest.cipher_module'));
  expect(corpse, 'cipher module in the commander corpse').toBeTruthy();
  expect(await openContainer(page, corpse!)).toBe(true);
  await expect(page.getByTestId('panel-loot')).toBeVisible();
  await expect.poll(async () => (await containers(page)).find((x) => x.id === corpse!.id)!.searched, { timeout: 20_000 }).toBeGreaterThanOrEqual(corpse!.items.length);
  const cipherId = corpse!.itemIds[corpse!.items.indexOf('core.quest.cipher_module')]!;
  await page.locator(`[data-item="${cipherId}"]`).click({ modifiers: ['Shift'] });
  await expect.poll(async () => (await api<{ def: string }[]>(page, 'carried')).some((i) => i.def === 'core.quest.cipher_module')).toBe(true);
  await snap('09-cipher');
  await closePanels(page);
  await extract(page, 'exit.freight_elevator');
  phase('Q08 delivery & epilogue');
  await deliver(page, 'comms', 'core.quest.q08_last_signal');
  await talkTo(page, 'comms');
  await page.getByTestId('turnin-core.quest.q08_last_signal').click();
  await expect(page.getByTestId('panel-chapter')).toBeVisible();
  await snap('10-epilogue');
  await page.getByTestId('chapter-continue').click();
  await expect.poll(async () => (await profile(page))!.chapter).toMatchObject({ completed: true, epilogueSeen: true });
  expect((await profile(page))!.flags['free_roam']).toBe(true);

  // --- free roam: both maps ---------------------------------------------------------------------------------------------
  phase('free roam');
  await deploy(page, 'core.dest.quarantine_main', envs);
  await extract(page, 'exit.east_road');
  await deploy(page, 'core.dest.outer_supply_route', envs);
  await extract(page, 'exit.rail_tunnel');
  expect(envs.size, `time/weather seen: ${[...envs].join(', ')}`).toBeGreaterThanOrEqual(2);
  note(testInfo, 'environments', [...envs].join(', '));

  // --- save → reload → everything restored ---------------------------------------------------------------------------------
  phase('reload restore');
  await page.waitForTimeout(500);
  const before = (await profile(page))!;
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __BOOTED__?: boolean }).__BOOTED__ === true);
  await expect(page.getByTestId('slot-3')).toContainText('Chapter 1 완료');
  await page.getByTestId('slot-continue-3').click();
  await waitMode(page, 'base');
  const after = (await profile(page))!;
  const pick = (p: ProfileLite) => ({
    currency: p.currency,
    level: p.level,
    perks: p.perks,
    buildings: p.buildings.map((b) => b.buildingId).sort(),
    facilities: p.facilities,
    market: p.market,
    notes: p.notes,
    keys: p.keys,
    quests: Object.fromEntries(Object.entries(p.quests).map(([k, v]) => [k, v.status])),
    chapter: p.chapter,
    flags: p.flags,
    stats: p.stats,
    items: defCounts(p),
  });
  expect(pick(after)).toEqual(pick(before));
  for (const q of ['q01_ready', 'q02_first_haul', 'q03_remember_road', 'q06_scrap', 'q07_restore_power', 'q08_last_signal']) expect(after.quests[`core.quest.${q}`]!.status).toBe('completed');
  expect(after.notes['core.note.farm_diary']!.found).toBe(true);
  await snap('11-restored');
  expect(info.errors).toEqual([]);
  phase('done');
});
