# snipr, in utilr

A quiet screenshot tool. **Press the shortcut, drag, and the snip is on your clipboard.** Nothing on
screen until you ask for it: then a snip lifts off the screen right where you took it, in a small
ghost window you can mark up, blur, copy the text out of, drag into a chat or save.

<img src="assets/logo/svg/snipr-lockup-white.svg" width="160" alt="snipr">

| | |
|---|---|
| `alt+shift+s` | snip (from anywhere; change it on utilr's *shortcuts* page or in snipr's settings) |
| `alt+shift+t` | snip text (Windows): drag, and the text is on your clipboard. No image, no window |
| `alt+shift+g` | record a gif: drag an area, rec (now or in 3 seconds), and the same shortcut again to stop |
| quick view | a snip |
| tray / launcher | snip, snip text, snip in 3 seconds, record gif, open folder, settings |

*Snip in 3 seconds* gives you time to open a menu or hover something before the screen is caught.

## Taking a snip

The screens freeze, dimmed, one overlay per display.

| | |
|---|---|
| drag | select an area. Release takes it |
| click | the whole screen |
| `shift` while dragging | square |
| `space` while dragging | move the selection |
| `enter` | take the selection (or the whole screen) |
| `esc` / right click | cancel |

The selection is marked with the logo's two crop corners and its size (`1280 × 720`).

## The snip

When you release the mouse, the snip lifts off the screen right where you took it. At rest it's
just the image. Hover for the chrome.

| | |
|---|---|
| `p` `a` `b` `c` `t` `x` | pen, arrow, box, circle, text, blur. Press again (or `v`, `esc`) for the hand |
| text | drag a box: the letters are as tall as the box. A plain click gives normal-sized text. `enter` places it, `shift+enter` adds a line |
| hand + drag the image | drag the snip into a chat, a folder or a document |
| `shift` while drawing | arrows snap to 45°, boxes go square, circles go round |
| `ctrl+c` | copy, with your marks |
| `ctrl+shift+c` | copy the text in the snip (Windows; also the lines button in the bar) |
| `ctrl+s` / `ctrl+shift+s` | save to the folder (again = update that same file) / save as… |
| `ctrl+z` / `ctrl+y` | undo / redo |
| `ctrl+n` | new snip |
| `esc` / `ctrl+w` | close (asks first if you have marks you haven't copied or saved) |
| right click | all of the above as a menu |

Marks use the ink set in settings: **ghost** (white with a dark halo, so it reads on anything),
**red** or **black**. Text uses the font set in settings: JetBrains Mono, IBM Plex Mono, DM Mono,
Martian Mono, Space Mono and VT323 (bundled), plus Cascadia Mono, Consolas, Segoe UI, Georgia and
Arial from the system. The font only changes what you write on snips; snipr itself stays in DM
Mono.

## Recording a gif

`alt+shift+g` (or *record gif* in the tray / launcher) freezes the screens like a snip: drag the
area to record, or click for the whole screen. The live screen comes back with a thin frame just
outside the area, and a small bar beside it:

| | |
|---|---|
| **rec** | record now |
| **in 3** | count down 3, 2, 1 in the bar, then record: time to put the pointer where it starts |
| **×** | never mind |
| **stop** | while recording (the bar shows a red square and the time) |
| `alt+shift+g` again | rec now · cancel the countdown · stop |

The bar never takes the focus, so the app you're recording keeps it, and the frame is drawn
outside the area, so neither is in the gif. When the area fills the screen, the bar sits inside it
in the corner, asking the system to keep it out of the recording.

The gif is saved to the folder as `gif-2026-11-16-142233.gif` and opens where you recorded it, in
a window like a snip's: playing, with the chrome on hover. Drag it out into a chat or a folder (it's
the saved file), **save as…** (`ctrl+s`), **show in folder**, **delete** (`del`, to the recycle
bin), `ctrl+n` for a new gif, `esc` to close. With *auto open* off you get a `gif saved` notice
instead.

15 frames a second, the pointer included, at the screen's own resolution (a gif wider or taller
than 1920 px is scaled down). A recording stops by itself after 2 minutes.

## Settings

Tray / launcher → *settings*, or the gear on any snip.

- **auto copy to clipboard**: every snip goes straight to the clipboard (on)
- **auto open**: show the snip window (on). Off gives you just a small `copied` notice
- **auto save**: also save every snip to the folder (off)
- **close after copy**: a snip window closes once you copy it (off)
- **folder**: where snips are saved, `Pictures\snipr` by default, as `snip-2026-11-10-142233.png`
- **ink**, **font**, **border** (a matte round the snip, off by default), **snip shortcut**, **text shortcut**
  (Windows), **gif shortcut**
- **keep snips on top** (off), **ask before discard** (on)

*Start with windows* and *quit snipr* aren't here: utilr does both.

## What's special about it

- **Blur can't be undone.** A normal mosaic keeps an average per block, and those averages are
  enough to guess text back. snipr's blur keeps nothing of what's under it except one average
  colour for the whole area; each block is that colour shifted by random noise from the system's
  secure random source (`crypto.getRandomValues`). A snip goes to the clipboard (and, with auto
  save, to the folder) the moment you take it, so each blur also replaces that unblurred original
  with the blurred version. The clipboard only if it still holds exactly what snipr put there, so
  anything you copied since is left alone.
- **Copy text** (Windows) reads the snip with the OCR engine built into Windows 10 and 11, the
  same one PowerToys' Text Extractor uses. Nothing to install, nothing leaves your machine, about
  a third of a second. The text keeps the snip's layout: rows top to bottom, columns lined up,
  indentation kept (for code), a blank line between paragraphs, bullets as `- `. It reads the snip
  without your arrows, boxes and pen strokes, but with your blurs, so blurred text stays
  unreadable. It reads the languages Windows has OCR for (Settings → Time & language → Language).
- **Small gifs of screens.** snipr has its own gif encoder (`gifenc.js`, no dependencies), made
  for what a screen recording is: mostly the same from frame to frame. A frame that didn't change
  isn't written (the one before just lasts longer); one that did is cut to the box round the
  change, and inside that box what didn't change is transparent, which compresses to almost
  nothing. Each frame gets its own 255 colours: exact when it has that few (most UI), a median cut
  otherwise, never dithered, so text stays crisp. It runs in a worker beside the recording, and
  frames carry the time they were taken, so a busy moment drops a frame instead of making the gif
  run fast.
- **Pre-warmed overlays.** One hidden overlay window per display and the toast are made up front,
  so the shortcut opens a snip at once. They're rebuilt when displays change. This is snipr's only
  cost while it's idle.
- **Data:** settings in `%APPDATA%\utilr\tools\snipr\snipr-settings.json`; snips and gifs go to
  `Pictures\snipr`. The first install copies `%APPDATA%\snipr\snipr-settings.json` over from the
  stand-alone snipr if it's there.
- **Look:** `theme/` is a straight copy of the ghost kit. The surfaces notr doesn't have (overlay
  dim, selection, readouts, toast, annotation inks) are built from those tokens in `snipr.css`.
  The logo kit is in `assets/logo/`.

## Per platform

- **Windows**: tested. The print screen key can be the snip shortcut if Windows' own "use print
  screen to open screen capture" is turned off.
- **macOS**: asks for *Screen Recording* permission for utilr the first time. Without it,
  captures come back empty. Snip text is Windows only.
- **Linux**: works on X11. On Wayland, the desktop's screen-share dialog shows up for each
  capture, which is how Wayland allows screenshots.

## Files

```
main.js        the tool: capture, overlays, snip and gif windows, recording, saving, clipboard, settings, shortcuts
overlay.html/js  the frozen screen and the selection
snip.html/js   a snip: marks, blur, text, undo, copy, save, drag out
rec.html/js    the recording bar, which is also the recorder (screen stream, crop, frames)
frame.html/js  the frame round a gif's area
gifenc.js      the gif encoder; gif-worker.js runs it off the bar's thread
gif.html/js    a gif: plays, drag out, save as, show in folder, delete
menu.js        the settings rows, shared by the settings window and a snip's gear
settings.html/js  the settings window (tray → settings)
toast.html/js  the corner notice (`copied`)
ocr.js         copy text: Windows' built-in OCR, through PowerShell
keys.js        combo helpers, same format as the rest of utilr
preload.js     the windows' bridge, on snipr/… channels
snipr.css      snipr's surfaces, built from the ghost tokens
fonts/         the bundled annotation fonts
theme/         a straight copy of the ghost kit
assets/        the window icon and the logo kit (assets/logo)
glyph.svg      two crop corners, for the quick view, launcher and tray
```

## History

snipr was a stand-alone app (T-Julsgaard/Snipr, 1.0.0 to 1.2.2). Its whole history is merged into
this repository. To make it a utilr tool, `main.js` exports `snipr(host)` instead of starting an
app: the tray, app menu, start at login, single-instance lock, the "snipr is in the tray" welcome
and quit handling went to utilr, `ipcMain` / `globalShortcut` became `host.ipc` /
`host.shortcuts` (and `broadcast` only reaches snipr's own windows), and the settings hide
*start with windows* and *quit snipr* (`settings.hosted`).
