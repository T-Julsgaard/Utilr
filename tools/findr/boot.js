'use strict';

// findr's threads are started from source text, not from a file path:
// worker_threads can't load a script from inside utilr's app.asar, but the
// main process can read it. CODE is a tiny require() for findr's own files
// (handed over as workerData.srcs); everything else comes from Node.

const fs = require('fs');
const path = require('path');

const FILES = ['walk', 'engine', 'timing', 'worker', 'scan', 'watch'];

let cached = null;
const sources = () => cached || (cached = Object.fromEntries(
  FILES.map((f) => ['./' + f, fs.readFileSync(path.join(__dirname, f + '.js'), 'utf8')])));

const CODE = `'use strict';
const { workerData } = require('worker_threads');
const done = {};
function load(name) {
  const src = workerData.srcs[name];
  if (src === undefined) return require(name);
  if (!done[name]) {
    const module = { exports: {} };
    done[name] = module;
    new Function('module', 'exports', 'require', src + '\\n//# sourceURL=findr/' + name.slice(2) + '.js')(module, module.exports, load);
  }
  return done[name].exports;
}
load(workerData.entry);
`;

module.exports = { sources, CODE };
