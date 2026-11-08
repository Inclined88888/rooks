# 0007: A real browser in the Room, and Rooks as its own program

Status: design record, 2026-11-08. Builds on 0003 (honesty rules) and 0006 (the Room's desk, terminals, Files). Lanes: rooks-try, backend, frontend, terminal, desktop. Tests first (section 3); each must fail on today's code.

The owner: "I want an actual browser inside it too, like we have in the room terminal ... and I want this app to be separate entity, then chrome and stuff that has been running on."

## 1. The Room's browser

A Browser window on the Room's desk after Terminal (`room/BrowserWindow.tsx`, `desk.ts`): tabs, address bar, back, forward, reload, the live page, mouse, keyboard, wheel, copy and paste, downloads.

### 1.1 Engine

A real Chromium, started by the app with `--remote-debugging-pipe` (the DevTools protocol over the child's fds 3 and 4, given with `pass_fds` and the wrapper's `3<&N 4>&M`) and `--headless=new`, so no window appears on the person's own screen and the picture is only ever the stream. Never `--remote-debugging-port`, `--no-sandbox`, `--disable-web-security` or `--allow-file-access-from-files`. The profile is `<Room home>/.room-browser/profile`, with sync off, `--use-mock-keychain` on macOS (nothing lands in the person's keychain) and password saving off: sign-ins persist through cookies only.

Where the engine comes from, first found wins (`rooks_try/browser.py: find_engine()`):

1. The Room's own engine in `try-room/tools/browser/`: a pinned Chrome for Testing build, downloaded only after the person says yes ("The Room has no browser yet. Get one? About 150 MB."), checked against a SHA-256 kept in the code. Chrome for Testing has no Linux Arm build; there, cases 2 to 4 only.
2. Playwright's Chromium in the `ms-playwright` cache (install step 3 puts it there when there is no Chrome or Edge).
3. A Chromium from the system's packages. Not the Snap one: Snap confinement refuses a profile outside its own folder and will not start inside the Room's namespace.
4. Google Chrome, then Microsoft Edge, used only as an engine: headless, with the Room's profile, so the person's own profile, sign-ins, extensions and sync are never opened. (Chrome 136 and later refuse remote debugging on the default profile; we never use it.)

Linux and macOS first. On Windows, pipe handles need the STARTUPINFO path Node uses; until that is built and tested, `can.browser` is false there.

Status gains `can.browser` and `can.browser_off_reason`: `no_engine` ("The Room has no browser yet." with a Get one button), `windows` ("The Room's browser is not on Windows yet."), `helper` ("The Room runs elsewhere, so its browser is not here."), `switched_off` (Settings).

### 1.2 Isolation

The environment is `room_env(home, offline)`: secrets scrubbed, `HOME` in the Room. A correction to the brief: the Room's Linux sandbox is `unshare -Urm`, not bwrap, and it maps the person to root inside, where Chromium refuses to start without `--no-sandbox`. So on Linux the browser runs in bwrap when `skill_sandbox._bwrap_ok()`: `--unshare-user --uid <uid> --gid <gid> --ro-bind / / --bind <Room home> <person's home> --dev /dev --proc /proc --tmpfs /tmp --die-with-parent`, plus `--unshare-net` when the Room is offline. Chromium's own sandbox still works inside. An engine under the person's home (cases 1 and 2) is bound read-only at a fixed path before the home bind hides it. A Chromium policy file bound at `/etc/chromium/policies/managed/` (and Chrome's and Edge's paths) blocks `file://` everywhere except the Room's home. Without bwrap, or on macOS, the browser runs as the person with no outer wall. We do not wrap it in `sandbox-exec`: Chromium puts its own Seatbelt around every page process and macOS does not allow a second one (a test confirms this before release). Then `file://` outside the Room's home is refused at the controller for typed and assistant addresses and on every main-frame navigation, and the window says "Not locked off: this browser runs as you."

Everywhere, requests to the app's own address fail (`Fetch`), and pages get no camera, microphone, location or notifications. Honest limits, under Advanced: programs in the Room's terminal can read the browser's profile, sign-ins included; pages reach the local network as any browser's do.

### 1.3 Live view and input

`workbench/backend/app/room_browser.py` mirrors `room_terminal.py`: a registry that outlives sockets, `close_all(reason)`, an `atexit` close. `WS /api/room/browser/ws` uses `room_terminal._refusal` (signed in, same origin, loopback), one viewer at a time. The server sends `Page.startScreencast` JPEG frames as binary messages (at most 1920×1200, newest wins when the socket lags, none when no one watches) and state as JSON. The client's `mouse`, `wheel`, `key`, `text` (IME, paste), `resize`, `nav` and `tab` messages map to `Input.*` and `Emulation.setDeviceMetricsOverride`. Paste: the window reads the `paste` event's text and inserts it, so the Room never reads the person's clipboard otherwise. Copy: on Ctrl or Cmd+C the window writes a `ClipboardItem` whose promise resolves with the page's selection, the one form WebKit allows after a round trip. Popups open as tabs. Downloads go to `<Room home>/Downloads` (`Browser.setDownloadBehavior`) and leave the Room only through Hand off and a yes in Needs you.

Reused from rooks-browser, copied into rooks-try (the app cannot import it) with parity tests: `app/address.js`'s address rules, `page_js`'s element snapshot, `policy.classify`, and `_filename`/`_unique` for downloads.

### 1.4 Persistence, Stop, Start over, save points, restart

The profile is in the Room's home, so logins survive a chat change and an app restart. Open tabs are written to `.room-browser/tabs.json` on every change. The browser starts when the Room is on and the Browser window opens or the assistant uses it, and reopens the saved tabs. Stop closes it ("The Room is off. Everything in it is kept."). At exit: `Browser.close`, then the process group after 3 s; the next start, and `restart.py`'s note, say "The app restarted, so the browser closed. Your tabs and sign-ins are kept." Save a point closes the browser cleanly, copies the home (without `Cache`, `Code Cache` and `GPUCache`), and reopens the tabs: "Saving a point. The browser closes for a moment." Start over closes it and restores the home, so sign-ins made since that point are gone, or the whole profile when the point is older than it. The confirm says so.

### 1.5 The assistant

`use_room` gains `browse` (address, new tab), `page` (text, 8,000 characters), `shot`, `click`, `type`, `scroll`, `key`, `back`, `tabs`. `page`, `shot` and `tabs` join `ROOM_READS`. The rest follow the Room's rules: asked once (`ROOM_CONFIRM`), run log rows, output untrusted. While the assistant acts, the window shows "Rooks is using the browser", and any input from the person takes the browser back ("The person took the browser.").

Waits for a yes in Needs you (a held action the chat tool cannot answer):

* **purchase**, on any site: `classify` says purchase, or the target is in a form with card fields.
* **submit** or **message** on a site the person did not ask for. Asked sites are the hosts in the person's own messages in this conversation and the hosts they typed into the Room browser's address bar. Page text and tool results never add one.
* **login**: the assistant never types into a password field. It asks the person to type it themselves.
* A click that lands on a frame from another site, which the snapshot cannot read.

What is checked: a fresh snapshot of the target element just before each click, type or Enter (role, type, name, value, form action, `in_form`, `is_submit`, `form_has_password`; Enter in a form field counts as submit) and the top page's host. Not checked, said under Advanced: a page's own scripts sending data on an ordinary click or as you type, button words the English patterns miss, and the person's own input. The run log keeps the host and path (no query), the element's name and "(N characters)" for typing, never the text. The person's own browsing is one coarse row, "You used the browser for N min".

### 1.6 Terminal and phone

`/room browse <address>`, `/room tabs`, `/room page` print the same words through `POST /api/room/browser/open`, `GET /api/room/browser/tabs`, `GET /api/room/browser/page` (the terminal key, as `/room` uses today). The phone gets no socket, because the stream is loopback only like the terminals. It shows the address and a still from `GET /api/room/browser/frame` every 2 s, with tap to click, scroll buttons, an address field and a Type field (`POST /api/room/browser/act`). It says: "On a phone you can tap, scroll and type. Dragging, hovering and shortcuts need the computer."

### 1.7 Caps

8 tabs, person and assistant together ("Eight tabs are open. Close one to open another."). The process tree's memory is read every 10 s. Over 1.5 GB, the least recently viewed background tab is closed and kept as an address ("A tab was put to sleep to save memory."). Over 2.5 GB, the browser closes and its tabs are kept. Downloads stop at 2 GB each. The disk cache is 100 MB.

## 2. Rooks as its own program

### 2.1 Install the app by default

`install_helper.py` defaults to `--native auto` (and `install.sh`'s help). `native_asset()` is fixed. Today it takes the first release with a matching `.dmg`, and the newest release is `rooks-native-v0.3.0`, whose `Rooks_0.3.0_aarch64.dmg` is the Ask palette, not the app. It must look only at `v*` and `desktop-v*` tags, and only at assets at or above the install's `VERSION`. 1.0.5 is older than this tree (1.0.6), so until a newer release exists, `auto` installs nothing and says so.

### 2.2 The launcher never silently opens Chrome

`ai-workspace` opens the native app. When there is none for this computer, the installer asks once ("There is no Rooks app for this computer yet. Open Rooks in a Chrome or Edge window, or in your usual browser?") and stores the answer in `install.json`. A launch that uses a Chrome window prints that line and passes `?shell=window`, so the app shows a one-time bar with the same words and a choice. `--status` says which is in use.

### 2.3 The name

`productName`, the window title, `desktop/ui/index.html`'s title, `lib.rs` strings and the launcher's `NAME` become "Rooks". The `identifier` stays `com.inclined88888.aiworkspace`. Tauri 2's `app_data_dir()` is the system data folder joined with the identifier (`~/.local/share/…`, `~/Library/Application Support/…`, `%APPDATA%\…`), the same folder `ai_workspace.data_dir()` computes, and the webview's storage is keyed the same way, so chats, keys and settings stay. Pin `mainBinaryName: "ai-workspace-desktop"` (the launcher finds the real app by it) and keep the `aiworkspace` link scheme. The launcher and `remove_stale_desktop_app()` look for both the old and the new names. The palette's pack scripts rename it to "Rooks Ask.app" so two `Rooks.app` cannot collide. The new mark is its own step (`desktop/app-icon.svg`, then `npx tauri icon`).

### 2.4 WebKit (WebKitGTK on Linux, WKWebView on macOS)

| Used by the app | In WebKit | Fix |
| --- | --- | --- |
| `window.open(_blank)` for sign-ins, plans, packs | not opened by the webview | one `openExternal(url)` through the opener plugin in the shell |
| `<a download>`, `window.open(download)` (Files, Sites, Teammates, Study) | ignored | the shell's `on_download` saves to Downloads and notifies |
| `SpeechRecognition` | missing on WebKitGTK, unreliable in WKWebView | already falls back to recording; offer live dictation only when present |
| `MediaRecorder` | gives `audio/mp4` | already in `mimeType()`; the backend must accept `.m4a` |
| `getUserMedia` | a permission request the shell must answer | grant microphone in `lib.rs`; `Info.plist` has the usage text |
| `getDisplayMedia` (meeting sound) | missing | already guarded; say "Recording the computer's sound needs Chrome. The microphone works." |
| `clipboard.writeText` after an await | refused without a gesture | `ClipboardItem` with a promise |
| `requestIdleCallback` | missing | already guarded |
| `Notification`, `backdrop-filter`, `inert`, `structuredClone` | fine (native notify; prefixed; WebKitGTK 2.38+, Safari 15.5+) | none |

### 2.5 What the owner must do, and what code cannot fix

Push a tag `vX.Y.Z` that matches `VERSION`. `release.yml` makes the release and `desktop.yml` attaches the installers. Then delete or mark the 1.0.5 release as old. Code cannot remove Gatekeeper's and SmartScreen's warnings: that takes an Apple Developer ID with notarization and a Windows signing certificate, as repository secrets. It cannot give an old Linux a WebKitGTK it lacks. Copies installed from 1.0.5 move to the new name only by the installer run again or an update signed with the same updater key.

## 3. Tests

* `rooks-try/tests/test_browser_engine.py`: search order, Snap skipped, `no_engine`, bad SHA-256 refused, pipe present and forbidden flags absent, bwrap binds the home, maps the uid, binds the engine read-only and adds `--unshare-net` offline, no secrets in the env. With a real Chromium (skipped without one): no new listening port (`/proc/net/tcp`), `file:///etc/hostname` refused while a Room file opens, the app's address fails, a download lands in `Downloads`.
* `workbench/backend/tests/test_room_browser.py`: socket refusals; frames and state reach the socket; input maps to protocol calls; tab cap; memory steps (fake reader); tabs and restart words after a simulated restart; Stop, Start over, Save a point close first and the point has no caches; `can.browser` reasons; phone `/frame` and `/act`. `use_room`: reads not asked; purchase held on an asked site; submit held only on an unasked one; a site named only in page text does not count; password typing refused; cross-site frame click held; no typed text or query string in the log.
* Parity: address fixtures in Node and Python; `classify` against `rooks_browser.policy` on one table.
* `rooks-code/tests/test_workroom.py`: `/room browse`, `/room tabs`, `/room page` words and routes.
* `workbench/frontend/tests/room-browser.test.mjs`: Browser offered only with `can.browser`; off-reason words; the phone sentence; copy uses `ClipboardItem`.
* `workbench/backend/tests/test_launcher.py`: default `auto`; `native_asset` skips `rooks-native-*` and versions below `VERSION`; no app and no answer gives a question, not a Chrome window; old and new names found; `IDENT` unchanged.
* `desktop/scripts`: `tauri.conf.json` name, identifier, `mainBinaryName`; a Playwright WebKit smoke run of the built UI (sign in, chat, Room page, a download, an external link).
