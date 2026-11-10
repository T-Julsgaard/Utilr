'use strict';

// The settings menu, in notr's words and rows. Built once here and used twice:
// as a drop-down under a snip's gear, and standing on its own in the settings
// window (tray → settings).
(function (root) {
  const Keys = root.SniprKeys;
  const { FONTS } = root.SniprFonts;

  const INKS = [
    { id: 'ghost', label: 'ghost', sw: '#ffffff' },
    { id: 'red', label: 'red', sw: '#ff7a6b' },
    { id: 'black', label: 'black', sw: '#111111' },
  ];

  const BORDERS = [
    { px: 0, label: 'none' },
    { px: 12, label: 'small' },
    { px: 24, label: 'medium' },
    { px: 48, label: 'large' },
  ];
  const borderLabel = (px) => (BORDERS.find((b) => b.px === px) || BORDERS[0]).label;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function create({ el, api, inline = false, onClose = () => {} }) {
    let S = null;
    let page = 'main';      // 'main' | 'ink' | 'border' | 'font'
    let recording = null;   // 'key' | 'textKey' while a new shortcut is being recorded
    let keyNote = null;     // { field, text, bad } shown in place of the key for a moment
    let noteTimer = null;

    const loginLabel = () => (S && S.platform === 'win32' ? 'start with windows' : 'start at login');

    function row({ act, label, value = '', mark = '', cls = '', sw = '', valueCls = '', disabled = false, font = '' }) {
      const look = font ? ` style="font-family:'${esc(font)}', monospace"` : '';
      return `<button class="mi ${cls}" role="menuitem" data-act="${esc(act)}"${disabled ? ' disabled' : ''}>` +
        `<span class="mi-l"><span class="mi-mark">${mark}</span><span${look}>${esc(label)}</span>${sw ? `<span class="sw" style="background:${sw}"></span>` : ''}</span>` +
        `<span class="mi-r ${valueCls}">${esc(value)}</span></button>`;
    }
    const toggle = (act, label, on) => row({ act, label, value: on ? 'on' : 'off', mark: on ? '&gt;' : '' });
    // a shortcut row: click, then press the new keys
    function keyRow(field, label) {
      const ok = field === 'key' ? S.keyOk : S.textKeyOk;
      const n = keyNote && keyNote.field === field ? keyNote : null;
      const value = recording === field ? 'press keys…' : n ? n.text : Keys.label(S[field]) + (ok ? '' : ' (taken)');
      const valueCls = recording === field ? 'rec' : (n && n.bad) || !ok ? 'bad' : '';
      return row({ act: field, label, value, valueCls });
    }
    const sep = '<div class="sep"></div>';

    function render() {
      if (!S) return;
      let html = '';
      if (page === 'ink') {
        html += row({ act: 'back', label: 'back', value: 'esc', mark: '‹' });
        html += sep;
        for (const ink of INKS) html += row({ act: 'ink:' + ink.id, label: ink.label, mark: S.ink === ink.id ? '&gt;' : '', sw: ink.sw });
      } else if (page === 'border') {
        html += row({ act: 'back', label: 'back', value: 'esc', mark: '‹' });
        html += sep;
        for (const b of BORDERS) html += row({ act: 'border:' + b.px, label: b.label, value: b.px ? b.px + 'px' : '', mark: S.border === b.px ? '&gt;' : '' });
      } else if (page === 'font') {
        html += row({ act: 'back', label: 'back', value: 'esc', mark: '‹' });
        html += sep;
        for (const f of FONTS) html += row({ act: 'font:' + f, label: f.toLowerCase(), mark: S.font === f ? '&gt;' : '', font: f });
      } else {
        html += toggle('copy', 'auto copy to clipboard', S.copy);
        html += toggle('open', 'auto open', S.open);
        html += toggle('autoSave', 'auto save', S.autoSave);
        html += toggle('closeAfterCopy', 'close after copy', S.closeAfterCopy);
        html += sep;
        html += row({ act: 'folder', label: 'folder', value: S.folder });
        html += row({ act: 'ink', label: 'ink', value: S.ink + ' ›' });
        html += row({ act: 'font', label: 'font', value: S.font.toLowerCase() + ' ›' });
        html += row({ act: 'border', label: 'border', value: borderLabel(S.border) + ' ›' });
        html += keyRow('key', 'snip key');
        if (S.ocr) html += keyRow('textKey', 'text key');
        html += sep;
        html += toggle('onTop', 'keep snips on top', S.onTop);
        html += toggle('confirmDiscard', 'ask before discard', S.confirmDiscard);
        if (!S.hosted) html += toggle('startup', loginLabel(), S.startup); // in utilr: utilr's setting
        html += sep;
        html += row({ act: 'openFolder', label: 'open folder' });
        if (!S.hosted) html += row({ act: 'quit', label: 'quit snipr' }); // in utilr: quit from utilr's tray
      }
      el.innerHTML = html;
      // the folder can be long: keep its end, which is the part that matters
      const f = el.querySelector('[data-act="folder"] .mi-r');
      if (f) {
        f.textContent = '‎' + S.folder + '‎'; // keep "~\" in front under rtl
        Object.assign(f.style, { direction: 'rtl', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '17ch' });
        f.title = S.folder;
      }
    }

    function note(field, text, bad) {
      clearTimeout(noteTimer);
      keyNote = { field, text, bad };
      render();
      noteTimer = setTimeout(() => { keyNote = null; render(); }, 1600);
    }

    function stopRecording() {
      if (!recording) return;
      recording = null;
      api.recordKey(false);
      render();
    }

    async function act(a) {
      if (a === 'back') { page = 'main'; render(); return; }
      if (a === 'ink') { page = 'ink'; render(); return; }
      if (a.startsWith('ink:')) { api.setSettings({ ink: a.slice(4) }); page = 'main'; return; }
      if (a === 'border') { page = 'border'; render(); return; }
      if (a.startsWith('border:')) { api.setSettings({ border: Number(a.slice(7)) }); page = 'main'; return; }
      if (a === 'font') { page = 'font'; render(); return; }
      if (a.startsWith('font:')) { api.setSettings({ font: a.slice(5) }); page = 'main'; return; }
      if (['copy', 'open', 'autoSave', 'closeAfterCopy', 'onTop', 'confirmDiscard', 'startup'].includes(a)) {
        api.setSettings({ [a]: !S[a] });
        return;
      }
      if (a === 'folder') { await api.chooseFolder(); return; }
      if (a === 'key' || a === 'textKey') {
        if (recording === a) { stopRecording(); return; }
        if (!recording) api.recordKey(true);
        recording = a;
        render();
        return;
      }
      if (a === 'openFolder') { api.openFolder(); onClose(); return; }
      if (a === 'quit') { api.quit(); }
    }

    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      if (recording && b.dataset.act !== 'key' && b.dataset.act !== 'textKey') stopRecording();
      act(b.dataset.act);
    });
    if (!inline) el.addEventListener('mousedown', (e) => e.preventDefault());

    // returns true when the menu used the key
    function handleKey(e) {
      if (recording) {
        e.preventDefault();
        if (e.key === 'Escape') { stopRecording(); return true; }
        if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return true;
        const combo = Keys.normalize(Keys.fromEvent(e));
        const field = recording;
        recording = null;
        api.recordKey(false);
        if (!combo) { note(field, 'add ctrl or alt', true); return true; }
        if (combo === S[field]) { render(); return true; }
        api.setSettings({ [field]: combo });
        return true;
      }
      if (e.key === 'Escape' && page !== 'main') { e.preventDefault(); page = 'main'; render(); return true; }
      return false;
    }

    api.onKeyTaken((label, field) => note(field || 'key', label + ' is taken', true));

    return {
      set(settings) { S = settings; render(); },
      reset() { stopRecording(); page = 'main'; render(); },
      handleKey,
      get recording() { return recording; },
    };
  }

  root.SniprMenu = { create };
})(typeof self !== 'undefined' ? self : this);
