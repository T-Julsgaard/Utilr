# snipr — logo

snipr is a screenshot / snipping tool. Its logo is mark **A**: two crop corners
(top-left and bottom-right), like the edges of a screen selection, in a single colour.
No accent colour, no gradient, no outline. It's a sibling of the **notr** logo and
follows the same rules.

```
 ┌        snipr
       ┘
```

## Files

| File | Use |
|---|---|
| `snipr.ico` | Windows app/exe icon (16, 24, 32, 48, 64, 128, 256 px in one file) |
| `png/snipr-app-icon-{size}.png` | App icon as PNG, 16–512 px (installer, tray, store, favicon) |
| `svg/snipr-app-icon.svg` | App icon source: white mark on a black rounded tile |
| `svg/snipr-app-icon-small.svg` | Same, with a chunkier mark — used for 16 and 24 px |
| `svg/snipr-mark-white.svg` / `-black.svg` | The mark alone on a transparent background |
| `svg/snipr-mark-small-*.svg` | Chunkier mark for sizes under 32 px |
| `svg/snipr-lockup-white.svg` / `-black.svg` | Mark + "snipr" wordmark (text is outlined, no font needed) |
| `png/snipr-lockup-*-1200w.png`, `png/snipr-mark-*-512.png` | PNG versions of the above |

## Rules

- **Colours:** white `#f2f2f2` on dark backgrounds, black `#000000` on light ones. Nothing else.
- **Small sizes:** below 32 px use the `-small` files — the thin version blurs at 16 px.
- **App icon:** always the black tile version, so it shows on light and dark taskbars.
- **Wordmark:** always lowercase `snipr`, set in JetBrains Mono Regular, vertically
  centred on the mark.
- Don't stretch, recolour, add effects, rotate the corners or put the mark in a
  different tile shape.

## In the app

- Use `snipr.ico` as the window/taskbar/exe/tray icon.
- The crop-corner shape can double as UI language: the selection overlay can use the
  same two white corners (4 px thick at full size) to mark the area being captured.
- Font: JetBrains Mono (SIL Open Font License). The lockup files have the letters
  converted to shapes, so the font doesn't need to be installed.
