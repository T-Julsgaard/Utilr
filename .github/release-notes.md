**utilr**: one quiet launcher for small tools. One download, one tray icon, every tool.
See them all at [t-julsgaard.github.io/Utilr](https://t-julsgaard.github.io/Utilr/).

### What's inside

| | |
|---|---|
| **notr** | tiny notes that stay on top · `ctrl+n` |
| **snipr** | press, drag, it's on your clipboard · `alt+shift+s` |
| **paletr** | click any pixel, copy its color · `alt+shift+p` |
| **clipr** | everything you copied today · `alt+shift+v` |
| **measr** | point at it, know its size in px · `alt+shift+m` |
| **findr** | every file on every drive, at once · `alt+shift+d` (Windows) |

`alt+shift+space` opens the quick view (your tools in a slim column), `alt+shift+u` the launcher.
Every tool is on after the first start; remove the ones you don't want on the launcher's *tools* page.

### Download

| | File |
|---|---|
| **Windows** 10 / 11 | `utilr-setup-<version>.exe` |
| **macOS** (Apple Silicon and Intel) | `utilr-<version>-mac.dmg` |
| **Linux** (x64) | `utilr-<version>-linux-x86_64.AppImage`, or the `.deb` for Debian / Ubuntu |

utilr is made and tested on Windows. The macOS and Linux builds are early: findr and snip text are Windows only.

### First start

utilr isn't signed with a paid developer certificate yet, so your system will be careful the first time:

- **Windows:** if SmartScreen says *"Windows protected your PC"*, click **More info → Run anyway**.
- **macOS:** open the `.dmg` and drag utilr to Applications. When you first open it, macOS says it can't verify the app. Click **Done**, go to **System Settings → Privacy & Security**, and click **Open Anyway** next to utilr. If macOS says the app *"is damaged"*, run `xattr -cr /Applications/utilr.app` in Terminal, then open it again. snipr, paletr and measr need *Screen Recording* permission.
- **Linux:** make the AppImage executable (`chmod +x utilr-*.AppImage`) and run it. Or install the `.deb` with `sudo apt install ./utilr-*.deb`.

Already have the stand-alone notr or snipr? utilr brings their notes and settings over on the first start. Uninstall them afterwards: they'd hold the same shortcuts.
