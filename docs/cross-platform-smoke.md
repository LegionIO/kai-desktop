# Cross-platform smoke checklist

Manual verification matrix for the platform-adapter layer (computer use, dictation, App Shots). Run on each OS after changes under `electron/platform/`, `electron/app-shots/`, `electron/dictation/`, or `electron/computer-use/harnesses/`.

## Prerequisites

| OS      | Native helper                                       | Required tools                                                                                                 |
| ------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| macOS   | `build/bin/LocalMacosHelper` (built by `pnpm dev`)  | Xcode CLT; grant Accessibility / Screen Recording / Automation                                                 |
| Windows | `build/bin/LocalWindowsHelper.ps1` (staged)         | PowerShell 5.1+ on PATH                                                                                        |
| Linux   | `build/bin/LocalLinuxHelper.sh` + `atspi_helper.py` | `jq`, `xdotool`, `maim` (X11) **or** `grim`/`wtype` (Wayland); `python3-gi` + `at-spi2-core` for introspection |

The fallback path (nut-js + active-win) is exercised in step 5.

## Per-OS pass

1. **Launch & permissions** — `pnpm dev`. Open Settings → Autopilot. Verify the permission rows are platform-appropriate (Accessibility/Screen-Recording/Automation/Input-Monitoring on macOS; PowerShell-helper on Windows; helper/xdotool/screenshot/AT-SPI on Linux) and report the correct granted state.
2. **Computer use** — Start a local-desktop session with goal "open a browser and search for cats". Confirm a screenshot appears in the session panel and a click action lands on the real desktop.
3. **Dictation (introspected)** — Enable dictation in Settings → Voice → Dictation. Focus TextEdit / Notepad / gedit, press the hotkey, speak. Verify text inserts and the overlay shows the introspected (`ax`/`uia`/`atspi`) typing mode.
4. **Dictation (degraded)** — On Linux remove `python3-gi`; on Windows rename `LocalWindowsHelper.ps1`. Repeat step 3 and confirm text still inserts via the keyboard / clipboard fallback.
5. **App Shots (clipboard)** — Settings → Voice → App Shots: enable, leave **Auto-attach** off, set a shortcut. Focus Chrome on a known URL, press the shortcut. Focus stays on Chrome; the capture is on the clipboard. Paste into another app (TextEdit / Word / gedit) → image appears plus a one-line `[kai-appshot:<ref>]` marker. Switch to Kai and paste into the composer → two attachments appear (image + `*.appshot.json`); open the JSON sidecar and confirm `refId`, `app.appName`, `app.windowTitle`, `app.url` (Chrome on macOS/Windows), `selectedText`, and `uiTree`.
6. **App Shots (auto-attach)** — Toggle **Auto-attach** on, repeat the capture; Kai foregrounds and both attachments land directly in the active composer without pasting.
7. **Forced fallback** — Rename the native helper for the current OS so `getPlatformAdapter()` falls through to nut-js. Repeat steps 2 and 5; confirm both still work (without `uiTree` / text introspection) and Settings → Voice → App Shots shows `Adapter: fallback`.

## Known limitations

- **Wayland**: input injection requires `ydotool` (root/uinput) or `wtype`; window-scoped screenshots fall back to full-display via `grim`. X11 is the supported Linux path for v1.
- **`CGWindowListCreateImage`** is deprecated on macOS 14+ but still functional through macOS 26; the `screenshotWindow` path will move to ScreenCaptureKit in a follow-up.
- **`local-macos-helper-source.ts`** (the embedded fallback Swift source) is not regenerated from `LocalMacosHelper.swift`; it is only consulted when neither the compiled binary nor the on-disk `.swift` file is present, so drift is acceptable.
