**notr**: a tiny, always-on-top note app. You open it and you get a note.
[Try it in your browser](https://t-julsgaard.github.io/Notr/) first if you like.

### What's new

- **macOS and Linux** builds, next to Windows
- **Tab / Shift+Tab** jumps to the next / previous note
- `/line` separators come along when you copy text into other apps (as a drawn line), and turn back into separators when pasted into notr
- In a small note, the ⚙ menu no longer covers the ⚙ and × buttons
- ⚙ → shortcuts now starts with a line telling you that you can edit the keys right there
- Fixed: deleting or closing a note while holding `Ctrl`/`Alt` + an arrow no longer shows a "JavaScript error in the main process" box

### Download

| | File |
|---|---|
| **Windows** 10 / 11 | `notr-setup-<version>.exe` |
| **macOS** (Apple Silicon and Intel) | `notr-<version>-mac.dmg` |
| **Linux** (x64) | `notr-<version>-linux-x86_64.AppImage`, or the `.deb` for Debian / Ubuntu |

### First start

notr isn't signed with a paid developer certificate yet, so your system will be careful the first time:

- **Windows:** if SmartScreen says *"Windows protected your PC"*, click **More info → Run anyway**.
- **macOS:** open the `.dmg` and drag notr to Applications. When you first open it, macOS says it can't verify the app. Click **Done**, go to **System Settings → Privacy & Security**, and click **Open Anyway** next to notr.
  If macOS says the app *"is damaged"*, run `xattr -cr /Applications/notr.app` in Terminal, then open it again.
- **Linux:** make the AppImage executable (`chmod +x notr-*.AppImage`) and run it. Or install the `.deb` with `sudo apt install ./notr-*.deb`.
