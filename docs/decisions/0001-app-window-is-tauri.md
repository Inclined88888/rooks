# 0001: The app window is the Tauri app; Chrome/Edge --app is the fallback

Status: accepted (2026-11-04). Replaces the earlier wording "app window = the same UI in a Chrome --app window".

**Later records (note added 2026-11-08).** Design record 0003 (decision W1) keeps this decision: the React app in the
Tauri shell is the one desktop UI, and `desktop/rooks-native` is only the floating Ask palette, not a second app.
Design record 0007 (`docs/design/0007-room-browser-and-native-app.md`, section 2, written on the room-browser branch)
goes further: the Tauri app is installed by default, the launcher never opens Chrome or Edge without asking, and the
app is named Rooks. Until that branch is merged, the one-command install skips the desktop app by default
(`--native no`, "that release is the old app") and opens the Chrome or Edge window described below.

## Decision

The third surface ("app window") is the native Tauri v2 app, AI Workspace.app (desktop/src-tauri). It starts the
frozen workbench-server sidecar on 127.0.0.1, signs its webview in and shows the same web UI. `ai-workspace` opens
it when it is installed (desktop/launcher/ai_workspace.py native_app()). When no native app is installed, or with
`ai-workspace --web`, the same UI opens in a Chrome/Edge --app window. Both are the same UI and the same data.

## Why Tauri and not the spec's Chrome --app

- It is what ships: release pipeline (.github/workflows/desktop.yml, four OS targets), signed updater bundles,
  the sidecar build, keychain handling. Removing it throws all of that away for no user gain.
- Small: 6.2 MB native binary; the installed app is 117 MB, almost all of it the Python sidecar (L3 limit 248 MB).
- It needs no browser installed and survives the user's browser updates and profile settings.
- The Chrome --app path stays as the fallback, so nothing that worked before stops working.

## What follows

- Parity is tested against the shared web UI in Chromium and in WebKit (the engine of the macOS app window):
  docs/history/scripts/audit/ui_screens.py with UI_BROWSER=chromium and UI_BROWSER=webkit.
- #7 (a terminal inside the app) is built in the shared UI (Terminal page, /api/terminal/ws), so the app window,
  and a browser on the same computer, get it from the same code. No Tauri command or extra permission is needed.
- Not yet done: a rebuilt AI Workspace.app run with these changes (needs a sidecar freeze and a Tauri build).
