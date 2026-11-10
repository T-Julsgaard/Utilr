// Keyboard shortcut helpers, shared by the main process (require) and the
// note window (<script>). A shortcut is stored as a lowercase combo string
// like "ctrl+alt+n": modifiers in a fixed order, then one key.
(function (root) {
  'use strict';

  const ACTIONS = ['add', 'del', 'open'];
  const LABELS = { add: 'add note', del: 'delete note', open: 'open notr' };
  const DEFAULTS = { add: 'ctrl+s', del: 'ctrl+d', open: 'ctrl+n' };

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
  };

  // "Ctrl + Alt + N" -> "ctrl+alt+n"; null if it isn't a usable shortcut.
  // Needs ctrl, alt or win so plain typing can never trigger it.
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
    if (!key || !(mods.has('ctrl') || mods.has('alt') || mods.has('win'))) return null;
    return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
  }

  // "ctrl+alt+n" -> Electron accelerator "Control+Alt+N"
  function toAccelerator(combo) {
    const map = {
      ctrl: 'Control', alt: 'Alt', shift: 'Shift', win: 'Super',
      up: 'Up', down: 'Down', left: 'Left', right: 'Right', space: 'Space',
      home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert', delete: 'Delete',
    };
    return combo.split('+').map((p) => map[p] || p.toUpperCase()).join('+');
  }

  // KeyboardEvent -> combo string (uses physical keys, so any layout works)
  function fromEvent(e) {
    const c = e.code || '';
    let key = null, m;
    if ((m = /^Key([A-Z])$/.exec(c))) key = m[1].toLowerCase();
    else if ((m = /^Digit(\d)$/.exec(c))) key = m[1];
    else if ((m = /^F(\d{1,2})$/.exec(c))) key = 'f' + m[1];
    else if ((m = /^Arrow(Up|Down|Left|Right)$/.exec(c))) key = m[1].toLowerCase();
    else if (['Space', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete'].includes(c)) key = c.toLowerCase();
    if (!key) return null;
    const mods = [];
    if (e.ctrlKey) mods.push('ctrl');
    if (e.altKey) mods.push('alt');
    if (e.shiftKey) mods.push('shift');
    if (e.metaKey) mods.push('win');
    return [...mods, key].join('+');
  }

  // Lines like "open notr [ctrl+n]" in a note's text.
  function parseLines(text) {
    const found = [];
    const re = /^\s*(add note|delete note|open notr)\s*\[\s*([^\]\n]*?)\s*\]\s*$/gim;
    let m;
    while ((m = re.exec(text))) {
      const action = ACTIONS.find((a) => LABELS[a] === m[1].toLowerCase());
      found.push({ action, raw: m[2], combo: normalize(m[2]) });
    }
    return found;
  }

  const api = { ACTIONS, LABELS, DEFAULTS, normalize, toAccelerator, fromEvent, parseLines };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NotrKeys = api;
})(typeof self !== 'undefined' ? self : this);
