'use strict';

// When findr reads a drive again, and how long it waits. Shared by the main
// process (which wakes the index up for a scan while it's put away) and the
// index thread (worker.js).

module.exports = {
  RESCAN_EVERY: 6 * 60 * 60 * 1000,
  FRESH: 10 * 60 * 1000,          // a cache younger than this isn't read again at once
  AFTER_CACHE: 20 * 1000,         // otherwise: a fresh scan this long after start
  MAX_DIRTY: 20000,               // more changed folders than this at once: read it all again
  QUIET_AFTER: 2 * 60 * 1000,     // Windows losing track during or just after a scan is the scan itself
  LOST_EVERY: 15 * 60 * 1000,     // read again for that at most this often
  LOST_WAIT: 60 * 1000,           // and not sooner than this after it happened
};
