import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { api, boot, newSlot, openStation, shot, teleport, waitMode } from './helpers';

/**
 * A22 — performance of the production bundle (vite production build, minified; the e2e variant only adds the lazily
 * loaded test-hook chunk) at 1920×1080 output (DPR 1 → world canvas ×3). Target load from the spec: 20 enemies,
 * 150 concurrent projectiles, 50 active drops. Enemies are real actors with live AI (investigating/fighting the
 * god-mode player); projectiles are real 5.56 rounds through the live collision/penetration/impact pipeline (zero
 * damage so the load persists); drops are real ground piles with items. Measured: rAF frame interval (avg, p50/p95/
 * p99, 1% low = mean of the worst 1 %), sim step and sim+UI time per frame, Chromium JS heap samples, DOM node count,
 * CDP task/script/layout/style time per frame, and V8 GC events from a trace. Numbers are recorded as measured.
 */

test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, trace: 'off' });

interface Summ {
  n: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  low1: number;
}
interface PerfOut {
  frame: Summ;
  sim: Summ;
  app: Summ;
  over20: number;
  over33: number;
  seconds: number;
}
interface Load {
  enemies: number;
  enemiesNear: number;
  projectiles: number;
  drops: number;
  items: number;
  heapMB: number | null;
  domNodes: number;
}

const r1 = (x: number) => Math.round(x * 100) / 100;

test('@perf A22 1080p production bundle: 20 enemies + 150 projectiles + 50 drops', async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'CDP metrics and V8 tracing are Chromium-only');
  test.setTimeout(240_000);
  const info = await boot(page);
  await newSlot(page, 1, '성능 측정');
  expect(await api<boolean>(page, 'setFlag', 'deploy_allowed')).toBe(true);
  await openStation(page, 32, 2.3, 'panel-deploy');
  await page.getByTestId('deploy-go').click();
  await waitMode(page, 'raid', 30_000);
  await api(page, 'setDebug', { god: true });
  const renderer = await api<{ kind: string; gpu: string }>(page, 'renderer');
  const layout = await page.evaluate(() => {
    const r = document.querySelector('#game-canvas-host canvas')!.getBoundingClientRect();
    return { w: r.width, h: r.height, dpr: devicePixelRatio };
  });
  expect(layout).toEqual({ w: 1920, h: 1080, dpr: 1 });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries(((await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }).metrics.map((m) => [m.name, m.value]));
  const measure = async (seconds: number) => {
    const m0 = await metrics();
    await api(page, 'perfStart');
    const samples: (Load & { cdpHeapMB: number; cdpNodes: number })[] = [];
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      await page.waitForTimeout(500);
      const m = await metrics();
      samples.push({ ...(await api<Load>(page, 'loadStats'))!, cdpHeapMB: r1((m['JSHeapUsedSize'] ?? 0) / 1048576), cdpNodes: m['Nodes'] ?? 0 });
    }
    const out = (await api<PerfOut>(page, 'perfStop'))!;
    const m1 = await metrics();
    const frames = Math.max(1, out.frame.n);
    const perFrame = (k: string) => r1(((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000 / frames);
    return { out, samples, cpuPerFrameMs: { task: perFrame('TaskDuration'), script: perFrame('ScriptDuration'), layout: perFrame('LayoutDuration'), style: perFrame('RecalcStyleDuration') }, heapUsedMB: r1((m1['JSHeapUsedSize'] ?? 0) / 1048576), nodes: m1['Nodes'] ?? 0, listeners: m1['JSEventListeners'] ?? 0 };
  };

  // Baseline: the same raid without the extra load (player standing in the farm field).
  await teleport(page, 26, 70);
  await page.waitForTimeout(2500);
  const baseline = await measure(6);

  // Target load.
  // Invulnerable so AI friendly fire cannot thin the load during the window (every hit is still fully resolved).
  // 22 so that ≥ 20 stay within 16u for the whole window: marksmen keep a 14–26u stand-off and may step out briefly.
  const spawned = await api<number>(page, 'spawnEnemies', 22, 5, 12, true);
  expect(spawned).toBe(22);
  const drops = await api<number>(page, 'spawnDrops', 50, 9);
  expect(drops).toBe(50);
  await api(page, 'sustainProjectiles', 150);
  await page.waitForTimeout(4000); // warm-up: AI engages, pools and textures settle
  await shot(page, testInfo.project.name, 'a22-load-1080p');
  const loaded = await measure(30);

  // GC activity under the same load (separate window: tracing has its own overhead).
  await browser.startTracing(page, { categories: ['devtools.timeline', 'v8', 'disabled-by-default-v8.gc'] });
  await page.waitForTimeout(8000);
  const trace = JSON.parse((await browser.stopTracing()).toString('utf8')) as { traceEvents: { name: string; ph: string; dur?: number; ts: number }[] };
  await api(page, 'sustainProjectiles', 0);
  const gcEvents = trace.traceEvents.filter((e) => (e.name === 'MinorGC' || e.name === 'MajorGC') && e.ph === 'X');
  const gc = {
    minor: gcEvents.filter((e) => e.name === 'MinorGC').length,
    major: gcEvents.filter((e) => e.name === 'MajorGC').length,
    totalMs: r1(gcEvents.reduce((s, e) => s + (e.dur ?? 0), 0) / 1000),
    maxMs: r1(Math.max(0, ...gcEvents.map((e) => (e.dur ?? 0) / 1000))),
    windowSec: 8,
  };

  const s = loaded.samples;
  const load = {
    enemiesNearMin: Math.min(...s.map((x) => x.enemiesNear)),
    enemiesAvg: r1(s.reduce((a, x) => a + x.enemies, 0) / s.length),
    projectilesMin: Math.min(...s.map((x) => x.projectiles)),
    projectilesAvg: r1(s.reduce((a, x) => a + x.projectiles, 0) / s.length),
    dropsMin: Math.min(...s.map((x) => x.drops)),
    // V8 heap as reported by CDP (precise; performance.memory is bucketed in Chromium and not used).
    jsHeapMB: { first: s[0]!.cdpHeapMB, min: Math.min(...s.map((x) => x.cdpHeapMB)), max: Math.max(...s.map((x) => x.cdpHeapMB)), last: s[s.length - 1]!.cdpHeapMB },
    // All DOM nodes alive in the renderer (incl. detached ones awaiting GC) and the attached element count.
    domNodesAll: { first: s[0]!.cdpNodes, max: Math.max(...s.map((x) => x.cdpNodes)), last: s[s.length - 1]!.cdpNodes },
    domElementsAttached: { first: s[0]!.domNodes, last: s[s.length - 1]!.domNodes },
  };
  const fmt = (o: PerfOut) => ({
    frames: o.frame.n,
    seconds: r1(o.seconds),
    fpsAvg: r1(1000 / o.frame.avg),
    frameMs: { avg: r1(o.frame.avg), p50: r1(o.frame.p50), p95: r1(o.frame.p95), p99: r1(o.frame.p99), max: r1(o.frame.max), low1: r1(o.frame.low1) },
    low1Fps: r1(1000 / o.frame.low1),
    over20ms: o.over20,
    over33ms: o.over33,
    simStepMs: { avg: r1(o.sim.avg), p99: r1(o.sim.p99), max: r1(o.sim.max) },
    simPlusUiMs: { avg: r1(o.app.avg), p99: r1(o.app.p99), max: r1(o.app.max) },
  });
  const report = {
    when: new Date().toISOString(),
    browser: `${testInfo.project.name} ${browser.version()} (headless)`,
    build: 'vite production build (dist-e2e: minified, same code as dist + lazy test-hook chunk)',
    output: `${layout.w}×${layout.h} @ DPR ${layout.dpr} (world 640×360 ×3)`,
    renderer,
    baseline: { ...fmt(baseline.out), cpuPerFrameMs: baseline.cpuPerFrameMs, heapUsedMB: baseline.heapUsedMB },
    loaded: { ...fmt(loaded.out), cpuPerFrameMs: loaded.cpuPerFrameMs, heapUsedMB: loaded.heapUsedMB, listeners: loaded.listeners, load },
    gc,
  };
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/perf-a22.json', JSON.stringify(report, null, 2));
  console.log(`[A22] ${JSON.stringify(report, null, 2)}`);

  // The load really was present for the whole window.
  expect(load.enemiesNearMin, 'enemies near the player').toBeGreaterThanOrEqual(20);
  expect(load.projectilesMin, 'concurrent projectiles').toBeGreaterThanOrEqual(150);
  expect(load.dropsMin, 'active drops').toBeGreaterThanOrEqual(50);
  expect(loaded.out.frame.n, 'frames recorded').toBeGreaterThan(200);
  // No runaway growth over the window (a leak of per-frame DOM or projectile state would show up here).
  expect(load.jsHeapMB.last - load.jsHeapMB.first, 'JS heap growth over the loaded window (MB)').toBeLessThan(20);
  expect(load.domNodesAll.max, 'DOM nodes stay bounded').toBeLessThan(50_000);
  expect(info.errors).toEqual([]);
});
