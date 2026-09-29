import { expect, test, type Browser, type Page } from '@playwright/test';
import { api, boot, closePanels, focusGame, openStation, press, shot, skipTutorial, talkTo, teleport, waitMode } from './helpers';

/**
 * A21 — Korean text, DPR / resize integer scaling, input release, audio unlock and accessibility basics.
 * Real DOM, real pointer/keyboard input and real screenshots; the only hooks used read state (mode, player aim,
 * worldToClient, audio status), teleport to stations, and open the Q01 deploy gate for the raid screens.
 */

const E2E = 'http://127.0.0.1:4181/index.html';

async function newSlot(page: Page, slot = 1, name = 'A21'): Promise<void> {
  await page.getByTestId(`slot-name-${slot}`).fill(name);
  await page.getByTestId(`slot-new-${slot}`).click();
  await skipTutorial(page);
}

// ------------------------------------------------------------------------------------------ Korean text

/** Visible text under #app that looks broken: raw localisation keys, replacement glyphs, JS leftovers. */
async function brokenText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    const key = /(?:^|[^A-Za-z0-9_.])([a-z][a-z0-9_]*(?:\.[a-z0-9_]*[a-z][a-z0-9_]*)+)(?![A-Za-z0-9_])/;
    const walker = document.createTreeWalker(document.getElementById('app')!, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      const text = (n.textContent ?? '').trim();
      if (!el || !text || el.closest('noscript')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.getClientRects().length === 0) continue;
      if (/\uFFFD|undefined|NaN|\[object |\bnull\b/.test(text) || key.test(text)) bad.push(text.slice(0, 80));
    }
    // Attribute text that assistive technology reads.
    for (const el of document.querySelectorAll<HTMLElement>('[aria-label],[title],[placeholder]')) {
      for (const a of ['aria-label', 'title', 'placeholder']) {
        const v = el.getAttribute(a);
        if (v && (/\uFFFD|undefined|NaN|\[object /.test(v) || key.test(v))) bad.push(`${a}=${v.slice(0, 60)}`);
      }
    }
    return bad;
  });
}

test('@a21 Korean: lang=ko, Hangul glyphs rendered by the UI font, no raw keys or broken strings on any screen', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const info = await boot(page);
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('ko');

  // Distinct Hangul syllables must render as distinct, non-empty glyphs in the UI font (tofu boxes are identical).
  const glyphs = await page.evaluate(() => {
    const font = getComputedStyle(document.body).fontFamily;
    const cv = document.createElement('canvas');
    cv.width = 48;
    cv.height = 48;
    const g = cv.getContext('2d', { willReadFrequently: true })!;
    const sig = (ch: string) => {
      g.clearRect(0, 0, 48, 48);
      g.fillStyle = '#000';
      g.font = `32px ${font}`;
      g.textBaseline = 'top';
      g.fillText(ch, 4, 4);
      const d = g.getImageData(0, 0, 48, 48).data;
      let ink = 0;
      let h = 0;
      for (let i = 3; i < d.length; i += 4) {
        if (d[i]! > 0) ink++;
        h = (h * 31 + d[i]!) >>> 0;
      }
      return { ink, h };
    };
    const chars = [...'잿빛귀환격리구역탄약'];
    const s = chars.map(sig);
    return { font, inked: s.every((x) => x.ink > 20), distinct: new Set(s.map((x) => x.h)).size, n: chars.length };
  });
  expect(glyphs.inked, `Hangul glyphs have ink in "${glyphs.font}"`).toBe(true);
  expect(glyphs.distinct, 'distinct glyph bitmaps (no tofu)').toBe(glyphs.n);

  const screens: Record<string, string[]> = {};
  const scan = async (name: string) => {
    await page.waitForTimeout(150);
    screens[name] = await brokenText(page);
  };
  await scan('title');
  await page.getByTestId('title-settings').click();
  for (const tab of ['audio', 'access', 'controls']) {
    await page.getByTestId(`tab-${tab}`).click();
    await scan(`settings/${tab}`);
  }
  await page.keyboard.press('Escape');

  await newSlot(page, 1, '한글 검사');
  await scan('base HUD');
  await talkTo(page, 'mechanic');
  for (const tab of ['talk', 'buy', 'sell', 'special']) {
    await page.getByTestId(`tab-${tab}`).click();
    await scan(`npc mechanic/${tab}`);
  }
  await closePanels(page);
  await talkTo(page, 'medic');
  await page.getByTestId('tab-special').click();
  await scan('npc medic/special');
  await closePanels(page);
  await talkTo(page, 'comms');
  await page.getByTestId('tab-special').click();
  await scan('npc comms/special');
  await closePanels(page);
  await focusGame(page);
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('panel-stash')).toBeVisible();
  for (const tab of ['stash', 'perks', 'quests', 'notes']) {
    await page.getByTestId(`tab-${tab}`).click();
    await scan(`stash/${tab}`);
  }
  await closePanels(page);
  const stations: [number, number, string][] = [
    [32, 2.3, 'panel-deploy'],
    [38.5, 3.2, 'panel-board'],
    [9.5, 4.9, 'panel-craft-workbench'],
    [19.5, 4.9, 'panel-craft-medical'],
    [48, 4.9, 'panel-market'],
    [57.2, 8.9, 'panel-generator'],
    [3.5, 15.9, 'panel-build'],
    [23, 16.0, 'panel-rack'],
    [25.5, 16.0, 'panel-terminal'],
  ];
  for (const [x, y, id] of stations) {
    await openStation(page, x, y, id);
    await scan(id);
  }
  await closePanels(page);
  await focusGame(page);
  await page.keyboard.press('KeyM');
  await scan('map (shelter)');
  await closePanels(page);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('panel-pause')).toBeVisible();
  await scan('pause (shelter)');
  await closePanels(page);

  // Raid screens (Q01 gate opened with the debug flag hook).
  expect(await api<boolean>(page, 'setFlag', 'deploy_allowed')).toBe(true);
  await openStation(page, 32, 2.3, 'panel-deploy');
  await page.getByTestId('deploy-go').click();
  await waitMode(page, 'raid', 30_000);
  await api(page, 'setDebug', { god: true, freezeAI: true });
  await page.waitForTimeout(600);
  await scan('raid HUD');
  await focusGame(page);
  await page.keyboard.press('Tab');
  await expect(page.locator('[role="dialog"]')).toBeVisible();
  await scan('raid inventory');
  await closePanels(page);
  await focusGame(page);
  await page.keyboard.press('KeyM');
  await scan('raid map');
  await closePanels(page);
  await page.keyboard.press('Escape');
  await scan('raid pause');
  await shot(page, testInfo.project.name, 'a21-korean-raid-pause');
  await closePanels(page);

  const broken = Object.entries(screens).filter(([, v]) => v.length > 0);
  expect(broken, `broken strings: ${JSON.stringify(broken)}`).toEqual([]);
  expect(Object.keys(screens).length).toBeGreaterThanOrEqual(25);
  console.log(`[A21] Korean scan clean on ${Object.keys(screens).length} screens; UI font: ${glyphs.font}`);
  expect(info.errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------ DPR / resize

interface Layout {
  dpr: number;
  iw: number;
  ih: number;
  left: number;
  top: number;
  w: number;
  h: number;
  bw: number;
  bh: number;
  worldW: string;
}

async function layout(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('#game-canvas-host canvas')!;
    const r = c.getBoundingClientRect();
    return { dpr: devicePixelRatio, iw: innerWidth, ih: innerHeight, left: r.left, top: r.top, w: r.width, h: r.height, bw: c.width, bh: c.height, worldW: getComputedStyle(document.documentElement).getPropertyValue('--world-w').trim() };
  });
}

/** Integer device-pixel scaling + centred letterbox (or a proportional fit when the window is smaller than 640×360). */
function checkLayout(l: Layout, label: string): number {
  const near = (a: number, b: number, eps = 0.02) => Math.abs(a - b) <= eps;
  expect([l.bw, l.bh], `${label}: backing canvas`).toEqual([640, 360]);
  const physW = Math.floor(l.iw * l.dpr);
  const physH = Math.floor(l.ih * l.dpr);
  const fit = Math.min(physW / 640, physH / 360);
  const s = (l.w * l.dpr) / 640;
  if (fit >= 1) {
    expect(near(s, Math.round(s)), `${label}: device scale ${s} is an integer`).toBe(true);
    expect(Math.round(s), `${label}: largest integer scale that fits`).toBe(Math.floor(fit));
    expect(near((l.h * l.dpr) / 360, Math.round(s)), `${label}: same vertical scale`).toBe(true);
    expect(near(l.left * l.dpr, Math.round(l.left * l.dpr)) && near(l.top * l.dpr, Math.round(l.top * l.dpr)), `${label}: canvas origin on a device pixel (${l.left * l.dpr}, ${l.top * l.dpr})`).toBe(true);
  } else {
    expect(near(l.w / l.h, 16 / 9, 0.01), `${label}: 16:9 kept when shrinking`).toBe(true);
  }
  expect(l.w <= l.iw + 0.5 && l.h <= l.ih + 0.5, `${label}: fits the window`).toBe(true);
  expect(Math.abs(l.left - (l.iw - l.w) / 2) <= 1 && Math.abs(l.top - (l.ih - l.h) / 2) <= 1, `${label}: centred letterbox`).toBe(true);
  expect(parseFloat(l.worldW), `${label}: DOM overlay uses the same world rect`).toBeCloseTo(l.w, 1);
  return Math.round(s);
}

/**
 * Wait until the cursor-lead camera has come to rest (the rendered scroll is whole view pixels; while it is still
 * gliding, the aim of the last command was resolved with the previous frame's camera). Fails if it never settles
 * (that would be a visible 1-pixel shimmer at rest).
 */
async function settleCamera(page: Page): Promise<void> {
  let last = '';
  let stable = 0;
  for (let i = 0; i < 60 && stable < 5; i++) {
    const c = await api<{ x: number; y: number }>(page, 'worldToClient', 0, 0, 0);
    const s = `${c.x.toFixed(3)},${c.y.toFixed(3)}`;
    stable = s === last ? stable + 1 : 0;
    last = s;
    await page.waitForTimeout(150);
  }
  expect(stable, 'camera comes to rest with a still cursor').toBeGreaterThanOrEqual(5);
}

/**
 * Real cursor → sim aim point → projected back to client: must land on the pointer position the browser actually
 * delivered (≤ 1 CSS px). Firefox and WebKit deliver whole CSS pixels (floor of the requested fractional position),
 * Chromium keeps fractions; that quantisation is reported separately and bounded (< 1.5 px).
 */
async function aimRoundTrip(page: Page, cx: number, cy: number): Promise<number> {
  await page.evaluate(() => {
    const w = window as unknown as { __lastPtr?: { x: number; y: number }; __ptrHook?: boolean };
    if (w.__ptrHook) return;
    w.__ptrHook = true;
    window.addEventListener('pointermove', (e) => (w.__lastPtr = { x: e.clientX, y: e.clientY }), true);
  });
  await page.mouse.move(cx - 7, cy - 5);
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(300);
  await settleCamera(page);
  const r = await page.evaluate(() => {
    const w = window as unknown as { __lastPtr: { x: number; y: number }; __ASHEN_TEST__: Record<string, (...a: unknown[]) => unknown> };
    const t = w.__ASHEN_TEST__;
    const a = (t['player']!() as { aim: { targetX: number; targetY: number; targetZ: number } }).aim;
    return { back: t['worldToClient']!(a.targetX, a.targetY, a.targetZ) as { x: number; y: number }, ptr: w.__lastPtr };
  });
  expect(Math.hypot(r.ptr.x - cx, r.ptr.y - cy), 'browser pointer quantisation').toBeLessThan(1.5);
  return Math.hypot(r.back.x - r.ptr.x, r.back.y - r.ptr.y);
}

/** Share of scale×scale device-pixel blocks of the world canvas that are a single colour (nearest-neighbour). */
async function crispBlocks(page: Page, l: Layout, scale: number): Promise<{ uniform: number; total: number }> {
  const hide = await page.addStyleTag({ content: '#hud-layer,#ui-layer,#toast-layer,#world-overlay,.crosshair,.dir-arrow,.ring{visibility:hidden!important}' });
  await page.waitForTimeout(120);
  const png = await page.screenshot({ scale: 'device' });
  await hide.evaluate((el) => (el as Element).remove());
  const box = {
    x: Math.round(l.left * l.dpr) + scale * 96,
    y: Math.round(l.top * l.dpr) + scale * 54,
    w: scale * 448,
    h: scale * 252,
  };
  return page.evaluate(async ({ b64, box, scale }) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const cv = document.createElement('canvas');
    cv.width = bmp.width;
    cv.height = bmp.height;
    const g = cv.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(box.x, box.y, box.w, box.h).data;
    let uniform = 0;
    let total = 0;
    for (let by = 0; by + scale <= box.h; by += scale)
      for (let bx = 0; bx + scale <= box.w; bx += scale) {
        total++;
        const i0 = (by * box.w + bx) * 4;
        let ok = true;
        for (let yy = 0; yy < scale && ok; yy++)
          for (let xx = 0; xx < scale; xx++) {
            const i = ((by + yy) * box.w + bx + xx) * 4;
            if (d[i] !== d[i0] || d[i + 1] !== d[i0 + 1] || d[i + 2] !== d[i0 + 2]) {
              ok = false;
              break;
            }
          }
        if (ok) uniform++;
      }
    return { uniform, total };
  }, { b64: png.toString('base64'), box, scale });
}

async function dprPage(browser: Browser, dpr: number, width: number, height: number): Promise<{ page: Page; close: () => Promise<void>; errors: string[] }> {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(E2E);
  await page.waitForFunction(() => (window as unknown as { __BOOTED__?: boolean }).__BOOTED__ === true, null, { timeout: 30_000 });
  return { page, errors, close: () => ctx.close() };
}

test('@a21 DPR 1 / 1.25 / 1.5 / 2 and resizes: integer device-pixel world, centred letterbox, crisp pixels, cursor→world ≤ 1 px', async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const rows: string[] = [];
  for (const dpr of [1, 1.25, 1.5, 2]) {
    const { page, close, errors } = await dprPage(browser, dpr, 1280, 720);
    await newSlot(page, 1, `DPR ${dpr}`);
    await teleport(page, 32, 9);
    await page.waitForTimeout(400);
    const l = await layout(page);
    expect(l.dpr).toBeCloseTo(dpr, 5);
    const scale = checkLayout(l, `dpr ${dpr} 1280×720`);
    const crisp = await crispBlocks(page, l, scale);
    expect(crisp.uniform / crisp.total, `dpr ${dpr}: ${crisp.uniform}/${crisp.total} uniform ${scale}×${scale} blocks`).toBeGreaterThanOrEqual(0.999);
    const cx = l.left + l.w / 2;
    const cy = l.top + l.h / 2;
    let worst = 0;
    for (const [dx, dy] of [[160, -60], [-180, 40], [90, 120], [-60, -140], [240, 30]] as [number, number][]) worst = Math.max(worst, await aimRoundTrip(page, cx + dx, cy + dy));
    expect(worst, `dpr ${dpr}: cursor → aim → client error`).toBeLessThanOrEqual(1);
    await shot(page, testInfo.project.name, `a21-dpr-${String(dpr).replace('.', '_')}`);
    rows.push(`dpr ${dpr}: 1280×720 css → device ×${scale} (canvas ${l.w}×${l.h} css @ ${l.left},${l.top}), crisp ${crisp.uniform}/${crisp.total}, aim err ${worst.toFixed(3)}px`);

    // Window resizes at this DPR (incl. one smaller than 640×360 device pixels at DPR 1).
    for (const [w, h] of [[1000, 650], [1600, 900], [853, 480], [1366, 768], [600, 340]] as [number, number][]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(350);
      const lr = await layout(page);
      const sr = checkLayout(lr, `dpr ${dpr} ${w}×${h}`);
      const err = await aimRoundTrip(page, lr.left + lr.w * 0.7, lr.top + lr.h * 0.35);
      expect(err, `dpr ${dpr} ${w}×${h}: cursor → aim → client error`).toBeLessThanOrEqual(1);
      const ds = (lr.w * lr.dpr) / 640;
      rows.push(`  resize ${w}×${h}: device ×${Math.abs(ds - sr) < 0.01 ? sr : ds.toFixed(3)} canvas ${lr.w.toFixed(1)}×${lr.h.toFixed(1)} css @ ${lr.left},${lr.top}, aim err ${err.toFixed(3)}px`);
    }
    expect(errors).toEqual([]);
    await close();
  }
  console.log(`[A21] ${testInfo.project.name}\n${rows.join('\n')}`);
});

// ------------------------------------------------------------------------------------------ input release

test('@a21 input: held movement and held fire are released on window blur; firing needs a fresh press', async ({ page }) => {
  test.setTimeout(120_000);
  const info = await boot(page);
  await newSlot(page, 1, '입력 해제');
  await teleport(page, 30, 9);
  const px = async () => (await api<{ x: number }>(page, 'player')).x;
  await focusGame(page);
  const x0 = await px();
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(500);
  expect(await px(), 'walking right while D is held').toBeGreaterThan(x0 + 0.5);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(200);
  const xa = await px();
  await page.waitForTimeout(600);
  expect(Math.abs((await px()) - xa), 'no stuck key after blur (D still physically down)').toBeLessThan(0.02);
  await page.keyboard.up('KeyD');
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(400);
  expect(await px(), 'a fresh press moves again').toBeGreaterThan(xa + 0.3);
  await page.keyboard.up('KeyD');

  // Held automatic fire at the range.
  await openStation(page, 23, 16.0, 'panel-rack');
  await page.getByTestId('rack-ar556').click();
  await expect.poll(async () => (await api<{ defId: string } | null>(page, 'weapon'))?.defId).toBe('core.weapon.ar556');
  await closePanels(page);
  await teleport(page, 24.2, 18.6);
  const shots = async () => (await api<unknown[]>(page, 'shotLog', 1000)).length;
  const c = await api<{ x: number; y: number }>(page, 'worldToClient', 29, 17, 1.05);
  for (let i = 0; i < 6; i++) {
    const p = await api<{ x: number; y: number }>(page, 'worldToClient', 29, 17, 1.05);
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(90);
  }
  const s0 = await shots();
  await page.mouse.down({ button: 'left' });
  await page.waitForTimeout(350);
  expect(await shots(), 'automatic fire while held').toBeGreaterThan(s0);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(150);
  const s1 = await shots();
  await page.mouse.move(c.x + 3, c.y + 2); // chorded move with the button still held
  await page.waitForTimeout(600);
  expect(await shots(), 'held fire stops on blur and does not silently resume').toBe(s1);
  await page.mouse.up({ button: 'left' });
  await page.waitForTimeout(100);
  await page.mouse.down({ button: 'left' });
  await page.waitForTimeout(250);
  await page.mouse.up({ button: 'left' });
  await page.waitForTimeout(200);
  expect(await shots(), 'a fresh press fires again').toBeGreaterThan(s1);
  expect(info.errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------ audio unlock

interface AudioStatus {
  unlocked: boolean;
  failed: boolean;
  state: string | null;
  loops: string[];
  playCount: number;
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    if (h) {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    } else {
      delete (document as unknown as { hidden?: boolean }).hidden;
      delete (document as unknown as { visibilityState?: string }).visibilityState;
    }
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('@a21 audio: no AudioContext before the first gesture, unlock on first input, single loops across hide/show', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const info = await boot(page);
  const audio = () => api<AudioStatus>(page, 'audio');
  const a0 = await audio();
  expect(a0.unlocked, 'locked until a user gesture (autoplay policy)').toBe(false);
  expect(a0.state, 'no AudioContext created before the gesture').toBeNull();
  const hasWebAudio = await page.evaluate(() => typeof AudioContext !== 'undefined' || typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext !== 'undefined');
  if (!hasWebAudio) {
    // Playwright's Windows WebKit build ships without the Web Audio API: the game must degrade to silence cleanly.
    testInfo.annotations.push({ type: 'no-webaudio', description: `${testInfo.project.name}: AudioContext not available in this browser build` });
    await page.getByTestId('slot-name-1').click();
    await expect.poll(async () => (await audio()).failed).toBe(true);
    await page.getByTestId('slot-name-1').fill('무음');
    await page.getByTestId('slot-new-1').click();
    await skipTutorial(page);
    await page.waitForTimeout(500);
    const s = await audio();
    expect([s.unlocked, s.loops.length, s.playCount]).toEqual([false, 0, 0]);
    console.log(`[A21] ${testInfo.project.name} audio: Web Audio API absent in this build → silent fallback, no errors`);
    expect(info.errors).toEqual([]);
    return;
  }
  await page.getByTestId('slot-name-1').click(); // first gesture
  await expect.poll(async () => (await audio()).unlocked).toBe(true);
  const a1 = await audio();
  expect(a1.failed).toBe(false);
  await expect.poll(async () => (await audio()).state, { timeout: 5000 }).toBe('running');
  await page.getByTestId('slot-name-1').fill('소리');
  await page.getByTestId('slot-new-1').click();
  // The tutorial already runs the shelter ambience + music; skipping to the shelter keeps exactly those two loops.
  await waitMode(page, 'tutorial');
  await expect.poll(async () => (await audio()).loops.sort()).toEqual(['amb', 'music']);
  await skipTutorial(page);
  await expect.poll(async () => (await audio()).loops.sort()).toEqual(['amb', 'music']);

  // Hidden tab: context suspended, world clock stops; visible again: resumed with the same single loops.
  const time = async () => (await api<{ time: number }>(page, 'sim')).time;
  await setHidden(page, true);
  await expect.poll(async () => (await audio()).state).toBe('suspended');
  const t0 = await time();
  await page.waitForTimeout(700);
  expect(await time(), 'simulation time frozen while hidden').toBeCloseTo(t0, 6);
  await setHidden(page, false);
  await expect.poll(async () => (await audio()).state).toBe('running');
  await page.waitForTimeout(300);
  expect(await time(), 'simulation resumes when visible').toBeGreaterThan(t0);
  expect((await audio()).loops.sort()).toEqual(['amb', 'music']);

  // Base → raid → base swaps the ambience/music loops instead of stacking them.
  expect(await api<boolean>(page, 'setFlag', 'deploy_allowed')).toBe(true);
  await openStation(page, 32, 2.3, 'panel-deploy');
  await page.getByTestId('deploy-go').click();
  await waitMode(page, 'raid', 30_000);
  await api(page, 'setDebug', { god: true, freezeAI: true });
  await page.waitForTimeout(500);
  const raidLoops = (await audio()).loops.sort();
  expect(new Set(raidLoops).size).toBe(raidLoops.length);
  expect(raidLoops).toEqual(expect.arrayContaining(['amb']));
  const pc0 = (await audio()).playCount;
  await press(page, 'KeyR'); // a real sound-producing action (reload attempt / dry check)
  await page.waitForTimeout(600);
  expect((await audio()).playCount, 'sound events are actually played').toBeGreaterThan(pc0);
  console.log(`[A21] ${testInfo.project.name} audio: state ${a1.state ?? 'n/a'} → running; base loops amb+music; raid loops ${raidLoops.join('+')}`);
  expect(info.errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------ accessibility basics

test('@a21 accessibility: labelled dialogs, focus moves in and back, Tab/Shift+Tab trapped, keyboard activation, UI scale', async ({ page }) => {
  test.setTimeout(120_000);
  const info = await boot(page);
  const active = () => page.evaluate(() => {
    const ae = document.activeElement as HTMLElement | null;
    return { id: ae?.id ?? '', testid: ae?.dataset['testid'] ?? '', tag: ae?.tagName ?? '', inDialog: !!ae?.closest('[role="dialog"]'), text: (ae?.getAttribute('aria-label') ?? ae?.textContent ?? '').trim().slice(0, 30) };
  });
  const unnamed = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#ui-layer button, #ui-layer input, #ui-layer select')].filter((el) => el.getClientRects().length > 0 && !(el.getAttribute('aria-label') || el.textContent?.trim() || el.closest('label')?.textContent?.trim())).map((el) => el.outerHTML.slice(0, 80)));

  // Title: every control has an accessible name; Tab moves focus through the slot controls (not swallowed).
  expect(await unnamed()).toEqual([]);
  await page.getByTestId('slot-name-1').focus();
  const seen = new Set<string>();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    const a = await active();
    seen.add(`${a.tag}:${a.testid}:${a.text}`);
  }
  expect(seen.size, 'Tab walks through the title controls').toBeGreaterThanOrEqual(3);

  await newSlot(page, 1, '접근성');
  await expect(page.getByRole('progressbar', { name: '체력' })).toHaveAttribute('aria-valuenow', '100');
  await expect(page.getByRole('progressbar', { name: '스태미나' })).toBeVisible();

  // NPC dialog: role/aria, focus inside, tabs with one selected, Tab/Shift+Tab wrap inside the dialog.
  await talkTo(page, 'mechanic');
  const dlg = page.getByRole('dialog');
  await expect(dlg).toHaveAttribute('aria-modal', 'true');
  expect((await dlg.getAttribute('aria-label'))!.length).toBeGreaterThan(0);
  expect((await active()).inDialog, 'focus moved into the dialog').toBe(true);
  await expect(page.getByRole('tab', { selected: true })).toHaveCount(1);
  expect(await unnamed()).toEqual([]);
  const n = await page.evaluate(() => document.querySelectorAll('[role="dialog"] button:not([disabled])').length);
  const visited = new Set<string>();
  for (let i = 0; i < n + 3; i++) {
    await page.keyboard.press('Tab');
    const a = await active();
    expect(a.inDialog, `Tab #${i + 1} stays inside the dialog`).toBe(true);
    visited.add(`${a.testid}|${a.text}`);
  }
  expect(visited.size, 'Tab visits the dialog controls and wraps').toBeGreaterThanOrEqual(Math.min(n, 4));
  await page.keyboard.press('Shift+Tab');
  expect((await active()).inDialog).toBe(true);
  // Keyboard activation: focus the "구매" tab and press Enter.
  await page.getByTestId('tab-buy').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tab-buy')).toHaveAttribute('aria-selected', 'true');
  expect(await unnamed()).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect.poll(async () => (await active()).id, { message: 'focus returns to the game frame' }).toBe('game-frame');

  // Inventory: Shift+Tab navigates inside, plain Tab closes it (the key that opened it).
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('panel-stash')).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  expect((await active()).inDialog).toBe(true);
  await expect(page.getByTestId('panel-stash')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('panel-stash')).toHaveCount(0);

  // Settings from the pause menu: UI scale 125 % applies to the DOM UI; closing returns to the pause menu.
  await focusGame(page);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('panel-pause')).toBeVisible();
  await page.getByRole('button', { name: '설정' }).click();
  await page.getByTestId('tab-access').click();
  await page.getByTestId('ui-scale').selectOption('125');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim())).toBe('1.25');
  expect(await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize))).toBeCloseTo(17.5, 1);
  await page.getByTestId('ui-scale').selectOption('100');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('panel-pause'), 'settings return to the pause menu').toBeVisible();
  await page.getByTestId('resume').click();
  await expect(page.getByTestId('panel-pause')).toHaveCount(0);
  expect(await api<boolean>(page, 'paused')).toBe(false);
  expect(info.errors).toEqual([]);
});
