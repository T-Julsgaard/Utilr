# utilr

One quiet launcher for small tools. **One tray icon, one process, every tool.**

utilr hosts [notr](tools/notr), [snipr](tools/snipr), [clipr](tools/clipr),
[measr](tools/measr) and [paletr](tools/paletr) (and the tools that come next) in a single app. You install utilr once, then install the tools you want from inside it. Same
ghost look as notr and snipr: grey on near-black, DM Mono, nothing on screen until you ask
for it.

<img src="assets/logo/svg/utilr-app-icon.svg" width="72" alt="utilr">

## Using it

| | |
|---|---|
| `alt+shift+space` | the **quick view**: a narrow column of your pinned tools, from anywhere |
| `alt+shift+u` | open utilr (the launcher) |
| tray icon | click: open utilr. Right-click: every tool's actions, and quit |

All of these keys can be changed on the launcher's *keys* page.

### The quick view

A slim column of square tiles, one per pinned tool, where you need it.

| | |
|---|---|
| `1`–`8` | open that tool |
| `↑` `↓` / `tab` | move |
| `enter` / click | open |
| `esc` / click elsewhere | close |

The last tile (`+`) opens the launcher so you can pin something. Where the column appears
(center, at the pointer, left or right edge) is a setting.

### The launcher

A small ghost window with four pages. At rest it shows the content and nothing else. Hover
for the chrome (title, close, status line).

- **tools**: what's installed and what isn't. Click a tool to open it, `›` for its actions
  (new note, snip in 3 seconds, open folder, …) and *remove*. `↑` `↓` `enter` work too.
- **quick view**: which tools are pinned and in what order, with a live preview of the column.
- **keys**: every system-wide key in utilr, both utilr's own and each tool's, in one place. Click
  one and press the new combo. A key belongs to one tool only: utilr says who has it
  (`snipr has it`) and doesn't let two tools fight over a combo.
- **settings**: start with Windows, where the quick view appears, the data folder, versions,
  quit.

`ctrl+tab` moves between pages, `esc` closes the launcher.

### Installing a tool

Every tool ships with utilr. *Install* starts it: it gets its keys, it's added to the quick view
(while there's room), and its actions appear in the tray. A tool you haven't installed is never
loaded and costs nothing. *Remove* stops it and frees its keys. Its data stays, so installing it
again brings everything back.

On the first install, utilr brings over the data of the stand-alone app if it finds it
(`%APPDATA%\notr\notr-state.json`, `%APPDATA%\snipr\snipr-settings.json`). Your notes and snipr
settings come along. **Uninstall the stand-alone notr and snipr afterwards**: they would hold the
same keys.

## How it's put together

```
src/            the launcher: tray, quick view, launcher window, keys, tool host
  main.js       app lifecycle, windows, tray, IPC
  host.js       finds tools in tools/, starts and stops them, gives each its own scope
  shortcuts.js  one registry for every system-wide key (one owner per key)
  store.js      utilr.json: installed, pinned, keys, settings
  theme/        the ghost theme kit (from notr/ghost-theme)
tools/
  notr/         notr's own code: windows, preload, theme, fonts, data
  snipr/        snipr's own code, the same way
  clipr/        clipboard history: today's copies, in memory only
  measr/        pixel ruler: edges, boxes, gaps and padding on the frozen screen
  paletr/       color picker: a loupe over the frozen screen, a palette of recent picks
scripts/        icons.js (app icons from assets/logo), smoke.js (end-to-end test)
```

Each tool stays in its own folder and doesn't share code with the others. A tool is a
`tool.json` (name, version, description, glyph) plus a `main.js` that exports one function:

```js
module.exports = function mytool(host) {
  // host.ipc        ipcMain, but every channel is "<id>/<channel>" (the preload sends the same)
  // host.shortcuts  globalShortcut, shared fairly between tools
  // host.dataDir    %APPDATA%\utilr\tools\<id>
  // host.changed()  "my keys or actions changed": the launcher refreshes
  return {
    start() {},        // load state, register keys; no windows yet
    stop() {},         // save, close every window, let go of every key
    open() {},         // the main thing: quick view tile, tray, launcher
    actions: () => [{ id, label, key, run }],
    keys: () => [{ id, label, combo, ok }],
    setKey(id, combo) { return { ok: true }; },
  };
};
```

To add a tool, add a folder to `tools/`. The launcher, the quick view, the tray and the keys page
pick it up from there.

notr and snipr were moved in from their own repositories with only the stand-alone parts taken
out (tray, start at login, single-instance lock, lifecycle). Each tool's README says exactly what
changed.

Data lives in `%APPDATA%\utilr` (`utilr.json`, `utilr.log`, `tools\<id>\…`).

## Building

```bash
npm install
npm start            # run from source
npm test             # smoke test: drives the real windows, screenshots in smoke-out/
npm run icons        # app icons from assets/logo/svg
npm run dist:win     # installer in dist/ (also dist:mac, dist:linux)
```

## Licence

MIT. DM Mono and notr's other fonts are SIL OFL 1.1 (see `src/theme/fonts/OFL.txt`,
`tools/notr/fonts/OFL.txt`).
