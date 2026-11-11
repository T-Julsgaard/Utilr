# measr, in utilr

A pixel ruler that reads the screen. Press the key, point, and you know how big it is and how
far apart things are. Built for checking a UI against what you meant, or for telling an AI
exactly what to change.

| | |
|---|---|
| `alt+shift+m` | measure (from anywhere; change it on utilr's *keys* page or in measr's settings) |
| quick view | measure |
| tray / launcher | measure, measure in 3 seconds, settings |

*Measure in 3 seconds* gives you time to open a menu or hover a button before the screen is
caught.

## Measuring

The screen holds still and measr reads it pixel by pixel, so it finds the edges itself:

| | |
|---|---|
| move | lines run out from the pointer to the nearest edge each way: the space you're in (`16 × 48`) |
| click | pin that measure, then measure the next one |
| drag | a box. Drag it loosely round something and it closes in on it (snaps to what's inside) |
| `alt`+drag | a box exactly as you draw it |
| dbl-click | a box round the element under the pointer (everything of that colour that's connected: a button's fill, a card's inside) |
| two boxes | the gap between them, or the padding when one is inside the other. It's measured from the selected box (the newest, `tab` for the next) to the box under the pointer, or else to the one before it |
| arrows | move the crosshair 1 px (`shift`: 10) without touching the mouse |
| `z` | loupe on / off. On *auto* it comes when you hold still and goes when you move on |

## Copying

The number drawn in white is the one `ctrl+c` copies: the live measure, the box you just made,
or the number under the pointer. Click any number to copy that one.

| | |
|---|---|
| `ctrl+c` | copy the white number |
| `enter` | copy it and close |
| `c` | the colour under the pointer (`#1f1f1f`) |
| `s` | an image of what you measured, with the measures drawn on (for a chat, an issue, a prompt) |
| `a` | everything on screen as text, one line each (`box  240 × 48`, `gap  16`, `padding  12 16`) |
| `backspace` / `del` | undo / clear |
| right click | the menu: copy, settings, keys |
| `?` | every key |
| `esc` | close (the key again closes it too) |

Numbers copy in the format you choose (right-click menu or settings → *copy as*):

| | size | gap | padding |
|---|---|---|---|
| plain | `240 × 48` | `16` | `12 16` |
| css | `width: 240px; height: 48px;` | `column-gap: 16px;` | `padding: 12px 16px;` |
| tailwind | `w-60 h-12` | `gap-x-4` | `px-4 py-3` |

## Settings

- **units**: *css px* (screen pixels ÷ the display's scale, what you write in code; the default) or
  *screen px* (the real pixels). On a 100 % display they're the same.
- **copy as**: plain, css or tailwind (above).
- **edges**: how different a pixel must be to count as an edge. *exact* (any change), *soft*
  (ignores compression noise and soft shadows; the default), *loose* (only strong lines).
- **loupe**: auto, always, off.
- **show hints**: the one-line hint at the top when measr opens.

Settings live in `%APPDATA%\utilr\tools\measr\measr-settings.json`. Measures are not saved:
they're gone when measr closes. Nothing leaves your machine.

## What's special about it

- **Pre-warmed overlays.** Like snipr, measr keeps one hidden overlay window per display, so the
  key opens it at once (they're rebuilt when displays change). This is the only cost while it's
  idle. The corner toast is made the first time it's needed.
- **Everything is worked out in device pixels**, on the screenshot's own pixels, and drawn on a
  canvas the size of the screen. A line is always exactly one screen pixel, and the numbers are
  converted to css px only when they're shown.
- **Your pointer is hidden** while you measure. The crosshair is drawn on the exact pixel it measures
  from, with a dark halo, so it reads on light and dark screens alike. Ghost has no colour, so
  neither do the measures: white lines, grey panels.
- Numbers never pile up on each other: each one is placed beside its line, and moves along if
  something more important is already there.
- The settings window and the right-click menu are one menu (`menu.js`). In utilr there are no
  *start with windows* or *quit* rows (`settings.hosted`).

## Files

| | |
|---|---|
| `main.js` | captures the screens, shows and hides the overlays, settings, clipboard, the key |
| `overlay.html` / `overlay.js` | the measuring: edges, snapping, elements, gaps, padding, drawing, keys |
| `menu.js` | the menu rows, shared by the overlay and the settings window |
| `settings.html` / `settings.js` | the settings window (tray → settings) |
| `toast.html` / `toast.js` | the corner notice after *enter* |
| `keys.js` | combo helpers, the same as snipr's |
| `measr.css` | measr's surfaces, built from the ghost tokens |
| `theme/` | a straight copy of the ghost theme kit, never edited |
