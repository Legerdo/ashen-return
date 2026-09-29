// Full verification pipeline: typecheck → unit/simulation tests → production build → E2E (Chromium/Firefox/WebKit smoke).
// Each stage is reported separately; a failure stops the pipeline with a non-zero exit code.
import { spawnSync } from 'node:child_process';

const stages = [
  ['typecheck', 'npm run typecheck'],
  ['unit+simulation tests', 'npm run test'],
  ['production build', 'npm run build'],
  ['e2e (playwright: chromium all, firefox p0/p1/smoke/static/a21, webkit smoke/static/a21, perf)', 'npm run test:e2e'],
  ['evidence snapshot → ProjectState/evidence', 'node scripts/collect-evidence.mjs'],
];

const results = [];
for (const [name, cmd] of stages) {
  const started = Date.now();
  console.log(`\n=== [verify] ${name}: ${cmd}`);
  const r = spawnSync(cmd, { stdio: 'inherit', shell: true });
  const ok = r.status === 0;
  results.push({ name, ok, seconds: ((Date.now() - started) / 1000).toFixed(1) });
  if (!ok) break;
}

console.log('\n=== [verify] summary');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.seconds}s)`);
const allOk = results.length === stages.length && results.every((r) => r.ok);
process.exit(allOk ? 0 : 1);
