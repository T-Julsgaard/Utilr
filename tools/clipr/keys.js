// Keyboard shortcut helpers, shared by the main process (require) and the
// windows (<script>). A shortcut is stored as a lowercase combo string like
// "alt+shift+v": modifiers in a fixed order, then one key. Same format as notr, snipr and utilr.
(function (root) {
  'use strict';

  const DEFAULT = 'alt+shift+v'; // v for paste

  const MOD_ALIASES = {
    ctrl: 'ctrl', control: 'ctrl', ctl: 'ctrl', strg: 'ctrl',
    alt: 'alt', option: 'alt',
    shift: 'shift',
    win: 'win', super: 'win', meta: 'win', cmd: 'win',
  };
  const MOD_ORDER = ['ctrl', 'alt', 'shift', 'win'];
  const NAMED = {
    up: 'up', down: 'down', left: 'left', right: 'right', space: 'space',
    home: 'home', end: 'end', pageup: 'pageup', pgup: 'pageup', pagedown: 'pagedown', pgdn: 'pagedown',
    insert: 'insert', ins: 'insert', delete: 'delete', del: 'delete',
    printscreen: 'printscreen', prtsc: 'printscreen', print: 'printscreen',
  };

  // "Alt + Shift + V" -> "alt+shift+v"; null if it isn't a usable shortcut.
  // Needs ctrl, alt or win so plain typing can never trigger it; the one
  // exception is the print screen key, which is fine on its own.
  function normalize(text) {
    const parts = String(text || '').toLowerCase().split('+').map((s) => s.trim());
    if (!parts.length || parts.some((p) => !p)) return null;
    const mods = new Set();
    let key = null;
    for (const p of parts) {
      if (MOD_ALIASES[p]) { mods.add(MOD_ALIASES[p]); continue; }
      if (key) return null;
      if (/^[a-z0-9]$/.test(p) || /^f([1-9]|1[0-9]|2[0-4])$/.test(p)) key = p;
      else if (NAMED[p]) key = NAMED[p];
      else return null;
    }
    if (!key) return null;
    const fkey = /^f\d+$/.test(key);
    if (key !== 'printscreen' && !fkey && !(mods.has('ctrl') || mods.has('alt') || mods.has('win'))) return null;
    return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
  }

  // "alt+shift+v" -> Electron accelerator "Alt+Shift+V"
  function toAccelerator(combo) {
    const map = {
      ctrl: 'Control', alt: 'Alt', shift: 'Shift', win: 'Super',
      up: 'Up', down: 'Down', left: 'Left', right: 'Right', space: 'Space',
      home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert', delete: 'Delete',
      printscreen: 'PrintScreen',
    };
    return combo.split('+').map((p) => map[p] || p.toUpperCase()).join('+');
  }

  // KeyboardEvent -> combo string (physical keys, so any layout works)
  function fromEvent(e) {
    const c = e.code || '';
    let key = null, m;
    if ((m = /^Key([A-Z])$/.exec(c))) key = m[1].toLowerCase();
    else if ((m = /^Digit(\d)$/.exec(c))) key = m[1];
    else if ((m = /^F(\d{1,2})$/.exec(c))) key = 'f' + m[1];
    else if ((m = /^Arrow(Up|Down|Left|Right)$/.exec(c))) key = m[1].toLowerCase();
    else if (['Space', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete'].includes(c)) key = c.toLowerCase();
    else if (c === 'PrintScreen') key = 'printscreen';
    if (!key) return null;
    const mods = [];
    if (e.ctrlKey) mods.push('ctrl');
    if (e.altKey) mods.push('alt');
    if (e.shiftKey) mods.push('shift');
    if (e.metaKey) mods.push('win');
    return [...mods, key].join('+');
  }

  // How a combo reads in the UI: "alt+shift+v", "prt sc", on a Mac "⌥⇧s" stays plain text.
  function label(combo) {
    return String(combo || '').replace('printscreen', 'prt sc');
  }

  const api = { DEFAULT, normalize, toAccelerator, fromEvent, label };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CliprKeys = api;
})(typeof self !== 'undefined' ? self : this);
