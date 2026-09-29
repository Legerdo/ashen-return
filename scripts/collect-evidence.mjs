// Copies the durable part of a verification run into ProjectState/evidence/ (test-results/ is gitignored and transient):
// unit test summary, E2E summary per project/test, the A22 performance report and representative screenshots.
// Usage: node scripts/collect-evidence.mjs   (run after `npm run test` and `npm run test:e2e`)
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve('ProjectState/evidence');
fs.mkdirSync(path.join(out, 'screens'), { recursive: true });
const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
const written = [];

// --- unit / simulation tests (vitest json reporter) ---------------------------------------------------------------
const unit = readJson('test-results/unit-results.json');
if (unit) {
  const files = unit.testResults.map((f) => ({
    file: path.relative(process.cwd(), f.name).replaceAll('\\', '/'),
    tests: f.assertionResults.length,
    passed: f.assertionResults.filter((a) => a.status === 'passed').length,
  }));
  const summary = { when: new Date(unit.startTime).toISOString(), total: unit.numTotalTests, passed: unit.numPassedTests, failed: unit.numFailedTests, files };
  fs.writeFileSync(path.join(out, 'unit-summary.json'), JSON.stringify(summary, null, 2));
  written.push(`unit-summary.json (${summary.passed}/${summary.total})`);
}

// --- E2E (playwright json reporter) ---------------------------------------------------------------------------------
const e2e = readJson('test-results/e2e-results.json');
if (e2e) {
  const rows = [];
  const walk = (suite, file) => {
    const f = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.[t.results.length - 1];
        rows.push({ project: t.projectName, file: f, title: spec.title, status: last?.status ?? t.status, durationMs: last?.duration ?? null, annotations: (t.annotations ?? []).map((a) => `${a.type}: ${a.description ?? ''}`) });
      }
    }
    for (const s of suite.suites ?? []) walk(s, f);
  };
  for (const s of e2e.suites ?? []) walk(s, s.file);
  const byProject = {};
  for (const r of rows) {
    byProject[r.project] ??= { passed: 0, failed: 0, skipped: 0 };
    byProject[r.project][r.status === 'passed' ? 'passed' : r.status === 'skipped' ? 'skipped' : 'failed']++;
  }
  const summary = { when: e2e.stats?.startTime ?? new Date().toISOString(), durationSec: Math.round((e2e.stats?.duration ?? 0) / 1000), stats: e2e.stats, byProject, tests: rows };
  fs.writeFileSync(path.join(out, 'e2e-summary.json'), JSON.stringify(summary, null, 2));
  written.push(`e2e-summary.json (${rows.filter((r) => r.status === 'passed').length}/${rows.length} passed)`);
}

// --- A22 performance --------------------------------------------------------------------------------------------------
if (fs.existsSync('test-results/perf-a22.json')) {
  fs.copyFileSync('test-results/perf-a22.json', path.join(out, 'perf-a22.json'));
  written.push('perf-a22.json');
}

// --- representative screenshots (VisualVerified scenes) ---------------------------------------------------------------
const SCREENS = [
  'chromium-p0-01-base.png',
  'chromium-p0-02b-report-guide.png',
  'chromium-p0-05-fight.png',
  'chromium-p0-06-loot.png',
  'chromium-p0-08-resumed.png',
  'chromium-p0-09-summary.png',
  'chromium-inv-01-filter.png',
  'chromium-inv-02-compare.png',
  'chromium-inv-03-sorted.png',
  'chromium-a21-korean-raid-pause.png',
  'chromium-a21-dpr-1_25.png',
  'chromium-p1-01-raid1.png',
  'chromium-p1-02-note.png',
  'chromium-p1-03-perk.png',
  'chromium-p1-04-outer.png',
  'chromium-p1-05-workbench.png',
  'chromium-p1-07-market.png',
  'chromium-p1-08-boss.png',
  'chromium-p1-09-cipher.png',
  'chromium-p1-10-epilogue.png',
  'chromium-range-sgp-fire.png',
  'chromium-range-debug-overlay.png',
  'chromium-range-terminal.png',
  'chromium-a22-load-1080p.png',
  'chromium-p0-02c-q05-zone.png',
  'chromium-tutorial-01-move.png',
  'chromium-tutorial-01b-dodge.png',
  'chromium-tutorial-02-loot.png',
  'chromium-tutorial-04-ads.png',
  'chromium-tutorial-05-melee.png',
  'chromium-tutorial-06-throw-preview.png',
  'chromium-tutorial-07-shelter.png',
  'firefox-p1-08-boss.png',
  'firefox-tutorial-05-melee.png',
  'webkit-smoke-02-raid.png',
  'webkit-static-01-tutorial.png',
  'webkit-static-02-restored.png',
];
let copied = 0;
for (const s of SCREENS) {
  const src = path.join('test-results/screens', s);
  if (!fs.existsSync(src)) continue;
  fs.copyFileSync(src, path.join(out, 'screens', s));
  copied++;
}
written.push(`screens/ (${copied}/${SCREENS.length})`);
console.log(`[evidence] ProjectState/evidence ← ${written.join(', ')}`);
