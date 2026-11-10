'use strict';
// Runs every end-to-end test: npm test
//   1. smoke phase 1: drive the app with a throwaway data folder
//   2. smoke phase 2: relaunch and check everything came back
//   3. scroll test: the view follows the caret
//   4. saved notes: save, close, reopen, restart
const { spawnSync } = require('child_process');
const electron = require('electron'); // path to the Electron binary

const runs = [
  ['smoke, phase 1', ['scripts/smoke.js', 'smoke-out'], { NOTR_PHASE: '1' }],
  ['smoke, phase 2', ['scripts/smoke.js', 'smoke-out'], { NOTR_PHASE: '2' }],
  ['scroll', ['scripts/scroll-test.js', 'scroll-out'], {}],
  ['saved notes, phase 1', ['scripts/save-test.js', 'save-out'], { NOTR_PHASE: '1' }],
  ['saved notes, phase 2', ['scripts/save-test.js', 'save-out'], { NOTR_PHASE: '2' }],
];

let failed = 0;
for (const [name, args, env] of runs) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(electron, args, { stdio: 'inherit', env: { ...process.env, ...env }, timeout: 180000 });
  if (r.status !== 0) { failed++; console.log(`=== ${name}: FAILED ===`); }
}
console.log(failed ? `\n${failed} test run(s) failed` : '\nall tests passed');
process.exit(failed ? 1 : 0);
