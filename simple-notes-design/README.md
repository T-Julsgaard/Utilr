# Simple Notes — design brief

A very small, minimalist note-taking app for the desktop (PC). Inspired by Windows
Sticky Notes, but simpler, with a "hackery", terminal-like look: monospace fonts,
dark backgrounds, one accent colour.

Open `index.html` in a browser to see every design. Each file in `designs/` is a
static, self-contained HTML mockup (no JS) — use them as the visual reference,
not as production code.

## Chosen direction

**`designs/01-main-green.html` is the primary design.** Build this one first.
`designs/02-all-notes-search.html` shows the two extra screens in the same style.
Files 03–07 are alternative looks; some of their ideas may become themes or
options later (see "Ideas from the alternatives").

## Core behaviour

- Each note is its own small, frameless window (default ~300×300 px), resizable
  and draggable by the title bar.
- Title bar: `+` new note (left) · note name (centre) · `···` menu and `×` close (right).
- Writing area: plain text, monospace. Empty note shows `> take a note` placeholder
  and a blinking block cursor.
- Status line at the bottom: `ln X, col Y` on the left, save state on the right
  (`● saved 14:02`).
- Autosave on every change. No save button.
- `···` menu: all notes (`ctrl+l`), pin on top (`ctrl+p`), accent colour, `rm note` (`del`, in red).
- Notes reopen in the same position/size on next launch.
- Light markdown-ish rendering is optional: `# heading`, `[ ]` / `[x]` checkboxes
  (checked items dimmed and struck through).

### All notes window (`02`)
- `$ ls -t` list of notes, newest first, with relative time (`14:02`, `yday`, `nov 03`).
- Pinned notes marked with a green `*`.
- Keyboard: `↑↓` select, `enter` open, `/` focuses search.

### Search (`02`)
- `/` input filters all notes by content; results show `filename :line` and the
  matching line with the match highlighted. `esc` goes back to the list.

## Keyboard shortcuts
| Key | Action |
|---|---|
| ctrl+n | new note |
| ctrl+l | all notes |
| ctrl+p | pin on top (always-on-top window) |
| / (in list) | search |
| del (in menu) | delete note (ask to confirm) |
| esc | close menu / leave search |

## Design tokens (primary green design)
| Token | Value |
|---|---|
| Font | JetBrains Mono (400 / 500 / 700) |
| App background (behind windows, mockup only) | `#070908` |
| Note background | `#0f1311` |
| Title bar background | `#141a16` |
| Border | `#232b26` (focused note: `#2d6b48`) |
| Divider | `#1c231f` |
| Text | `#c9d4cd` · strong `#e8efe9` · muted `#9aa79f` |
| Dim text / placeholder | `#6f7c74` · labels `#7d8a82` |
| Accent | `#39ff88` (hover `#8dffbd`) |
| Hover background | `#1f2622` |
| Danger | `#ff7a6b` |
| Text size | 13px body, 11px title, 10px status line |
| Cursor | 8×15 block, blinks at 1s, `steps(1)` |

## Ideas from the alternatives
- **03 amber CRT** — VT323 font, amber `#ffb000`, scanlines: a possible "retro" theme.
- **04 bare mono** — IBM Plex Mono, pure black or off-white paper: a light theme.
- **05 ghost** — title bar and border hidden until the mouse hovers the note.
  Strong candidate as an option for the main design.
- **06 gutter** — line numbers and `~` empty lines like Vim; Martian Mono, cyan `#5fd7ff`.
- **07 dots** — each note gets one coloured dot (green / amber / blue) as its
  only decoration; `ctrl+1–3` sets it.

## Not decided yet
- Tech stack (e.g. Tauri, Electron, or native). Prefer something lightweight.
- Where notes are stored (plain `.txt` files in a folder fits the theme).
