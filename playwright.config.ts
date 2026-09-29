import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against production-style static builds served by a plain static file server
 * (scripts/static-server.mjs) — no dev server, no backend.
 *  - dist-e2e (port 4181): production build + test hooks (mode=e2e) for scripted play-throughs.
 *  - dist     (port 4180): the real release build (no hooks) for A24 static-host verification.
 */
export default defineConfig({
  testDir: 'e2e',
  // Playwright wipes its output dir on every run; keep it apart from the unit report, screens and perf results.
  outputDir: 'test-results/playwright',
  timeout: 600_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4181',
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: [
    {
      command: 'npm run build:e2e && node scripts/static-server.mjs dist-e2e 4181',
      url: 'http://127.0.0.1:4181/index.html',
      reuseExistingServer: true,
      timeout: 240_000,
    },
    {
      command: 'npm run build && node scripts/static-server.mjs dist 4180',
      url: 'http://127.0.0.1:4180/index.html',
      reuseExistingServer: true,
      timeout: 240_000,
    },
  ],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, grep: /@p0|@p1|@smoke|@static|@a21/ },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, grep: /@smoke|@static|@a21/ },
  ],
});
