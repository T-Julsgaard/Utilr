'use strict';
// npm test: starts snipr with a throwaway data folder and lets
// scripts/smoke-run.js drive the real windows (capture → select → snip →
// marks → copy/save → settings). Screenshots of every surface go to smoke-out/.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const out = path.join(root, 'smoke-out');
fs.mkdirSync(out, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'snipr-smoke-'));

const electron = require('electron'); // path to the binary when required from node
const child = spawn(electron, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, SNIPR_USER_DATA: data, SNIPR_SMOKE: path.join(__dirname, 'smoke-run.js'), SNIPR_SMOKE_OUT: out },
});
child.on('exit', (code) => {
  try { fs.rmSync(data, { recursive: true, force: true }); } catch (_) {}
  process.exit(code || 0);
});
