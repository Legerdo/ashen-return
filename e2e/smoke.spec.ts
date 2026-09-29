import { expect, test } from '@playwright/test';
import { api, boot, closePanels, focusGame, openStation, profile, shot, skipTutorial, talkTo, teleport, waitMode } from './helpers';

/**
 * @smoke — runs in Chromium, Firefox and WebKit (e2e bundle on a plain static server).
 * Boot → new slot through the title UI → tutorial (skipped) → shelter renders frames → real keyboard sprint walk →
 * NPC dialog → one short raid (deploy, map renders, 5 s extraction, summary) → IndexedDB reload restores the slot.
 * Shortcuts (disclosed): the Q01 deploy gate is opened with the debug flag hook, and the exit is reached by teleport.
 */
test('@smoke boot → new slot → shelter → dialog → short raid → reload restores', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const info = await boot(page);
  const project = testInfo.project.name;
  await expect(page.locator('#game-canvas-host canvas')).toBeVisible();
  await expect(page.getByTestId('slot-new-1')).toBeVisible();

  await page.getByTestId('slot-name-1').fill('스모크 슬롯');
  await page.getByTestId('slot-new-1').click();
  // A new slot opens the controls tutorial; its HUD skip button leads to the shelter.
  await waitMode(page, 'tutorial');
  await expect(page.getByTestId('tutorial-box')).toBeVisible();
  await skipTutorial(page);

  // The world is actually being rendered (frame loop running).
  await api(page, 'resetFrameStats');
  await page.waitForTimeout(1500);
  const frames = await api<{ n: number; avgMs: number }>(page, 'frameStats');
  expect(frames.n, 'frames rendered in 1.5 s').toBeGreaterThan(20);

  // Real keyboard input: walk south from the spawn (no stamina cost in the shelter even when sprinting).
  await focusGame(page);
  await page.mouse.move(640, 520);
  const p0 = await api<{ x: number; y: number }>(page, 'player');
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyS');
  await page.waitForTimeout(1200);
  await page.keyboard.up('KeyS');
  await page.keyboard.up('ShiftLeft');
  await expect.poll(async () => (await api<{ y: number }>(page, 'player')).y - p0.y).toBeGreaterThan(2);
  expect(await api<{ stamina: number; staminaMax: number }>(page, 'player')).toMatchObject({ stamina: 100, staminaMax: 100 });

  await talkTo(page, 'mechanic');
  await shot(page, project, 'smoke-01-dialog');
  await closePanels(page);
  await expect.poll(async () => (await profile(page))!.quests['core.quest.q01_ready']!.progress['talk'] ?? 0).toBe(1);

  // One short raid through the real deploy panel and a real 5 s extraction.
  expect(await api<boolean>(page, 'setFlag', 'deploy_allowed')).toBe(true);
  await openStation(page, 32, 2.3, 'panel-deploy');
  await page.getByTestId('dest-core.dest.quarantine_main').click();
  await page.getByTestId('deploy-go').click();
  await waitMode(page, 'raid', 30_000);
  await api(page, 'setDebug', { god: true, freezeAI: true });
  await page.waitForTimeout(800);
  await shot(page, project, 'smoke-02-raid');
  const exits = await api<{ id: string; x: number; y: number; w: number; h: number }[]>(page, 'exits');
  const ex = exits.find((e) => e.id === 'exit.west_drain')!;
  await teleport(page, ex.x + ex.w / 2, ex.y + ex.h / 2);
  await waitMode(page, 'summary', 25_000);
  expect((await api<{ outcome: string }>(page, 'summary')).outcome).toBe('extracted');
  await page.getByTestId('summary-continue').click();
  await waitMode(page, 'base');
  const before = (await profile(page))!;
  expect(before.stats.extractions).toBe(1);

  // IndexedDB persistence across a browser reload.
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __BOOTED__?: boolean }).__BOOTED__ === true, null, { timeout: 30_000 });
  await expect(page.getByTestId('slot-1')).toContainText('스모크 슬롯');
  await page.getByTestId('slot-continue-1').click();
  await waitMode(page, 'base');
  const after = (await profile(page))!;
  expect(after.stats).toEqual(before.stats);
  expect(after.quests['core.quest.q01_ready']!.progress).toEqual(before.quests['core.quest.q01_ready']!.progress);
  expect(after.currency).toBe(before.currency);
  await shot(page, project, 'smoke-03-restored');
  expect(info.errors).toEqual([]);
});
