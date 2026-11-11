# clipr, in utilr

Everything you copied today, one shortcut away. clipr keeps the text you copy, newest first, for as
long as the computer is on. Press the shortcut, type a few letters, `enter`: it's pasted where you
were.

| | |
|---|---|
| `alt+shift+v` | the popup (from anywhere; change it on utilr's *shortcuts* page or in clipr's menu) |
| quick view | the popup |
| tray / launcher | clipboard history, pause / resume recording, clear history |

In the popup:

| | |
|---|---|
| type | find (every clip with those letters, the match marked) |
| `↑` `↓` `pgup` `pgdn` `tab` | move |
| `enter` / click | paste it into the window you were in (Windows); elsewhere: copy it |
| `shift+enter` / shift+click | only copy it |
| `shift+del` | remove that clip |
| `ctrl+shift+del` | clear all (`clear all 14?  [y]es  [n]o`) |
| `ctrl+p` | pause / resume recording |
| `ctrl+,` | settings: paste on pick, appears at (pointer / center), shortcut, pause |
| `esc` | clear the find, then close (clicking elsewhere closes it too) |

## What's special about it

- **Only in memory.** The history is never written to disk. Quitting utilr, removing clipr or
  restarting the computer starts a clean day. Only the settings are saved
  (`%APPDATA%\utilr\tools\clipr\clipr-settings.json`).
- **Text only**: images and files on the clipboard are left alone. A copy you made before moves
  back to the top instead of showing twice. At most 200 clips and 4 million characters in all
  (the oldest go first); a single clip over a million characters isn't kept.
- **Private clips stay out.** What password managers mark as private isn't kept: on Windows
  `ExcludeClipboardContentFromMonitorProcessing` and `CanIncludeInClipboardHistory = 0` (the same
  formats Windows' own clipboard history respects), on macOS `org.nspasteboard.ConcealedType` /
  `TransientType`, on Linux KDE's `x-kde-passwordManagerHint`. While paused, nothing is kept,
  and what's on the clipboard when you resume stays out too.
- **Polling.** Electron has no "clipboard changed" event, so clipr reads the clipboard every
  half second (about 0.1 ms a read). It stops while the screen is locked or the computer sleeps.
- **Paste** (Windows): the popup is minimized and hidden, so Windows gives focus back to the
  window you were in, then `ctrl+v` is sent with the script host every Windows has
  (`cscript`, about 60 ms). The one-line script is written to clipr's data folder, since
  `cscript` can't read from inside the app. On macOS and Linux picking a clip copies it.
- **The popup is made the first time you open it** (about 0.1 s), then kept hidden so the shortcut
  opens it at once. After 5 minutes unused it's closed again, so clipr idles at no window at all.
- No network, no dependencies. Plain JS, HTML and CSS, with its own copy of the ghost theme in
  `theme/`.

## Files

```
main.js      the tool: settings, polling, history, popup window, paste, shortcut
preload.js   the popup's bridge, on clipr/… channels
popup.html   the popup (popup.js, clipr.css on top of theme/ghost.css)
keys.js      shortcut helpers, same combo format as the rest of utilr
glyph.svg    a clipboard, for the quick view, launcher and tray
```
