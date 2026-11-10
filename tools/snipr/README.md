# snipr, in utilr

A quiet screenshot tool. Press the key, drag, it's on your clipboard.
Source of truth for snipr itself: [T-Julsgaard/Snipr](https://github.com/T-Julsgaard/Snipr)
(moved in at snipr 1.2.2). This folder is snipr's `src/`, made into a utilr tool.

| | |
|---|---|
| `alt+shift+s` | snip (from anywhere; change it on utilr's *keys* page or in snipr's settings) |
| `alt+shift+t` | snip text (Windows) |
| quick view | a snip |
| tray / launcher | snip, snip text, snip in 3 seconds, open folder, settings |

Everything about a snip works as before: marks, blur, copy text, drag out, save.

## What changed for utilr

- `main.js` exports `snipr(host)` instead of starting an app. Gone: the tray, the app menu,
  start at login, the single-instance lock, the "snipr is in the tray" welcome, `app.whenReady` /
  quit handling. utilr does those.
- `ipcMain` / `globalShortcut` are `host.ipc` / `host.shortcuts`, scoped to snipr. `preload.js`
  sends on `snipr/…` channels, and `broadcast` only reaches snipr's own windows.
- Settings live in `host.dataDir` (`%APPDATA%\utilr\tools\snipr`). The first install copies
  `%APPDATA%\snipr\snipr-settings.json` over if it exists. Snips still go to `Pictures\snipr`.
- The settings menu leaves out *start with windows* and *quit snipr* (`settings.hosted`), and
  the settings window is two rows shorter.
- Like before, the capture overlays and the toast are made up front (hidden) so a snip opens at
  once.
