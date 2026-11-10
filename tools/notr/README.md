# notr, in utilr

A tiny, always-on-top note app. Open it and you get a note.
Source of truth for notr itself: [T-Julsgaard/Notr](https://github.com/T-Julsgaard/Notr)
(moved in at notr 1.1.1). This folder is notr's `src/`, made into a utilr tool.

| | |
|---|---|
| `ctrl+n` | open notr (from anywhere; change it on utilr's *keys* page or in a note) |
| quick view / tray | open notes, new note, close notes |

Everything inside a note works as before: themes, fonts, saved notes, `ctrl+s` / `ctrl+d`,
keyboard move and resize.

## What changed for utilr

- `main.js` exports `notr(host)` instead of starting an app. Gone: the tray, the app menu,
  start at login, the single-instance lock, `app.whenReady` / quit handling. utilr does those.
- `ipcMain` / `globalShortcut` are `host.ipc` / `host.shortcuts`, scoped to notr. `preload.js`
  sends on `notr/…` channels.
- State lives in `host.dataDir` (`%APPDATA%\utilr\tools\notr`). The first install copies
  `%APPDATA%\notr\notr-state.json` over if it exists.
- The note menu leaves out *start with windows* (`settings.hosted`).
- notr starts in the background: notes open on `ctrl+n`, the quick view or the tray. Notes that
  were open when utilr quit come back open.
- Fonts are bundled here (`fonts/`, woff2 only) instead of read from `node_modules/@fontsource`.
