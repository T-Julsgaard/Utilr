'use strict';

// One registry for every system-wide shortcut in utilr: the launcher's own
// keys and every tool's. All tools live in one process, so a key one tool
// holds must never be quietly taken over by another; the registry says no
// and names the owner instead.
//
// Tools never touch Electron's globalShortcut. They get scoped(id), which
// looks the same (register / unregister / unregisterAll / isRegistered), so
// their code didn't have to change.

const { globalShortcut } = require('electron');

const held = new Map(); // accelerator -> { owner, fn }
let suspended = false;  // while a key is being recorded, nothing may fire
let onChange = () => {};

const norm = (accel) => String(accel || '').toLowerCase();

function register(owner, accel, fn) {
  const k = norm(accel);
  if (!k) return false;
  const cur = held.get(k);
  if (cur && cur.owner !== owner) return false; // another tool has it
  if (cur) { try { globalShortcut.unregister(accel); } catch (_) {} }
  if (!suspended) {
    let ok = false;
    try { ok = globalShortcut.register(accel, fn); } catch (_) { ok = false; }
    if (!ok) { held.delete(k); onChange(); return false; } // another program has it
  }
  held.set(k, { owner, fn, accel });
  onChange();
  return true;
}

function unregister(owner, accel) {
  const k = norm(accel);
  const cur = held.get(k);
  if (!cur || cur.owner !== owner) return;
  held.delete(k);
  if (!suspended) { try { globalShortcut.unregister(cur.accel); } catch (_) {} }
  onChange();
}

function unregisterOwner(owner) {
  for (const cur of [...held.values()]) if (cur.owner === owner) unregister(owner, cur.accel);
}

// The owner of an accelerator, or null.
const ownerOf = (accel) => (held.get(norm(accel)) || {}).owner || null;

// Recording a new key: every shortcut goes quiet, so pressing the old combo
// records it instead of opening something. Then they all come back.
function suspend(on) {
  on = !!on;
  if (on === suspended) return;
  suspended = on;
  if (on) {
    for (const cur of held.values()) { try { globalShortcut.unregister(cur.accel); } catch (_) {} }
  } else {
    for (const cur of held.values()) { try { globalShortcut.register(cur.accel, cur.fn); } catch (_) {} }
  }
}

// What a tool sees in place of Electron's globalShortcut.
function scoped(owner) {
  return {
    register: (accel, fn) => register(owner, accel, fn),
    unregister: (accel) => unregister(owner, accel),
    unregisterAll: () => unregisterOwner(owner),
    isRegistered: (accel) => ownerOf(accel) === owner,
  };
}

module.exports = {
  register, unregister, unregisterOwner, ownerOf, suspend, scoped,
  isSuspended: () => suspended,
  onChange: (fn) => { onChange = fn; },
  releaseAll: () => { held.clear(); globalShortcut.unregisterAll(); },
};
