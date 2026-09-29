import { expect, test } from '@playwright/test';
import { aimAt, api, boot, closePanels, defCounts, fire, focusGame, openStation, press, profile, questStatus, shot, skipTutorial, talkTo, teleport, waitMode } from './helpers';

/**
 * P0 core vertical slice (Chromium + Firefox):
 * title → new slot → shelter → Q01 → prepare → first raid → combat → loot → heal → extract (5 s) → settlement
 * → shelter → Q02 delivery → browser reload → identical state restored. Also reloads mid-raid and resumes.
 *
 * Real input is used for movement keys, interaction (E), aiming (mouse), firing, reloading, quickslot use,
 * UI buttons and the extraction timer. Test hooks are used only to teleport between far-apart points,
 * freeze enemy AI during the scripted fight, and set up a wound for the healing step (disclosed in the report).
 */
test('@p0 new slot → first extraction → reload restore', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const info = await boot(page);
  const snapName = (n: string) => shot(page, testInfo.project.name, `p0-${n}`);

  // --- title → new slot (the controls tutorial is skipped here; e2e/tutorial.spec.ts plays it) ---------------
  await expect(page.getByTestId('title')).toBeVisible();
  await page.getByTestId('slot-name-1').fill('테스트 생존자');
  await page.getByTestId('slot-new-1').click();
  await skipTutorial(page);
  const start = (await profile(page))!;
  expect(start.currency).toBe(1500);
  expect(start.quests['core.quest.q01_ready']!.status).toBe('active');
  expect(Object.keys(start.quests['core.quest.q01_ready']!.progress)).not.toContain('move');
  // Onboarding guidance: the mechanic (talk) and the range (reload drill) are marked, on screen or at the edge.
  await expect(page.locator('[data-guide="npc:core.npc.mechanic"]:visible')).toHaveCount(1);
  await expect(page.locator('[data-guide="place:poi.range"]:visible')).toHaveCount(1);
  await expect(page.getByTestId('hud-keys')).toBeVisible();
  await page.waitForTimeout(400);
  await snapName('01-base');

  // --- Q01: talk to the mechanic, reload at the range (no walk-to-the-hall objective any more) ---------------
  await focusGame(page);
  await page.mouse.move(640, 520);
  await talkTo(page, 'mechanic');
  await expect.poll(async () => (await profile(page))!.quests['core.quest.q01_ready']!.progress['talk'] ?? 0).toBe(1);
  await closePanels(page);

  await teleport(page, 24, 18);
  await aimAt(page, 29, 17, 1.2);
  await fire(page);
  await page.waitForTimeout(300);
  await snapName('02-range');
  await press(page, 'KeyR');
  await expect.poll(() => questStatus(page, 'core.quest.q01_ready'), { timeout: 10_000 }).toBe('ready');
  // Turn-in guidance: a toast names the mechanic, the tracker says whom to report to, and the mechanic is marked
  // (off screen from the range → an edge arrow pointing at him).
  await expect.poll(async () => (await api<string[]>(page, 'toasts')).some((t) => t.includes('정비공 부엉에게 보고'))).toBe(true);
  await expect(page.locator('.hud-objectives .guide-line')).toContainText('정비공 부엉에게 보고');
  await expect(page.getByTestId('guide-edge-npc:core.npc.mechanic')).toBeVisible();
  await snapName('02b-report-guide');

  await talkTo(page, 'mechanic');
  await page.getByTestId('turnin-core.quest.q01_ready').click();
  await expect.poll(() => questStatus(page, 'core.quest.q01_ready')).toBe('completed');
  expect((await profile(page))!.flags['deploy_allowed']).toBe(true);
  expect(await questStatus(page, 'core.quest.q02_first_haul')).toBe('active');
  await closePanels(page);

  // --- Q05 cover drill (optional, auto-activated with Q01): inside the range its two drill spots are marked; ------
  // standing in the yellow-bordered zone, the high wall stops the turret's training rounds and each block counts.
  expect(await questStatus(page, 'core.quest.q05_cover')).toBe('active');
  await teleport(page, 24.5, 27.8);
  await expect(page.locator('[data-guide="place:poi.q05_zone"]:visible')).toHaveCount(1);
  await teleport(page, 24.5, 31.3);
  await expect.poll(async () => (await api<string[]>(page, 'toasts')).some((t) => t.includes('엄폐 훈련 구역 — 벽 너머 포탑이'))).toBe(true);
  await expect.poll(async () => (await profile(page))!.quests['core.quest.q05_cover']!.progress['wall'] ?? 0, { timeout: 10_000 }).toBe(3);
  await expect.poll(async () => (await api<string[]>(page, 'toasts')).some((t) => t.includes('벽이 훈련탄을 막았다'))).toBe(true);
  expect((await api<{ wallBlocks: number }>(page, 'rangeStats')).wallBlocks).toBeGreaterThanOrEqual(3);
  await snapName('02c-q05-zone');

  // --- prepare & deploy ----------------------------------------------------------------------------------
  await openStation(page, 32, 2.3, 'panel-deploy');
  await page.getByTestId('dest-core.dest.quarantine_main').click();
  await snapName('03-deploy');
  await page.getByTestId('deploy-go').click();
  await waitMode(page, 'raid', 30_000);
  await page.waitForTimeout(700);
  await snapName('04-raid');
  const deployed = (await profile(page))!;
  expect(deployed.activeRaid).not.toBeNull();
  const sim0 = await api<{ raidId: string; mapId: string }>(page, 'sim');
  expect(sim0.mapId).toBe('core.map.quarantine_main');

  // --- combat against a real AI loadout (AI frozen for determinism; ballistics/damage are real) --------------
  await api(page, 'setDebug', { freezeAI: true });
  const enemies = await api<{ id: string; x: number; y: number; alive: boolean; role: string }[]>(page, 'enemies');
  // Nearest live non-boss enemy to the spawn (south of the map).
  const me = await api<{ x: number; y: number }>(page, 'player');
  const target = enemies.filter((e) => e.alive && e.role !== 'boss').sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0];
  expect(target, 'a live enemy exists').toBeTruthy();
  const spot = await api<{ x: number; y: number } | null>(page, 'clearShotSpot', target!.id, 5);
  expect(spot, 'clear firing spot').toBeTruthy();
  await teleport(page, spot!.x, spot!.y);
  let killed = false;
  for (let i = 0; i < 30 && !killed; i++) {
    const e = (await api<{ id: string; x: number; y: number; alive: boolean }[]>(page, 'enemies')).find((x) => x.id === target!.id)!;
    if (!e.alive) {
      killed = true;
      break;
    }
    await aimAt(page, e.x, e.y, 1.05);
    await fire(page, 60);
    if (i === 0) {
      await page.waitForTimeout(40);
      await snapName('05-fight');
    }
    await page.waitForTimeout(300);
    const pl = await api<{ action: string | null }>(page, 'player');
    if (i % 7 === 6 && !pl.action) {
      await press(page, 'KeyR');
      await page.waitForTimeout(2600);
    }
  }
  if (!killed) killed = !(await api<{ id: string; alive: boolean }[]>(page, 'enemies')).find((x) => x.id === target!.id)!.alive;
  expect(killed, 'enemy killed with real shots').toBe(true);
  // Loot the corpse: its real weapon/magazines/rounds are there.
  const corpse = (await api<{ id: string; kind: string; items: string[] }[]>(page, 'containers')).find((c) => c.kind === 'corpse');
  expect(corpse, 'corpse container created once').toBeTruthy();
  expect(corpse!.items.some((d) => d.startsWith('core.weapon.'))).toBe(true);
  const simAfterFight = await api<{ stats: { kills: number; shotsFired: number; hits: number } }>(page, 'sim');
  expect(simAfterFight.stats.kills).toBeGreaterThanOrEqual(1);
  expect(simAfterFight.stats.hits).toBeGreaterThanOrEqual(1);

  // --- loot the farm relief crate (Q02 item) -------------------------------------------------------------------
  const conts = await api<{ id: string; typeId: string; x: number; y: number; items: string[] }[]>(page, 'containers');
  const relief = conts.find((c) => c.items.includes('core.quest.relief_package'));
  expect(relief, 'relief package placed while Q02 is active').toBeTruthy();
  await teleport(page, relief!.x, relief!.y + 0.9);
  await press(page, 'KeyE');
  await expect(page.getByTestId('panel-loot')).toBeVisible();
  await expect.poll(async () => (await api<{ id: string; searched: number; items: string[] }[]>(page, 'containers')).find((c) => c.id === relief!.id)!.searched, { timeout: 15_000 }).toBeGreaterThanOrEqual(relief!.items.length);
  await snapName('06-loot');
  await page.getByTestId('take-all').click();
  await expect.poll(async () => (await api<{ def: string }[]>(page, 'carried')).some((i) => i.def === 'core.quest.relief_package'), { timeout: 5000 }).toBe(true);
  await snapName('07-loot-taken');
  await closePanels(page);

  // --- mid-raid browser reload: resume the same raid, same loot, nothing re-rolled -------------------------------
  await page.keyboard.press('Escape'); // pause → checkpoint
  await expect(page.getByTestId('panel-pause')).toBeVisible();
  await page.waitForTimeout(600);
  const beforeReload = await api<{ id: string; def: string; qty: number; owner: string }[]>(page, 'raidItems');
  const reliefState = (await api<{ id: string; searched: number; items: string[] }[]>(page, 'containers')).find((c) => c.id === relief!.id)!;
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __BOOTED__?: boolean }).__BOOTED__ === true);
  await page.getByTestId('slot-continue-1').click();
  await waitMode(page, 'raid');
  await expect(page.getByTestId('panel-pause')).toBeVisible();
  const afterReload = await api<{ id: string; def: string; qty: number; owner: string }[]>(page, 'raidItems');
  const norm = (l: { id: string; def: string; qty: number; owner: string }[]) => l.map((i) => `${i.id}|${i.def}|${i.qty}|${i.owner}`).sort();
  expect(norm(afterReload)).toEqual(norm(beforeReload));
  const reliefAfter = (await api<{ id: string; searched: number; items: string[] }[]>(page, 'containers')).find((c) => c.id === relief!.id)!;
  expect(reliefAfter.searched).toBe(reliefState.searched);
  expect((await api<{ raidId: string }>(page, 'sim')).raidId).toBe(sim0.raidId);
  await snapName('08-resumed');
  await page.getByTestId('resume').click();
  await api(page, 'setDebug', { freezeAI: true });

  // --- heal: wounded + bleeding, use the bandage quickslot (key 4) -------------------------------------------
  expect(await api<boolean>(page, 'setPlayerCondition', 72, true)).toBe(true);
  await press(page, 'Digit4');
  await expect.poll(async () => (await api<{ bleeding: boolean }>(page, 'player')).bleeding, { timeout: 8000 }).toBe(false);

  // --- extract: stand in the free west drain exit for 5 s ------------------------------------------------------
  const exits = await api<{ id: string; x: number; y: number; w: number; h: number; enabled: boolean }[]>(page, 'exits');
  const drain = exits.find((e) => e.id === 'exit.west_drain')!;
  expect(drain.enabled).toBe(true);
  await teleport(page, drain.x + drain.w / 2, drain.y + drain.h / 2);
  const t0 = Date.now();
  await waitMode(page, 'summary', 20_000);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(4500);
  await expect(page.getByTestId('panel-summary')).toBeVisible();
  // The settlement already says where to take the relief package.
  await expect(page.getByTestId('summary-guides')).toContainText('의무관 백로에게 전달');
  await snapName('09-summary');
  const summary = await api<{ outcome: string; itemsIn: { defId: string; qty: number }[]; kills: number }>(page, 'summary');
  expect(summary.outcome).toBe('extracted');
  expect(summary.itemsIn.some((i) => i.defId === 'core.quest.relief_package')).toBe(true);
  const settled = (await profile(page))!;
  expect(settled.activeRaid).toBeNull();
  expect(settled.stats.extractions).toBe(1);
  const counts = defCounts(settled);
  expect(counts['core.quest.relief_package']).toBe(1);
  await page.getByTestId('summary-continue').click();
  await waitMode(page, 'base');
  // Back in the shelter: toast + marker on the medic for the delivery.
  await expect.poll(async () => (await api<string[]>(page, 'toasts')).some((t) => t.includes('의무관 백로에게 가져가세요'))).toBe(true);
  await expect(page.locator('[data-guide="npc:core.npc.medic"]:visible')).toHaveCount(1);

  // --- Q02: deliver to the medic and report ------------------------------------------------------------------------
  await talkTo(page, 'medic');
  await page.getByTestId('deliver-core.quest.q02_first_haul').click();
  await expect.poll(() => questStatus(page, 'core.quest.q02_first_haul')).toBe('ready');
  await page.getByTestId('turnin-core.quest.q02_first_haul').click();
  await expect.poll(() => questStatus(page, 'core.quest.q02_first_haul')).toBe('completed');
  const done = (await profile(page))!;
  expect(defCounts(done)['core.quest.relief_package'] ?? 0).toBe(0);
  expect(done.currency).toBe(settled.currency + 600);
  await closePanels(page);

  // --- browser reload → continue → identical profile ------------------------------------------------------------
  await page.waitForTimeout(400);
  const snap = (await profile(page))!;
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __BOOTED__?: boolean }).__BOOTED__ === true);
  await expect(page.getByTestId('slot-1')).toContainText('테스트 생존자');
  await page.getByTestId('slot-continue-1').click();
  await waitMode(page, 'base');
  const restored = (await profile(page))!;
  expect(restored.currency).toBe(snap.currency);
  expect(restored.quests).toEqual(snap.quests);
  expect(restored.flags).toEqual(snap.flags);
  expect(defCounts(restored)).toEqual(defCounts(snap));
  expect(Object.keys(restored.store.items).sort()).toEqual(Object.keys(snap.store.items).sort());
  expect(restored.stats).toEqual(snap.stats);

  // Same data from a second tab in the same browser profile (fresh page, same IndexedDB).
  const page2 = await page.context().newPage();
  await boot(page2);
  await expect(page2.getByTestId('slot-1')).toContainText('테스트 생존자');
  await page2.close();

  expect(info.errors).toEqual([]);
});
