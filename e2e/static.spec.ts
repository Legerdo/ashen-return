import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A24 — the real release bundle (dist/, built without test hooks) served by a plain static file server
 * (scripts/static-server.mjs: GET/HEAD of files only, no backend). Only DOM and real input are used here.
 * Boot → new slot → controls tutorial → real keyboard progress (lesson 1: walk to the marked spot) saved to
 * IndexedDB → browser reload → continue → the tutorial resumes at lesson 2 → skip → shelter → reload → shelter.
 */
const ORIGIN = 'http://127.0.0.1:4180';
/** Tutorial map spawn (5, 11) → lesson-1 spot (9, 16); walking speed 3 u/s (TUNABLE values in the source). */
const WALK = { south: (5 / 3) * 1000, east: (4 / 3) * 1000 };

test('@static release dist/ on a plain static server: boot → new slot → save → reload → continue', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  // The release output contains no test hook chunk and no hook API string.
  const assets = fs.readdirSync(path.resolve('dist/assets'));
  expect(assets.filter((f) => /testhooks/i.test(f))).toEqual([]);
  for (const f of assets.filter((x) => x.endsWith('.js'))) expect(fs.readFileSync(path.resolve('dist/assets', f), 'utf8').includes('__ASHEN_TEST__'), f).toBe(false);

  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', (r) => requests.push(`${r.method()} ${r.url()}`));
  page.on('pageerror', (e) => errors.push(String(e)));
  const booted = () => page.waitForFunction(() => (window as unknown as { __BOOTED__?: boolean }).__BOOTED__ === true, null, { timeout: 30_000 });

  await page.goto(`${ORIGIN}/index.html`);
  await booted();
  expect(await page.evaluate(() => typeof (window as unknown as { __ASHEN_TEST__?: unknown }).__ASHEN_TEST__)).toBe('undefined');
  await expect(page.locator('#game-canvas-host canvas')).toBeVisible();

  await page.getByTestId('slot-name-2').fill('정적 배포 검증');
  await page.getByTestId('slot-new-2').click();
  // A new slot starts in the controls tutorial (lesson box + the always-visible key strip).
  const box = page.getByTestId('tutorial-box');
  await expect(box).toHaveAttribute('data-step', 'move');
  await expect(box).toContainText('기초 훈련 1 / 15');
  await expect(page.getByTestId('hud-keys')).toContainText('이동');

  // Real keyboard input: walk from the spawn to the marked spot (south, then east); the lesson is saved.
  await page.evaluate(() => (document.getElementById('game-frame') as HTMLElement).focus({ preventScroll: true }));
  await page.mouse.move(640, 360);
  for (const [key, ms] of [['KeyS', WALK.south], ['KeyD', WALK.east]] as const) {
    await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    await page.keyboard.up(key);
    await page.waitForTimeout(150);
  }
  await expect(box).toHaveAttribute('data-step', 'sprint', { timeout: 5000 });
  await page.waitForTimeout(600); // the lesson commit is an IndexedDB transaction
  await page.screenshot({ path: `test-results/screens/${testInfo.project.name}-static-01-tutorial.png` });

  await page.reload();
  await booted();
  await expect(page.getByTestId('slot-2')).toContainText('정적 배포 검증');
  await expect(page.getByTestId('slot-2')).toContainText('Lv.1');
  await page.getByTestId('slot-continue-2').click();
  // Resumes at lesson 2; then the HUD skip button leads into the shelter.
  await expect(box).toHaveAttribute('data-step', 'sprint');
  await expect(box).toContainText('기초 훈련 2 / 15');
  await page.getByTestId('tutorial-skip').click();
  await expect(page.getByText('지하 대피소 · 대피소')).toBeVisible();
  await expect(page.getByText('Q01 돌아올 준비')).toBeVisible();
  await expect(page.getByText('■ 대피소 중앙 홀로 이동')).toHaveCount(0);
  await page.waitForTimeout(600);

  await page.reload();
  await booted();
  await page.getByTestId('slot-continue-2').click();
  // Tutorial finished (skipped) is persisted: continue goes straight to the shelter.
  await expect(page.getByText('지하 대피소 · 대피소')).toBeVisible();
  await expect(page.getByText('Q01 돌아올 준비')).toBeVisible();
  await expect(box).toBeHidden();
  await page.screenshot({ path: `test-results/screens/${testInfo.project.name}-static-02-restored.png` });

  // Everything was a plain GET to the static origin: no backend, no third-party requests.
  expect(requests.length).toBeGreaterThan(2);
  expect(requests.filter((r) => !r.startsWith(`GET ${ORIGIN}/`))).toEqual([]);
  expect(errors).toEqual([]);
});
