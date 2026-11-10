# Prompt: build a new utilr tool

Copy everything below the line into a new session, opened in
`C:\Users\T_J\Documents\GitHub\Utilr`. Fill in the two fields at the top first.

---

I want you to build a new tool for **utilr**, my launcher that hosts all my small desktop tools.

**Tool name:** `<lowercase name ending in r, like notr / snipr>`
**What it does:** `<describe the tool here>`

Below is what you need to know about utilr, how a tool plugs into it, and the style it has to
follow. Read it fully before you start.

## 1. What utilr is

- utilr (`C:\Users\T_J\Documents\GitHub\Utilr`, public repo `T-Julsgaard/Utilr`) is one
  Electron app with **one tray icon and one process** that hosts every tool. I plan for roughly
  8–10 tools in total. The user installs utilr once, then installs each tool from inside it.
- The launcher (`src/`) gives every tool the same things: a row on the *tools* page
  (install / open / actions / remove), a tile in the **quick view** (a narrow column of square
  tiles on `alt+shift+space`), a submenu in the tray, and its keys on the *keys* page.
- Two tools already exist and are your reference implementations. **Study them before writing
  anything:**
  - `tools/notr/`: always-on-top notes (windows that persist, settings menu, saved state).
  - `tools/snipr/`: screenshots (pre-warmed hidden windows, a settings window, a toast).
  - Their READMEs (`tools/*/README.md`) say exactly what was changed to make them hosted tools.
  - Also read `README.md`, `src/host.js` (the contract), `src/shortcuts.js` (key registry) and
    `src/main.js` (how utilr calls tools).

## 2. Keep the tool segmented

- Everything the tool needs lives in **its own folder**, `tools/<id>/`: its code, its HTML/CSS,
  its preload, its own copy of the ghost theme (copy `src/theme/` or `tools/snipr/theme/`), its
  fonts and its assets. **Don't import code from another tool or from `src/`**, and don't edit
  other tools or the launcher unless the contract really needs a change (if so, tell me why first).
- The tool's data goes in `host.dataDir` (`%APPDATA%\utilr\tools\<id>`), never
  `app.getPath('userData')`. Files the user makes (images, exports) can go to a normal user
  folder, like snipr does with `Pictures\snipr`.
- Write `tools/<id>/README.md`: what it does, its keys, and anything that's special about it.

## 3. The tool contract

`tools/<id>/tool.json`:

```json
{
  "id": "<id>",
  "name": "<id>",
  "version": "1.0.0",
  "description": "<lowercase, under ~36 characters, fits on one line>",
  "main": "main.js",
  "glyph": "glyph.svg",
  "order": 3,
  "platforms": ["win32", "darwin", "linux"]
}
```

`platforms` is optional: leave it out if the tool runs everywhere, or list only the platforms it
supports. `order` sets its position in lists; use the next free number.

`tools/<id>/main.js` exports one function. utilr calls it on install and on every start:

```js
module.exports = function mytool(host) {
  // host.id, host.name, host.version, host.dir, host.dataDir
  // host.ipc        like ipcMain (on / once / handle / removeHandler / removeAllListeners),
  //                 but every channel is really "<id>/<channel>"
  // host.shortcuts  like globalShortcut (register / unregister / unregisterAll / isRegistered),
  //                 shared fairly: register() returns false if another tool or program has it
  // host.log(msg)   a line in utilr's log, prefixed with the tool id
  // host.changed()  call when your actions or keys change, so the launcher and tray refresh
  return {
    start() {},  // load settings, register keys, pre-warm windows if needed. Show NO UI.
    stop() {},   // save now, destroy every window, unregister every key, clear timers and
                 // screen listeners. Called on remove and when utilr quits.
    open() {},   // the main action: quick view tile, tray click, launcher row click
    actions: () => [{ id, label, key, run }],   // tray submenu + launcher; `key` = id of a key
    keys: () => [{ id, label, combo, ok }],     // its system-wide keys; ok = actually registered
    setKey(id, combo) { return { ok: true } },  // or { ok: false, error: 'lowercase reason' }
  };
};
```

Rules for a hosted tool (both existing tools follow them, so copy their patterns):

- **No** tray, app menu, login item, `requestSingleInstanceLock`, `app.whenReady`, `app.quit`,
  `before-quit`/`window-all-closed` handlers, or `setAppUserModelId`. utilr owns all of those.
- **Never** use `ipcMain` or `globalShortcut` directly: use `host.ipc` / `host.shortcuts`. The
  tool's `preload.js` sends and invokes on `'<id>/<channel>'`. Main-to-window messages stay plain,
  but only send them to **your own windows** (keep a list; see `ownWindows()` in snipr).
  Never use `BrowserWindow.getAllWindows()` to broadcast.
- Windows: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a deny-all
  `setWindowOpenHandler`, block `will-navigate`, and the strict CSP the other tools use.
- Anything that shows on screen after `open()` must not catch utilr's own windows: utilr already
  hides the quick view / launcher first (and the tray waits 180 ms), so just act when called.
- If the tool has its own settings UI, include `hosted: true` in what it sends to its windows
  and hide any "start with windows" or "quit" rows when `hosted` is true. utilr handles both.
- `tools/<id>/glyph.svg`: the tool's mark on a 24×24 viewBox, `fill="currentColor"` (or
  `stroke="currentColor"`), about 2 units thick, geometric and blocky like the others (notr is
  `_▌`, snipr is two crop corners). It shows in the quick view tiles, the launcher and the tray.
  It must read at 11 px.

## 4. Keys

- Combo format (same as everywhere in utilr): lowercase, modifiers in the order
  `ctrl+alt+shift+win`, then one key, e.g. `alt+shift+s`. It must include ctrl, alt or win. Copy
  `normalize` / `toAccelerator` / `fromEvent` / `label` into your tool's own `keys.js` (see snipr).
- **Keys already taken** (don't use them as defaults): `alt+shift+space` (quick view),
  `alt+shift+u` (open utilr), `ctrl+n` (notr), `alt+shift+s` and `alt+shift+t` (snipr). Pick a
  default that's memorable and unlikely to clash with common apps.
- A global key is optional. Not every tool needs one; the quick view and tray already open it.

## 5. The style: ghost

The look is **notr's ghost theme**. The theme kit with all the rules is in
`C:\Users\T_J\Documents\GitHub\Notr\ghost-theme` (read its `README.md`, `ghost.css`,
`tokens.json` and `preview.html`). utilr and both tools use it, so the new tool must look like
part of the same family.

> "the app should feel like a thought, not a program. nothing on screen until you ask for it."

What I want: **minimalist, almost futuristic, sleek, modern, and it works well.** In short:

- **Chrome only on hover.** Bar contents, status line and window border are invisible at rest and
  fade in (250 ms) while the pointer is in the window (`ghost.js` sets `body.hover`).
- **No colour.** Grey on near-black: `#111111` window, `#161616` raised surfaces, `#1f1f1f` row
  hover; text `#d6d6d6`, strong `#ffffff`, dim `#8a8a8a`. The only colour is `--danger`
  `#ff7a6b`, and only for destructive things. Selection is white at low alpha.
- **Hierarchy by grey, not size or weight.** No fills on bar buttons (grey → white on hover).
  Hardly any lines: the 1 px frame, menu borders and `#1d1d1d` separators. **Square**: no border
  radius anywhere, one shadow (menus only).
- **One typeface, light:** DM Mono 300, bundled locally (no CDN, works offline). Content
  13 px / 1.8, menus 12 px, status and labels 10 px.
- **Quiet motion:** 250 ms fades, 120 ms colour changes, menus drop 4 px in 120 ms, windows fade
  in over 220 ms (ease-out cubic). Nothing bounces. Respect `prefers-reduced-motion`.
- **Frameless windows** with `backgroundColor: '#111111'` (no white flash), `show: false`,
  `opacity: 0`, faded in on `ready-to-show`. The bar is the drag region.
- **Words:** lowercase and terse everywhere. Labels like `always on top`, values right-aligned in
  dim (`on` / `off`, `ctrl+b`, `ghost ›`), `>` marks a checked item, `›` opens a submenu,
  `‹ back` (hint `esc`) leaves one. Confirmations are a strip, not a dialog:
  `delete x?  [y]es  [n]o`. Status text like `copied`, `saved`, `1280 × 720`.
- New surfaces (overlays, toolbars, readouts) are built from the existing tokens, not new colours.
  If you truly need a new token, name it in your tool's CSS and don't change the shared values.

## 6. Light and fast

- Plain JavaScript, HTML and CSS: no frameworks, no bundler, no runtime dependencies unless
  there's no reasonable way around it (ask me first).
- Nothing loads until it's needed. `start()` should take milliseconds. Pre-warm a hidden window
  only if the tool must react instantly to a key (like snipr's overlays), and say so in its README.
- No network access unless the tool is about the network. Nothing leaves my machine.
- Keyboard first: every main action has a key, `esc` backs out, and it should all feel instant.

## 7. How to work

1. Read the references above, then tell me your plan in a few lines: windows, keys, actions, data,
   and anything you're unsure about.
2. Build it in `tools/<id>/`. Run it with `npm start`, install it from the launcher's tools page
   (use a throwaway data folder: set `UTILR_USER_DATA` to a temp dir), and check it in the quick
   view, the tray and the keys page.
3. Extend `scripts/smoke.js` with checks for the new tool (install, open, its key, remove frees
   its key and closes its windows, data survives a reinstall) and run `npm test` until it's all
   `ok`. Look at the screenshots in `smoke-out/` and make sure they look right.
4. Add the tool to the root `README.md` (intro line and the folder tree).
5. Build the installer with `npm run dist:win` and make sure it builds.
6. Commit with a clear message (co-authored), **don't push**: I push from GitHub Desktop.
7. Tell me what you built, its default keys, what you tested, and what you didn't.
