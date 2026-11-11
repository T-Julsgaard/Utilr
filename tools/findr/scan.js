'use strict';

// A scan thread: walks one root and posts what it finds in batches, then
// "done". One per root, so drives on different disks are read side by side.
// The engine thread put the root itself in as id 0; everything here is below it.

const { parentPort, workerData } = require('worker_threads');
const { walk } = require('./walk');

const t0 = Date.now();
const r = walk(workerData.root, {
  dirId: 0,
  nextId: 1,
  onBatch: (p) => parentPort.postMessage({ type: 'batch', ...p }, [p.parent.buffer, p.flags.buffer, p.depth.buffer]),
});
parentPort.postMessage({ type: 'done', ...r, ms: Date.now() - t0 });
