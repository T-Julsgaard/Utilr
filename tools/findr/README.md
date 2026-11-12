# findr, in utilr

Every file on every drive, found as you type. Press the shortcut, type a few letters of a name, and
`enter` opens it. Windows' own search only knows what its indexer got around to (on the machine
this was built on: 647 files out of about 900,000). findr keeps its own list of every name
instead. No admin rights needed, and nothing leaves the computer.

| | |
|---|---|
| `alt+shift+d` | the popup (from anywhere; change it on utilr's *shortcuts* page or in findr's menu) |
| quick view | the popup |
| tray / launcher | find files, read the drives again, clear recent |

In the popup:

| | |
|---|---|
| type | find: every file and folder with that in its name |
| `↑` `↓` `pgup` `pgdn` `tab` | move |
| `enter` / click | open it |
| `ctrl+enter` / `shift+enter` / ctrl+click / a click on its path | open the folder it's in, with it selected |
| `ctrl+shift+c` (or `ctrl+c` with nothing selected) | copy its path |
| `shift+del` | forget it (in the recent list) |
| `ctrl+r` | read the drives again |
| `ctrl+,` | settings: look, which drives, remember opened, shortcut |
| `esc` | clear the find, then close (clicking elsewhere closes it too) |

What you can type:

| | |
|---|---|
| `invoice 2026` | both words, anywhere in the name, in any order |
| `"dm mono"` | a phrase, space and all |
| `*.pdf`, `img_????.jpg` | wildcards: the whole name has to fit |
| `github\ notr`, `docs\invoice` | a word with `\` (or `/`) is looked for in the whole path |

Before you type, the popup lists what you opened last. The selected row shows the size and when
the file was last changed.

## Looks

Three ways for the popup to look, picked under `look ›` in findr's menu (`ctrl+,`). A new look
takes effect at once: the popup is made again in that look, with the menu still open, so you can
flip through them with `↑` `↓` `enter`. All three have the same shortcuts and the same ghost style.

| | |
|---|---|
| **bar** (the default) | Just a search bar, floating a fifth of the way down the screen: the magnifier, the find line, `find in 918,000 files`. Results drop below it as you type, one line each. Before you type, `↓` shows what you opened last. |
| **window** | A window: two-line results (name, then its folder), size and date on the selected one, a status line and the chrome on hover. |
| **line** | A thin line across the top of the screen. Results drop down as a table: names in one column, folders in the next, size and date at the right edge. The shortcut hints show on hover. |

The bar and the line are drawn on a transparent window a little bigger than they are, so they
can grow, cast their shadow and hold the menu. A click past them closes them, like a click
anywhere else. While a drive is being read, a slow 1 px sweep runs along their bottom edge.

## How it works

- **The list.** One thread per drive reads every folder (plain `readdir`, one call per folder,
  no `stat` per file) and hands the names to findr's engine thread. On the machine this was
  built on: C: (350k entries) in about 2 s, G: (550k) in 4–6 s from a warm disk. A cold
  spinning disk takes about a minute or two. The main process never holds the list, so utilr
  stays responsive while it's read.
- **Searching.** A drive's names are kept as strings of up to 50,000 names each
  (`"\nname\nname\n…"`). A search is one case-insensitive `RegExp` over those strings, so
  900,000 names take 5–15 ms (a single letter, with half a million matches, about 80 ms). Then
  the best matches are ranked: exact names and name starts first, things you opened before and
  things in your own folder up, deep paths a little down, and machine-made folders (`AppData`,
  `node_modules`, `.git`, `Windows`, …) well down.
- **Keeping up.** Fixed drives are watched (`fs.watch`, recursive, one per drive: Windows'
  `ReadDirectoryChangesW`), by the engine thread, or with utilr's RAM saver on by a small thread
  of their own. Only names appearing and going count. When one does, its folder is
  read again a moment later and compared with the list, so new, renamed, moved and deleted files
  show up in about a second. A folder moved in is read whole. USB drives aren't watched (a watch
  would keep you from ejecting them). They're read when they appear and when you ask. Watching
  costs about 1–2% of one core while things on disk change, nothing when they don't.
- **When Windows loses track.** If too much changes at once, Windows says it lost track and
  findr reads that drive again, a minute later and at most every 15 minutes. With last-access
  times on (`fsutil behavior query disablelastaccess`; on by default on many machines), findr's
  own scan touches every folder, and that alone can overflow the watch. So losing track during a
  scan, or within 2 minutes of one, is ignored. The log says why each scan ran.
- **The cache.** After every scan, the list is written to `index-<drive>.bin` in
  `%APPDATA%\utilr\tools\findr` (about 45 MB for 900k entries). On the next start it's
  searchable from there within a tenth of a second. Twenty seconds later the drives are read
  again in the background, to catch what changed while utilr was off, and again every 6 hours.
  Live changes are saved every 10 minutes, when findr stops and when the engine is put away.
- **Left out:** the recycle bin, `System Volume Information`, `WinSxS` (100k files nobody looks
  for), Windows setup leftovers, and folders a normal user can't open (findr runs without
  admin, so it sees what you see). Junctions and symlinks are listed but not followed, so
  nothing is indexed twice.
- **Windows folders.** A drive's own `Windows` folder (`C:\Windows`, or an old install's) is
  listed, but what's in it isn't, unless you turn *windows folders* on in the menu. On the
  machine this was built on that was half of every entry (an old `G:\Windows` alone had 445k),
  so leaving it out saves memory, scan time and cache space. A `Windows` folder anywhere else
  is indexed as usual.
- **Drives** come from Windows (`Win32_LogicalDisk`, through PowerShell, in the background).
  Local and USB drives are in by default. Network drives and discs aren't. Turn any of them on
  or off in the menu (a drive turned off is dropped, cache and all). To cover a folder that
  isn't a drive (a network share, say), add it to `"folders"` in `findr-settings.json`.
- **Put away when unused** (only with *ram saver* on, in utilr's settings; it's off by default).
  After 5 minutes without the popup, and with no scan running or due within 2 minutes, the
  engine thread saves what changed and is ended, and its memory goes back to Windows. The watch
  thread stays (about 11 MB) and keeps a list of the folders that change.
  Opening findr starts the engine again: the cache loads, those folders are read again, and
  nothing else is. On the machine this was built on, C: (430k entries) loaded in about 50 ms,
  and the first search was answered about 85 ms after the engine started. A scan that comes
  due while the engine is away (the 6-hourly one, or Windows losing track) starts it for that
  scan, and it goes again afterwards. The log says when it goes and why it comes back.
- **Memory**, measured with the drives of the machine this was built on (about a million
  entries): about 100 MB with the index up, about 25 MB with it put away (the watch thread and
  what's left over), so the RAM saver saves 75–80 MB while findr isn't used. The first search
  after it comes back took about a quarter of a second.
  The engine starts 1.5 s after utilr does, so utilr's own start isn't slowed.
- **The popup is made the first time you open it** (about 0.1 s), then kept hidden so the shortcut
  opens it at once. After 5 minutes unused it's closed again.
- **Windows only** (`platforms: ["win32"]`): drive letters, PowerShell, recursive watching.
- **The shortcut:** `alt+shift+d` (d for disk), because `alt+shift+f` is VS Code's "format document".
- No network, no dependencies. Plain JS, HTML and CSS, with its own copy of the ghost theme in
  `theme/`. Searches are never logged, only sizes and timings.

## Files

```
main.js      the tool: settings, drives, recent, the popup window (one per look), opening, the shortcut
worker.js    the engine thread: roots, scans, live updates, cache, searches, being put away
watch.js     the watch thread: always on, watches the drives, keeps changes while the engine is away
timing.js    when drives are read again (shared by main.js and worker.js)
engine.js    the index itself: segments, search and ranking, refreshing a folder, the cache file
walk.js      reading a folder tree into the list (used by scans and by live updates)
scan.js      a scan thread: walks one drive, posts batches
boot.js      starts the threads from source text (worker_threads can't load from app.asar)
preload.js   the popup's bridge, on findr/… channels
popup.html   the popup in all three looks (popup.js, findr.css on top of theme/ghost.css)
keys.js      shortcut helpers, same combo format as the rest of utilr
glyph.svg    a magnifier, for the quick view, launcher and tray
```
