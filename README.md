# snipr

A quiet screenshot tool for Windows, macOS and Linux. Notr's sibling: same ghost look,
same idea. Nothing on screen until you ask for it.

**Press the key, drag, and the snip is on your clipboard.**

![snipr](src/assets/snipr-256.png)

## Using it

| | |
|---|---|
| `alt+shift+s` | snip (from anywhere; change it in settings) |
| drag | select an area. Release takes it |
| click | the whole screen |
| `shift` while dragging | square |
| `space` while dragging | move the selection |
| `enter` | take the selection (or the whole screen) |
| `esc` / right click | cancel |

Opening snipr from the start menu (or starting it a second time) also takes a snip. After that
it waits in the tray: click the tray icon to snip, right-click for *snip in 3 seconds*, the
folder, settings and quit. At login it starts quietly in the tray.

### The snip

When you release the mouse, the snip lifts off the screen right where you took it, in a small
ghost window that stays on top. At rest it's just the image. Hover for the chrome.

| | |
|---|---|
| `p` `a` `b` `t` `x` | pen, arrow, box, text, blur. Press again (or `v`, `esc`) for the hand |
| hand + drag the image | drag the snip into a chat, a folder or a document |
| `shift` while drawing | arrows snap to 45°, boxes go square |
| `ctrl+c` | copy, with your marks |
| `ctrl+s` / `ctrl+shift+s` | save to the folder / save as… |
| `ctrl+z` / `ctrl+y` | undo / redo |
| `ctrl+n` | new snip |
| `esc` / `ctrl+w` | close (asks first if you have marks you haven't copied or saved) |
| right click | all of the above as a menu |

Marks use the ink set in settings: **ghost** (white with a dark halo, so it reads on anything),
**red** or **black**.

### Settings

Tray → settings, or the gear on any snip.

- copy to clipboard: every snip goes straight to the clipboard (on)
- open the snip: show the snip window (on). Off gives you just a small `copied` notice
- save it too: also save every snip to the folder (off)
- folder: where snips are saved (`Pictures\snipr`), as `snip-2026-11-10-142233.png`
- ink, snip key, keep snips on top, ask before discard, start with windows

Settings live in `%APPDATA%\snipr\snipr-settings.json`, with a small log next to it.

## Building

```bash
npm install
npm start            # run from source
npm test             # drives the real windows; screenshots go to smoke-out/
npm run dist:win     # dist/snipr-setup-<version>.exe
```

`npm run icons` redraws every icon from the geometry in `scripts/icons.js`.

## Look

snipr uses notr's **ghost** theme as-is: `src/theme/` is a straight copy of notr's ghost kit
(`ghost.css`, `ghost.js`, DM Mono). The surfaces notr doesn't have (overlay dim, selection,
readouts, toast, annotation inks) are built from those tokens in `src/snipr.css`, under
snipr's own names, so the two apps stay visibly the same family.

## Notes per platform

- **Windows**: tested. The print screen key can be used as the snip key if Windows' own
  "use print screen to open screen capture" is turned off.
- **macOS**: snipr asks for *Screen Recording* permission the first time. Without it,
  captures come back empty.
- **Linux**: works on X11. On Wayland, the desktop's screen-share dialog shows up for each
  capture, which is how Wayland allows screenshots.

## Licence

MIT. DM Mono is under the SIL Open Font License 1.1 (`src/theme/fonts/OFL.txt`).
