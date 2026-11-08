# The Rooks app (desktop)

Tauri v2 shell that turns Workbench into a double-click app for macOS, Windows (and Linux). Its name is **Rooks**
(`productName` and the window title). The `identifier` stays `com.inclined88888.aiworkspace`, so the data folder
(`app_data_dir()`), the webview's storage and the keychain items do not move: chats, keys and settings stay. The
binary keeps its name (`mainBinaryName: ai-workspace-desktop`), which is how the launcher and the installer tell the
real app from the shortcut they make, and the `aiworkspace://` link scheme stays. The small Ask palette in
`rooks-native/` is packed as **Rooks Ask**, so the two never replace each other in Applications or the Start menu.

The installer installs this app by default (`--native auto`) when a release at or above the install's version has one
for the computer. Without one, `ai-workspace` never opens a Chrome window nobody chose: it asks once (in the terminal,
or on the page when started from the Dock or the Start menu) whether Rooks opens in a Chrome or Edge window of its own
or in the usual browser, and keeps the answer (`ai-workspace --shell window|browser` changes it; `--status` says it).

```
desktop/
  ui/index.html              splash shown while the backend starts (bootStatus() is called from Rust)
  sidecar/workbench_server.py  entry point of the frozen backend: keychain secrets, per-user data dir, 127.0.0.1 only
  sidecar/workbench-server.spec  PyInstaller spec (bundles workbench/backend + workbench/frontend/dist)
  scripts/build-sidecar.mjs  freeze + copy to src-tauri/binaries/workbench-server-<target triple>
  scripts/smoke_sidecar.py   CI smoke test of the frozen backend
  src-tauri/
    src/sidecars.rs          sidecar registry + supervisor (start, health check, logs, kill on exit)
    src/approvals.rs         native approve / deny prompt (request_approval) + approval-requested event
    src/commands.rs          app_info, open_data_dir, open_logs, open_external (web addresses only, to the system browser)
    src/webkit.rs            the main window (built in code), and what WebKit does not do alone: new-window links,
                             downloads (saved to Downloads, then a notification), the microphone prompt
    src/updater.rs           in-app updater, compiled in only with --features updater
    capabilities/default.json  which commands the Workbench page (http://127.0.0.1:*) may call
    tauri.conf.json          bundle config (dmg, msi, nsis, deb, appimage)
    tauri.updater.conf.json  overlay used when the updater is turned on
```

## How it starts

1. The window opens on the splash (`ui/index.html`).
2. `sidecars::start_workbench` picks a free port, makes a random launch token and runs
   `workbench-server --port P --data-dir <app data dir> --exit-with-parent` with `WORKBENCH_DESKTOP_TOKEN`.
3. The sidecar loads or creates `APP_SECRET` / `TOOLS_API_KEY` in the OS keychain and serves Workbench with
   `WORKBENCH_DESKTOP=1` and `WORKBENCH_SECRET_BACKEND=keychain`.
4. When `/healthz` answers, the window navigates to `/api/desktop/session?token=…`, which sets the session cookie and
   redirects to `/welcome` (first run) or `/`.
5. On quit the shell kills the sidecar; if the shell crashes, the sidecar sees its stdin close and exits by itself.

## WebKit (macOS and Linux)

The app's page runs in the system webview: WKWebView on macOS, WebKitGTK on Linux, WebView2 on Windows. What a browser
does and WebKit does not, and what the app does instead (docs/design/0007, 2.4):

| In a browser | In WebKit | In the Rooks app |
| --- | --- | --- |
| `window.open`, `target="_blank"` | opens nothing | `openExternal()` and a click handler (`routeLinks`, desktop.ts) send web addresses to the system browser; `on_new_window` refuses the rest |
| `<a download>` | dropped | `on_download` saves to Downloads under a name that overwrites nothing and says so |
| microphone | a prompt the shell answers | `on_permission_request` grants the microphone; camera, screen and location get the system's prompt |
| copy after a server answer | refused | `copyLater()`: a `ClipboardItem` whose content is a promise |
| the computer's sound in Meetings | no `getDisplayMedia` | Meetings says "Recording the computer's sound needs Chrome. The microphone works." |

Checked here: `cargo check` and `cargo test` of the shell on Linux (WebKitGTK 2.52 headers), and the page in Chromium.
Not run in a real WKWebView or WebKitGTK window yet (no Playwright WebKit on the build machine), so the table is the
design and the code, not an observed run.

Logs: `<app log dir>/workbench.log` (previous launch in `workbench.log.1`). Settings → Desktop app has buttons for both
folders.

## Extension points for the next phases

* **New sidecars**: add the frozen binary to `bundle.externalBin`, a row in `SIDECARS` (`src/sidecars.rs`), and
  start it like `start_workbench` does. Settings → Desktop app lists every row, so only list what ships. The
  terminal, browser and computer helpers (`rooks`, `rooks-browser`, `rooks-desk`) are installed beside the app by the
  installer instead.
* **Approvals**: anything that acts on the user's behalf calls `approvals::ask` (Rust) or
  `requestApproval()` from `workbench/frontend/src/desktop.ts`. Workbench's own held tool calls keep using its run log.
* **Settings for keys and connectors**: provider keys go through the existing `/api/providers` endpoints, which store
  them in the keychain in desktop mode. New connectors should use `security.store_connection_secret` the same way.
* **New native commands**: add the function, list it in `build.rs` (`AppManifest::commands`) and in
  `capabilities/default.json` (`allow-<name>`), and wrap it in `desktop.ts`.

## Build

See [docs/desktop-release.md](../docs/desktop-release.md#building-locally).

## Icons

The mark is `app-icon.svg`: the rook as a plain tower with a gold door on an ink tile (design record 0007, section 7).
After changing it, from `desktop/`:

```bash
npx tauri icon app-icon.svg -o /tmp/icons && cp /tmp/icons/*.png /tmp/icons/icon.icns /tmp/icons/icon.ico src-tauri/icons/
python scripts/make_icons.py      # app-icon.png, the Ask palette's icons, the phone app's icons
python -m pytest -q scripts/test_icons.py
```
