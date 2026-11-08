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

`productName`, the window title, `desktop/ui/index.html`'s title, `lib.rs` strings and the launcher's `NAME` become "Rooks". The `identifier` stays `com.inclined88888.aiworkspace`. Tauri 2's `app_data_dir()` is the system data folder joined with the identifier (`~/.local/share/…`, `~/Library/Application Support/…`, `%APPDATA%\…`), the same folder `ai_workspace.data_dir()` computes, and the webview's storage is keyed the same way, so chats, keys and settings stay. Pin `mainBinaryName: "ai-workspace-desktop"` (the launcher finds the real app by it) and keep the `aiworkspace` link scheme. The launcher and `remove_stale_desktop_app()` look for both the old and the new names. The palette's pack scripts rename it to "Rooks Ask.app" so two `Rooks.app` cannot collide. The new mark is its own step (`desktop/app-icon.svg`, then `npx tauri icon`; done, section 7).

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

## 4. As built (engine and API lane, 2026-11-08)

* The pipe ends reach fds 3 and 4 through a short Python step (`sys.executable -I -c`), not the wrapper's `3<&N 4>&M`:
  `sh` cannot name an fd above 9 and a busy server's fds are higher; the step moves both above 10 first so neither is
  closed by the other's `dup2`. bwrap passes them through.
* The request rule is the DevTools `Fetch` domain enabled on the browser itself, so it covers every tab, popup, frame
  and worker; patterns are `file://*` and `*:<app port>/*`, and the host check (loopback, unspecified, this computer's
  own names and addresses) is done in Python. A typed or assistant address is refused before anything loads. The
  policy file is not bound (BACKLOG).
* As root (uid 0) the bwrap step maps the person to uid and gid 1000 inside, since Chromium will not start as root
  with its sandbox on. An engine under the person's home is bound read-only at `/tmp/.room-browser-engine` (on the
  wall's own `/tmp`).
* The live picture's size is the page area: the tab's window is sized with `Browser.setWindowBounds` (not a device
  metrics override, which left the stream at the window's size and clicks off by its scale).
* The app closes the browser from its shutdown as well as `atexit` (uvicorn ends on SIGTERM by raising the signal
  again). A browser whose record still says open, written by another run, also counts as closed by a restart.
* After a restart the front tab loads and the others wait asleep as addresses until opened; `reopened` names them.
* The overview (`GET /api/room/browser`), `POST /start`, `POST /close`, `GET /frame`, `GET /shot`, `POST /act` and
  closing a tab are the person's; the rooks terminal's key reaches exactly `open`, `tabs` and `page`.

## 5. As built (window, assistant and terminal lane, 2026-11-08)

* The window is `room/BrowserWindow.tsx` with the pure parts in `room/browser.ts`. It is offered when `can.browser` is
  true or `browser_off_reason` is one of the four reasons (the window says why); a Room whose own screen is the way
  has none. The desk puts it on the left when open (Screen, then Browser, then Terminal). The browser starts only when
  its window is opened; the default desk does not open it.
* Pointer events carry no click count, so the window counts double and triple clicks itself (500 ms, 5 px). The live
  picture is drawn at the view's size; a click maps through the view the service reports.
* "Phone" is any page not on the computer running Rooks, or any touch screen: the still, taps and Type field.
* The assistant's actions are `room_browser_tool.py`. Elements are numbered by rooks-browser's own snapshot
  (`rooks_try/page_rules.py`, parity tests against `rooks_browser`); a click by number or by a point from `shot`. The
  fresh look before a step (`DESCRIBE`) goes into frames of the same origin and stops at one from another site. A step
  that waits is a held `use_room` call with a `room-browser:` request id and the look it was asked on; after the yes it
  runs once, and only if the same look is still there ("The page changed since you said yes, so nothing was done.").
  Every acting step also asks first (`ROOM_CONFIRM`), so a purchase asks twice (BACKLOG).
* Asked sites: hosts in the person's own messages in this chat (role user, no tool name, not the "[I approved
  request ...]" lines, never in a schedule's, coworker's, MCP or automation chat) and hosts typed into the window's or
  the phone's address bar in this run of the app. Subdomains of an asked site count.
* "The person took the browser": any input from the window or the phone within 20 s of an assistant step. For 2 min
  after, the assistant's steps are refused unless the person said yes to that very step (`Ctx.approved_call`).
* The terminal: `/room browse [--new] ADDRESS`, `/room tabs`, `/room page` in `rooks_code/workroom.py`.

## 6. As built (native-app lane, 2026-11-08)

* The installer: `pick_native_asset(releases, VERSION, platform, machine)` keeps `v*` and `desktop-v*` tags at or above
  `VERSION`, skips drafts and Arm Linux, and takes the newest. `--native` defaults to `auto` in `install_helper.py`,
  `install.sh` and `install.ps1`. Under `auto` a failed download says so and the install goes on. The Windows record
  names the installed program, not "Start menu", so the launcher can open it.
* The question is asked once, by the installer (through `/dev/tty`, also from `curl | bash`; 60 s) or by `ai-workspace`
  in a terminal. With no terminal (Dock, Finder, Start menu, `rooks` starting the app) the launcher opens the usual
  browser with `?shell=ask`; the page asks. A chosen window passes `?shell=window` and the page says it once. With no
  Chrome or Edge on the computer the usual browser is the only way and nothing is asked. `--web` stays a one-launch
  choice made by the person.
* The page's answer: `POST /api/desktop/shell` on the signed-in router (the app.json key and the tools key are refused,
  as everywhere on it), writing only to `AI_WORKSPACE_INSTALL_FILE`, which the launcher sets when it starts the server
  and which must be an absolute path named `install.json`. Without it the route is 404.
* The main window is in `tauri.conf.json` with `create: false` and built in `webkit.rs` with `from_config`, so
  `on_new_window` (web addresses to the system browser, the rest refused), `on_download` (Downloads, a name that
  overwrites nothing, a notification) and `on_permission_request` (microphone only) are attached. The page's own links
  go through `openExternal` and a capture-phase click handler (`routeLinks`) in the app only; files through
  `download()`; copies after a server answer through `copyLater()`.
* `mainBinaryName` is pinned to `ai-workspace-desktop`. The identifier is unchanged, which a test checks against the
  launcher's `IDENT` and `data_dir()`.
* Not verified in a real WebKit window (no Playwright WebKit here): see BACKLOG.

## 7. As built (the mark, 2026-11-08)

The chosen concept, "keep": the chess rook as a plain home-base tower. One rounded slab with three merlons and an
arched doorway lit in gold, meaning the light is on and the assistant is home. Ink tile (`#2A2A28` to `#161615`),
paper mark (`#FAFAF9`), one gold accent (`#E3A82B`). At 16 px it is still a tower with a gold door.

* **Source**: `desktop/app-icon.svg` (1024 units: tile 64..960, tower 288..736 by 224..808, door 448..576).
* **Desktop app**: `npx tauri icon app-icon.svg` from `desktop/` (Tauri CLI 2.12.4, resvg) wrote every file in
  `desktop/src-tauri/icons`; its `android/` and `ios/` folders are not kept (the desktop app does not ship them).
* **Everything else** is drawn by `desktop/scripts/make_icons.py` (Pillow, four times oversampled): `desktop/app-icon.png`,
  the Ask palette's `app-icon.png`, `app-icon-256.png` and `app-icon.ico` (16 to 256), and the phone app's files:
  `icon.png` full bleed with no transparency (the phone rounds it), Android's ink background, the tower alone at 0.75
  scale inside the safe circle, a one colour silhouette with the doorway cut out, the 48 px web icon cropped to the tile,
  and the splash (the tile, which reads on both splash colours).
* **In the app**: `src/ui/RooksMark.tsx` draws the same shapes from fixed tokens (`--mark-ink-top`, `--mark-ink`,
  `--mark-paper`, `--mark-gold` in `tokens.css`), the same in every mode like the icon on the computer. It is the top
  bar's search button (the button keeps its words: "<name>: search or jump to"), sits beside "Rooks" on the welcome
  and sign-in cards, and on the loading screen. `public/favicon.svg` is the tile cropped to its edge.
* **Terminal**: unchanged. "♜" is the only one-character tower; several terminal fonts draw it two cells wide or as an
  emoji, which breaks the banner's width count, so the banner keeps the word.
* **Tests**: `desktop/scripts/test_icons.py` opens every icon, checks its size against what declares it
  (`tauri.conf.json` and Tauri's file names, `mobile/app.json`, the palette's pack files) and reads ink, paper and gold
  back at fixed points of the design, every `.ico` and `.icns` frame included. `tests/brand-mark.test.mjs` guards the
  component, the tokens, the top bar, the welcome card and the favicon.

## 8. As built (after review, 2026-11-08)

* **The app's own address.** `room_browser.listening_ports()` reads the TCP ports this process listens on when the
  browser starts (Linux: the process's socket inodes against `/proc/self/net/tcp` and `tcp6`; macOS: `lsof -a -p`; the
  phone's Wi-Fi door `mobile.LAN_PORT` on the desktop app). `main.guard` passes every request's scope to
  `room_browser.learn`, so a port the app is reached on later is added to a running browser. With no port known the
  browser does not start (`APP_UNKNOWN`). Test servers in the backend suite run in processes of their own for this
  reason (`serve_folder`).
* **Hosts.** `Rules._app` drops dots at the end of a host before it compares (`localhost.`, `foo.localhost.`). Ports 80
  and 443 add `http://*`, `ws://*`, `https://*` and `wss://*` patterns, since Chromium leaves a default port out of an
  address.
* **Keys.** `room_browser_tool._check_key`: `MOVING_KEYS` (Tab, arrows, Escape, PageUp, PageDown, Home, End, Backspace,
  Delete) skip the look; any other key looks at the focused element. Enter or Space on something that is not a field is
  `_check("click", ...)`; any key in a card form, or on a card field, is a purchase; Enter in a form field (not a
  textarea) is sending the form. `Return`, `Space`, `Spacebar` and `Esc` are read as Enter, " " and Escape.
* **Who reads the browser.** `security.require_user_or_terminal_token` (the signed-in person or the Terminal access
  token) guards `/api/room/browser/open`, `/tabs` and `/page`. The shared bridge keys (app.json's, Rooks Desk's, the
  coding jobs') are refused there even for reads: the Room's browser holds the person's sign-ins, and pages steer the
  helpers that hold those keys. The rooks terminal says "Its pages can hold your sign-ins, so reading them needs the
  terminal's own sign in" and names `rooks login`.
* **Offline without bwrap.** `launch_argv` adds `OFFLINE_FLAGS`: `--proxy-server=http://127.0.0.1:9`,
  `--proxy-bypass-list=<-loopback>` (loopback goes to the dead proxy too) and
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`. A closed door, not a wall: a page's own code still runs
  as the person.
* **Settings.** Settings, Tools, "The Room": the switches `app_terminal` (Terminals) and `room_browser` (The Room's
  browser). The Browser and Terminal windows link to `/settings?section=tools`.
* **Installer.** `tty_ask` reads `/dev/tty` through a raw descriptor (a text file opened "r+" on a terminal raises, so
  the question was never asked) and returns None when nobody answers in `ASK_WAIT_S`; `ask_shell` takes None or an empty
  read as no answer and only a typed Enter as the first choice. `pick_native_asset` skips prereleases and returns the
  release's `SHA256SUMS-desktop` address; `install_native` installs only when the download's SHA-256 is the one listed
  there (`NotInstalled` says why otherwise). `app_step` says one line: installed, not installed and why, or none
  published.
* **Tests.** `test_room_browser.py`: the app's port known before any route (a listener in the process), fail closed with
  no port, every request teaches the port, a bridge key refused on `/page` and `/tabs`. `test_room_browser_assistant.py`:
  keys on a focused buy or submit button (fake focus, and real Chromium: Tab, Tab, Enter and Space on "Add to cart",
  Space on Search), and a real uvicorn app refused when the assistant browses first, also as `localhost.` and
  `foo.localhost.`. `test_browser_engine.py`: trailing dots, default ports, offline flags without bwrap.
  `test_native_app.py`: no answer, a real pseudo terminal, prereleases, checksums, one line on a cut download.
  `room-browser.test.mjs`: the Settings switches and where the windows point.
