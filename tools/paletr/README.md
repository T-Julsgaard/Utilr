# paletr, in utilr

A quiet color picker. Press the key, point at any pixel on any screen, click: its color is on
your clipboard. The colors you pick stay in a small palette.

| | |
|---|---|
| `alt+shift+p` | pick a color (from anywhere; change it on utilr's *keys* page or in the palette's gear menu) |
| quick view | pick a color |
| tray / launcher | pick a color, palette |

## Picking

The screens freeze (one overlay per display, at full color: nothing is dimmed, because you're
judging colors). The pointer becomes a square loupe: the pixels round it, magnified, with the
one in the middle ringed. Under it is the color as it will be copied.

| | |
|---|---|
| click / `enter` | copy it and close |
| `shift`+click / `shift+enter` | copy it and keep picking (collect a few in a row) |
| arrows | move the ringed pixel by 1 px (`shift`: 10 px) |
| scroll / `+` `-` | zoom the loupe (7 to 21 pixels across) |
| `tab` / `shift+tab` | `hex` → `rgb` → `hsl` (remembered) |
| `esc` / right click / the key again | cancel |

What's copied: `#1e90ff`, `rgb(30, 144, 255)` or `hsl(210, 100%, 56%)`. A toast in the corner
says what went on the clipboard. The color is read from the screen grab itself, in the screen's
own pixels, so on a scaled display you get the pixel you pointed at, not a blend.

A click acts when the button comes *up*, so the release never lands in the program underneath.

## The palette

Tray / launcher → *palette*. The last 30 colors you picked, newest first, as square swatches
(the same color picked again moves to the front instead of showing twice).

| | |
|---|---|
| click / `enter` / `ctrl+c` | copy (in the format set under the gear) |
| right click | copy as hex / rgb / hsl, or remove |
| arrows, `home` `end` | move |
| `del` | remove |
| `tab` | change the format |
| `p` / `+` | pick another (the palette steps aside, then comes back) |
| `esc` | close |

Gear menu: *copy as* (`hex ›`), *pick key*, *pick a color*, *clear palette* (asks first, as a
strip). There's no *start with windows* or *quit* row: utilr does those.

## What's special

- **Nothing runs until you pick.** `start()` reads `paletr.json` and registers the key, and
  that's all. The overlays and the toast are made on the first pick, while the screens are being
  grabbed, so it costs little (about 0.25 s from key to loupe here). They then stay warm, hidden,
  for 10 minutes so picks in a row are instant, and close after that: an idle paletr has no
  windows and no renderer processes. Each overlay drops its frozen screen as soon as it hides.
- **Data:** `%APPDATA%\utilr\tools\paletr\paletr.json` (key, format, palette, where the palette
  window was), written atomically with a `.bak`. Removing paletr leaves it there, so installing it
  again brings the palette back.
- **Keys:** `alt+shift+p` by default (`p` for pick; `alt+shift+c` is VS Code's "copy path").
- **macOS:** picking needs screen recording permission for utilr.
- Own copies of the ghost theme (`theme/`), `keys.js` (same format as the rest of utilr) and
  `color.js` (hex / rgb / hsl, shared by the main process and the windows). Nothing is imported
  from `src/` or another tool.
- `assets/paletr-icon.svg` is the source of the window icon (`paletr.ico`, `paletr-256.png`):
  the glyph, white on the black tile snipr's icon uses.
