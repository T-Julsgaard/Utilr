'use strict';

// measr's menu, in notr's words and rows. Built once here and used twice: as
// the right-click menu on the measuring overlay (with the copy commands on
// top), and standing on its own in the settings window (tray → settings).
(function (root) {
  const Keys = root.MeasrKeys;

  const CHOICES = {
    units: [
      { id: 'css', label: 'css px', hint: 'what you write in code' },
      { id: 'screen', label: 'screen px', hint: 'the real pixels' },
    ],
    format: [
      { id: 'plain', label: 'plain', hint: '240 × 48' },
      { id: 'css', label: 'css', hint: 'width: 240px' },
      { id: 'tailwind', label: 'tailwind', hint: 'w-60 h-12' },
    ],
    edges: [
      { id: 'exact', label: 'exact', hint: 'any change' },
      { id: 'soft', label: 'soft', hint: 'ignores noise' },
      { id: 'loose', label: 'loose', hint: 'strong lines only' },
    ],
    loupe: [
      { id: 'auto', label: 'auto', hint: 'when you hold still' },
      { id: 'always', label: 'always', hint: '' },
      { id: 'off', label: 'off', hint: '' },
    ],
  };
  const TITLES = { units: 'units', format: 'copy as', edges: 'edges', loupe: 'loupe' };
  const labelOf = (field, id) => (CHOICES[field].find((c) => c.id === id) || CHOICES[field][0]).label;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // el:        the .menu element
  // commands:  () => [{ act, label, value, disabled }] rows above the settings (overlay only)
  // footer:    () => same, below them
  // onCommand: (act) => a command row was picked
  // withKey:   show the "measure key" row (settings window)
  function create({ el, api, commands = null, footer = null, onCommand = () => {}, withKey = false }) {
    let S = null;
    let page = 'main';      // 'main' | a field of CHOICES
    let recording = false;  // a new measure key is being recorded
    let keyNote = null;     // { text, bad } shown in place of the key for a moment
    let noteTimer = null;
    let active = -1;        // keyboard row

    function row({ act, label, value = '', mark = '', cls = '', valueCls = '', disabled = false }) {
      return `<button class="mi ${cls}" role="menuitem" data-act="${esc(act)}"${disabled ? ' disabled' : ''}>` +
        `<span class="mi-l"><span class="mi-mark">${mark}</span><span>${esc(label)}</span></span>` +
        `<span class="mi-r ${valueCls}">${esc(value)}</span></button>`;
    }
    const sep = '<div class="sep"></div>';

    function keyRow() {
      const value = recording ? 'press keys…' : keyNote ? keyNote.text : Keys.label(S.key) + (S.keyOk ? '' : ' (taken)');
      const valueCls = recording ? 'rec' : (keyNote && keyNote.bad) || !S.keyOk ? 'bad' : '';
      return row({ act: 'key', label: 'measure key', value, valueCls });
    }

    function render() {
      if (!S) return;
      let html = '';
      if (page !== 'main') {
        html += row({ act: 'back', label: 'back', value: 'esc', mark: '‹' });
        html += sep;
        for (const c of CHOICES[page]) html += row({ act: page + ':' + c.id, label: c.label, value: c.hint, mark: S[page] === c.id ? '&gt;' : '' });
      } else {
        const cmds = commands ? commands() : [];
        for (const c of cmds) html += c === 'sep' ? sep : row(c);
        if (cmds.length) html += sep;
        if (withKey) html += keyRow() + sep;
        for (const f of Object.keys(CHOICES)) html += row({ act: f, label: TITLES[f], value: labelOf(f, S[f]) + ' ›' });
        html += sep;
        html += row({ act: 'hints', label: 'show hints', value: S.hints ? 'on' : 'off', mark: S.hints ? '&gt;' : '' });
        const foot = footer ? footer() : [];
        if (foot.length) html += sep;
        for (const c of foot) html += c === 'sep' ? sep : row(c);
      }
      el.innerHTML = html;
      paintActive();
    }

    const rows = () => [...el.querySelectorAll('.mi:not(:disabled)')];
    function paintActive() {
      const r = rows();
      r.forEach((b, i) => b.classList.toggle('active', i === active));
    }

    function note(text, bad) {
      clearTimeout(noteTimer);
      keyNote = { text, bad };
      render();
      noteTimer = setTimeout(() => { keyNote = null; render(); }, 1600);
    }

    function stopRecording() {
      if (!recording) return;
      recording = false;
      api.recordKey(false);
      render();
    }

    function go(p) { page = p; active = -1; render(); }

    function act(a) {
      if (a === 'back') { go('main'); return; }
      if (CHOICES[a]) { go(a); return; }
      const m = /^(\w+):(\w+)$/.exec(a);
      if (m && CHOICES[m[1]]) { api.setSettings({ [m[1]]: m[2] }); S = { ...S, [m[1]]: m[2] }; go('main'); return; }
      if (a === 'hints') { api.setSettings({ hints: !S.hints }); return; }
      if (a === 'key') {
        if (recording) { stopRecording(); return; }
        recording = true;
        api.recordKey(true);
        render();
        return;
      }
      onCommand(a);
    }

    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      if (recording && b.dataset.act !== 'key') stopRecording();
      act(b.dataset.act);
    });
    el.addEventListener('mousemove', (e) => {
      const b = e.target.closest('.mi');
      const i = b ? rows().indexOf(b) : -1;
      if (i !== active) { active = i; paintActive(); }
    });

    // returns true when the menu used the key
    function handleKey(e) {
      if (recording) {
        e.preventDefault();
        if (e.key === 'Escape') { stopRecording(); return true; }
        if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return true;
        const combo = Keys.normalize(Keys.fromEvent(e));
        recording = false;
        api.recordKey(false);
        if (!combo) { note('add ctrl or alt', true); return true; }
        if (combo === S.key) { render(); return true; }
        api.setSettings({ key: combo });
        return true;
      }
      const r = rows();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        active = active < 0 ? (d > 0 ? 0 : r.length - 1) : (active + d + r.length) % r.length;
        paintActive();
        return true;
      }
      if ((e.key === 'Enter' || e.key === 'ArrowRight') && active >= 0 && r[active]) {
        e.preventDefault();
        if (e.key === 'ArrowRight' && !CHOICES[r[active].dataset.act]) return true;
        act(r[active].dataset.act);
        return true;
      }
      if ((e.key === 'Escape' || e.key === 'ArrowLeft' || e.key === 'Backspace') && page !== 'main') { e.preventDefault(); go('main'); return true; }
      return false;
    }

    if (api.onKeyTaken) api.onKeyTaken((label, why) => note(why === 'another program has it' ? label + ' is taken' : why || label + ' is taken', true));

    return {
      set(settings) { S = settings; render(); },
      reset() { stopRecording(); page = 'main'; active = -1; render(); },
      render,
      handleKey,
      get page() { return page; },
    };
  }

  root.MeasrMenu = { create, CHOICES };
})(typeof self !== 'undefined' ? self : this);
