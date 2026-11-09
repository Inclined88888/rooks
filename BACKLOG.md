# Backlog

Out of scope for the current branch, dropped, or blocked. Nothing is dropped silently: every entry gives its reason.

## Dropped

### 106 and 107: session adapter (QR login, memory only) and its warning and kill switch. Dropped by decision D3.
* Anthropic's terms (https://code.claude.com/docs/en/legal-and-compliance, read 2026-10-28): "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow." Enforcement is "without prior notice".
* For ChatGPT, OpenAI's terms page refused automated reads (403), so its exact wording was not verified. The legitimate route is Sign in with ChatGPT (item 101).
* R5 now reads "legitimate only". `experimental_session_slot` survives only as a reserved value that refuses (docs/design/0001).

## Blocked on someone else

### 101: Sign in with ChatGPT: live check against OpenAI
* Built on feat/cloud-models (`workbench/backend/app/siwc.py`). OpenAI's open-source token-sharing guide (https://developers.openai.com/siwc/token-sharing-open-source, read 2026-10-30) uses dynamic registration (`client_id=dynamic_agent_client` issues an `oaiapp_…` id per install) with a 127.0.0.1 loopback callback, so no pre-approved client id is needed for this MIT open-source app. Commercial distribution would need OpenAI's approval.
* Still open: it is tested end to end only against a fake OAuth server. A maintainer has to sign in with a real ChatGPT account and confirm a reply, the usage-limit errors, and refresh.

## Scheduled later

### Workplace cleanup: what the delete step left (branch cleanup/workplace)

* **For the room-browser branch** (out of scope here because that branch is changing these files): nothing in
  `desktop/src-tauri/tauri.conf.json`, `desktop/launcher/*`, `install.sh`, the logo and icons,
  `workbench/frontend/src/room/*`, `rooks-try/rooks_try/browser.py` or `workbench/backend/app/room_browser.py` refers
  to anything removed here (checked with git grep). They still need the rename to Rooks (section g.4): the desktop app's
  product name "AI Workspace" in `tauri.conf.json`, and the merge of `browser_proxy.py`, `local_agents.py` and
  `handoff.py` into the Room browser (g.2).
* **Settings, Desktop app shows the helper's raw name and a technical line** ("workbench", "Workbench backend: chat,
  run log, approvals, budgets, MCP server", from `desktop/src-tauri/src/sidecars.rs`). Plain words with the Rooks
  rename step.
* **A browser for Paperclip, Hermes and Open WebUI.** They lost the old agent's `/mcp` and `/tools` endpoints, because
  the browser key also answers approvals. Giving them one again needs an HTTP MCP endpoint on `rooks-browser serve`
  with its own key that can start jobs but never answer approvals, and approvals answered by a person in Workbench.
* **No monthly cap on browser steps.** The old agent had `BROWSER_MONTHLY_STEP_LIMIT`; Rooks Browser caps each job at
  50 steps, and `/v1` has no budget of its own. Add a cap in Workbench (it sees every browser model call) if wanted.
* **The browser add-on image is not measured.** It was not built in this session (no Docker daemon); the `browser-image`
  CI job builds it and checks the health check and token. Put its size in the README table after the first run.
* **"What I improved" has no screen.** `memory/Improved.tsx` was deleted unused; `/api/knowledge/improvements` still
  runs. Decide whether Home (to be "Today") shows it, or hide the routes.
* **The trade setting cannot be set any more.** `/api/trade` had no caller; Home and the status answer still read a
  saved trade. Settle it with the Trade, Legal and Study packs (g.3).
* **The sidecar unit test does not run in CI.** `cargo test --offline sidecars` in `desktop/src-tauri` needs a
  placeholder `binaries/workbench-server-<target>` file; no workflow runs `cargo test` for the desktop app.
* **Undecided by the owner:** `cli-launcher/`. `pages/Code.tsx` is now hidden behind Settings, Advanced, Show
  developer tools, not deleted.
* **Developer tools switch: what it does not cover yet.**
  * Chat settings (`/assistant-settings`) still shows the "Terminal access" card, which names the `ws` command and
    `cli/ws`. Hide it with the switch, or move it, once the owner decides `cli/ws` (g.2 merges it into rooks-code).
  * The Stage's terminal card links to `/terminal` when the `rooks` terminal is working; the page opens by address,
    so the link works, but it is the one way into a hidden page from a normal screen.
  * The `rooks` terminal and the phone still show the Trade, Legal and Study packs. The terminal is a developer tool,
    so its packs stay; the phone's Packs screen should read the same `dev_tools` setting.
  * The goals routes (`/api/goals`) had no screen to hide. Nothing calls them but tests; remove them or keep them for
    a future screen (owner's call).
  * Your plan still lists Pro features as "free while in beta". With plan checks off, decide whether the page should
    exist at all for workplace teams (section h, rank 16).
* **For the room-browser branch** (not touched here): if the desktop app's tray, menus or launcher ever link to
  `/terminal`, `/code`, `/runs` or the packs, those pages are now hidden behind the switch but still open by address.
  Nothing in `desktop/` links to them today (checked with grep).
* **`test_room_terminal.py::test_tail_says_busy_and_the_exit_code_honestly` failed once** in a full backend run on this
  branch (912 passed, 1 failed) and then passed three runs of its file in a row. The branch does not touch the Room's
  terminal code; it looks timing sensitive under load. The failure's own output was not kept, so the cause is unknown.
* **Old reports keep their old paths inside.** Files in `docs/history/` mention `docs/evidence/` and `scripts/audit/`
  as they were; `docs/history/README.md` maps them.

### Documents and contradictions: what the documents step left (branch cleanup/workplace)

* **Contradictions still open** (docs/architecture.md, section i): 13, the second terminal client `cli/ws` beside
  `rooks` (g.2, the owner's call); 14, tables created on first use in about 30 modules (the g.2 schema merge); 17, the
  Plan page still lists a Business tier with company sign-in (plan checks are off, but the page shows it); 22, "teams"
  in `team/connect.py` means the unbuilt cloud team sync, not Microsoft Teams (rename it before a workplace pitch).
  3 is open only for the parts listed under "Rooks names" below.
* **For the room-browser branch:** decision record 0001's new note says the one-command install skips the desktop app
  until that branch merges (`--native no`). When it changes the default, change that sentence, the README's
  "Download" and install sections and QUICKSTART's line that the command and download files still carry the old name.
  Link design record 0007 from `docs/README.md` once it is on the same branch (it is not here, so the index does not
  link it).
* **"100 reasons" (docs/README.md) was corrected where an item was clearly false, not re-verified line by line.** Not
  checked against the code: 35 and 36 (skills run without a chat turn, delegated agents loading a skill), 47 (one
  worker), 49 and 50 (Company mission control and templates), 68 (data export documented), 96 to 98 (add-on
  manifest). Check them, or drop the list for workplace copy (section h, rank 16).
* **The CLI launcher example was not run here.** `cli-launcher/README.md` passes the key from `.env` into
  `docker exec -e CLAUDE_CODE_API_KEY` for one command; this session had no Docker daemon. Run it once on a server
  install with the `claude-code` add-on.
* **The VS Code add-on is still called "AI Workspace"** (commands, settings, output panel) and is not on the
  Marketplace. Rename it with the desktop app. Its address lookup reads `~/.config/ai-workspace/app.json`, which
  section g.5 keeps.
* **What only the online checks run** (AGENTS.md): the security scan, the one-command install on three systems, the
  Docker images, the desktop and native window builds and the real-screen runs. `cargo test` for `desktop/src-tauri`
  runs nowhere (entry above).

### Rooks names: what the rename step left (branch cleanup/workplace)

* **The owner must rename the sign-in apps in the Google and Microsoft consoles.** The Google Cloud OAuth client and
  the Microsoft Entra app registration used by `connect.py` (and `oauth_clients.py`) are still called "AI Workspace",
  so the consent screen and an IT admin's list show that name. Until then the admin approval message in `connect.py`
  (`ADMIN_NEEDED`) also gives the old name. After the rename, drop "(the sign-in page may still show its old name,
  AI Workspace)" and its entry in `ALLOWED` in `workbench/backend/tests/test_rooks_name.py`.
* **For the room-browser branch:** the desktop app's product name, window title and release titles
  (`tauri.conf.json`, `.github/workflows/desktop.yml`, `desktop/launcher/*`, `install.sh`) are that branch's. The
  Computer page and `mac_mail.py` now tell Mac users to switch on "Rooks" in Privacy & Security; that matches what
  macOS lists only once the app itself is called Rooks, so ship the two together. Renaming the app makes macOS treat it
  as a new app (screen recording, automation and keychain permissions are asked again); say so in that release's notes.
  `api.py`'s used-sign-in-link page and launcher message were changed here to that branch's exact words; merging it
  will still conflict in `desktop_handoff` (it also adds `shell`): take that branch's version.
* **Other surfaces still say "AI Workspace" or "Workbench"** (not scanned by `test_rooks_name.py`, which covers the
  server and the built screens): the `rooks`, Rooks Browser and Rooks Desk help texts (`--db` "Workbench database";
  their model choice and messages now say "the Rooks app"; Rooks Desk's macOS permission steps still say AI Workspace,
  which is what macOS lists until the desktop app is renamed on the room-browser branch), the phone app (pairing screen title and steps, the default name), the VS Code add-on,
  `cli/ws`, `companion/macos`, `setup.sh`'s other lines and `install-server.sh`, `install.ps1`, QUICKSTART's and the
  README's install steps (their titles say Rooks now; the command and files keep the old name until the room-browser
  branch), most other docs, and many code comments and docstrings. Extend the scan to each when it is renamed.
* **Slack and Discord bots made before the rename keep their name.** The manifest for a new Slack app says Rooks;
  an existing one is renamed in Slack's app settings by its owner.
* **Split `api.py`** into auth_api, providers_api, day_api, mail_api and research_api (section g.4), keeping every
  path. Left for later: the room-browser branch is changing `api.py` (desktop shell choice), so splitting now would
  turn its merge into a rewrite.

### One memory: what the merge step left (branch cleanup/workplace)

* **A teammate's own notes are still their own store** (`tm_notes`, `teammates/memory.py`, encrypted with the
  workspace key). The task named three stores; this is a fourth, per teammate. It could become `kn_memories` rows
  with `scope = assistant:<id>` (the swap point the module's docstring describes), with its own move.
* **The terminal's offline memory** (`memory.json` in `rooks-code/rooks_code/learning.py`, used only when the app is
  not connected) is not moved into the app when the terminal is later connected. Offer to copy it on `rooks login`.
* **The predicates are loose.** "role" matches any "is a ..." sentence, so "My dog is a labrador" would replace "The
  user is a nurse in Sydney" in the prompt (kept as history, shown by "why"). Before this branch the same match made
  both facts wait as a conflict, so it was already wrong, only quieter. Since the review, a pinned fact (chat's
  remember pins what you say about yourself) or your own word is never replaced by an unpinned guess: that waits
  under "Needs your call". Still open: a fact chat saved for you as "fact" or "preference" is not pinned, so a
  later guess with the same loose predicate replaces it (shown by "why", and forgetting the guess brings it back).
  Chat's remember tool and the background learner both save with source "chat"; telling them apart would let the
  rule protect everything you asked to keep. Tighten `PREDICATES` in `knowledge/memory.py` with tests from real
  sentences before relying on it for more than where you live and work.
* **Sensitive memories are shown only on the Memory page.** The terminal's `/memory` (`/v1/rooks/memory`, the bridge
  key) and `ws memory` (`/api/memories`) leave them out, like every list that can reach a model in the cloud. If the
  terminal should show them to the person, it needs a list that is printed and never put into a prompt, behind the
  person's own sign-in rather than a shared key.
* **`cli/ws` keeps a read-only `/api/memories`.** The terminal chat client signs in with the Terminal access token,
  which `/api/knowledge` refuses, so the list it prints stays on the assistant routes. When `cli/ws` is merged into
  `rooks` (section g.2), remove the route and point the CI image check's 401 sample (`scripts/ci/check-image.sh`)
  at another signed-in route.
* **The move does not apply "newer replaces older" to facts it moves.** Two old facts with the same predicate (lives
  in Brisbane, moved to Sydney) both stay in use after the upgrade, as they were before; the next statement about the
  same thing replaces both. Doing it at upgrade would hide facts the person saw yesterday.
* **The old categories are folded into tiers.** About you, Your work, People and Other things become "About you and
  your work" (`profile`); Formats and tone and How you like things done become "How you like things done"
  (`procedural`). The Memory page groups by tier. If people miss the finer grouping, add a category column.
* **Facts sealed with an older app secret stay in `adapt_facts`.** They could not be read before either. Nothing
  shows them; a Data safety line could say how many there are and that the old secret would bring them back.
* **The job classifier called "Please remember that I live in Sydney" a legal review** (seen in the real run, on the
  Memory page's "The work I've seen"). `adapt/jobs.classify` matches too eagerly; not changed here.
* **`test_knowledge.py::test_api` fails when it runs right after some other files** (seen with test_adapt,
  test_assistant, test_auth_boundaries, test_coworker_guards, test_rooks_link and test_v02_core in one run):
  `PRAGMA integrity_check` reports "malformed inverted index for FTS5 table main.messages_fts". The same order fails
  on the tree before this branch, so it is not from the memory change; the full suite's order passes. Find which test
  leaves the chat search index broken.

### Other scheduled items

* **Rooks Browser app: what the preview still lacks** (`rooks-browser/app`, landed from `feat/browser-app` after review, CHANGELOG
  2026-11-07). It starts with `npm start` only: no packaging or installer entry, no code signing, so it is not in `install.sh`,
  the desktop app or the Room yet. No tracker blocking. "Ask about this page" is a job through the task helper (the page's text
  goes to a model the same way a task does), not a local read. The agent's clicks are synthetic mouse events; a real click by the
  person is not yet read as a takeover (typing and the address bar are). Download by URL fetches without the tab's cookies, so a
  file behind a sign-in cannot be saved that way. The receipt has no per-host resource rows (the Chrome driver adds one per host).
  macOS and Windows are untested; CI runs the app's tests on Linux only.
* **The coworkers' live mail slice runs only where Dovecot is installed** (`test_starters.py`), so CI skips it. Install
  `dovecot-imapd` in the backend job, or add a variant on the suite's mail fake.
* **Windows: no containment for terminal commands.** The default mode runs them with the user's permissions and the approval line
  says so. A Windows sandbox (AppContainer or a restricted token) is the real fix.
* **The Companion token in `~/.rooks/companion.json`** is read by the notch app and by agent hooks and answers Companion requests,
  so it sits inside the same operating-system-user boundary as the other 0600 files (docs/security/agent-credentials.md).
* **Glass navigation is a design decision for the owner to confirm** (CHANGELOG 2026-11-07, integration entry).
* **Haiku 5.5's long-prompt price tier** is priced in the terminal only; the app shows the catalog list price.
* **The Workbench image push** (`ghcr.io/inclined88888/ai-workspace-workbench`) is denied: the package belongs to the old repository.
  Fix on GitHub: the package's settings, Manage Actions access, add `rooks` with write.

* **Claude Code launcher add-on (Item 116, decision D2).** Merged to `main` as an optional official CLI hand-off in `cli-launcher/` (Compose profile `claude-code`). Item 117 (Codex) is merged on the same transport. Still open: a maintainer has to validate live subscription login and a real prompt. Node stays in the add-on (R6).
* **Idempotency across interleaved writes (item 28 follow up).** A model loop of the form A, B, A runs A twice, because a repeat is only recognised when no other change ran in between (so toggles keep working). Closing it needs per tool semantics (which writes are naturally idempotent). Design record 0001, "Idempotency keys".
* **The web chat does not send an Idempotency-Key yet.** It never retries a request, so there is nothing to deduplicate; the CLI (item 84) should send one.

* **Add-on egress is not in the outbound audit log (item 75 follow-up, R8).** The browser agent's own page loads, model downloads by the ollama container, Paperclip and Open WebUI connect from their own containers. The browser agent already lists visited URLs in its job steps; ingesting them as `egress` rows (and asking Paperclip/Open WebUI for an equivalent or documenting their egress) would make local-only mode verifiable for the whole stack, not only Workbench.
* **Audit log retention.** `egress` rows are kept forever. With Telegram on, long polling adds about 2,880 rows a day (estimate, not measured). Needs a retention setting with a documented default, and an export before pruning.
* **Link egress rows to the run that caused them.** Egress rows have no `parent_action_id`; a context variable carrying the current turn would put a turn's outbound calls in its trace.

## Found during work, not yet scheduled

### Rooks as its own program (design 0007 part 2): not done here
* **Not run in a real WebKit window.** Playwright's WebKit is not installed on the build machine, and no Mac was at
  hand. Not verified, each needs a run in the built app: `<a download>` and blob downloads reaching `on_download` in
  WKWebView and WebKitGTK; `on_new_window` catching `target="_blank"`; the microphone grant in WKWebView with
  `Info.plist`'s text; `ClipboardItem` with a promise in WebKitGTK (older than 2.40 lacks it, the copy then falls back
  to `writeText` and can be refused); live dictation (`SpeechRecognition`) is offered only where present.
* **A Playwright WebKit smoke run of the built UI** (sign in, chat, Room page, a download, an external link), as 0007
  section 3 asks: needs `npx playwright install webkit` on CI.
* **The owner's release steps** (code cannot do them): push a tag `vX.Y.Z` matching `VERSION` so `desktop.yml`
  attaches installers; mark the 1.0.5 release as old; Apple Developer ID notarisation and a Windows signing
  certificate for Gatekeeper and SmartScreen.
* **The new mark** is applied (CHANGELOG, 0007 section 7). Left: the macOS Dock and Windows taskbar pictures are
  checked as files only (`desktop/scripts/test_icons.py`), not seen in a built app; a phone build (`eas build`) has not
  been run with the new layers; the terminal banner keeps the word "Rooks" (no glyph reads well in every terminal font).
* **Windows**: the NSIS install folder follows the product name (`%LOCALAPPDATA%\Rooks`); the installer quietly runs
  the old folder's uninstaller. Not run on a real PC.
* **macOS in-place update** from 1.0.5 keeps the bundle's old name ("AI Workspace.app") until the installer runs again.

### The Room's browser (design 0007), engine and API lane: not done here

* **The packaged app's browser is proved only in CI with the runner's Chrome** (`smoke_sidecar.py --room-browser`,
  macOS and Linux). Not covered there: a Mac with only Edge or Chromium, a Linux runner where bwrap's wall is on (the
  Ubuntu runner may run it without the wall, which the window says), and Windows (no Room browser yet, design 0011).
* **Telling a wall failure apart** reads what bwrap printed (`bwrap: …`). A wall that fails without printing that is
  reported as "the browser refused to start"; the Advanced detail still shows what was printed.

* **The Room's own engine download.** `install_engine` checks a downloaded archive against a SHA-256 and refuses one
  that reaches outside its folder, but no Chrome for Testing build is pinned yet (URL, version and its real SHA-256 per
  platform), and there is no "Get one?" route or button. Until then the engine is Playwright's Chromium, the system's,
  Chrome or Edge, or `no_engine`.
* **The Chromium policy file** (`/etc/chromium/policies/managed/`) the record names is not bound: bwrap cannot create
  that mount point under a read-only `/` when the folder does not exist. The request rule (the DevTools `Fetch` domain
  at the browser level, every target) refuses files outside the Room's home and the app's address instead, with or
  without bwrap.
* **macOS.** The engine search, flags (`--use-mock-keychain`) and memory reading (`ps`) have macOS paths, but nothing
  was run on a Mac; the record's Seatbelt check before release is still to do.
* **File uploads** (a page's file picker) are not wired: headless Chromium cancels the chooser. Choosing from the
  Room's files is the way.
* **Copy** returns the page's selection (`{"type": "copy"}` on the socket); the window writes it with a
  `ClipboardItem` (done in the window lane).
* **The phone's taps** are not in the run log (only the window's coarse "You used the browser" row is).
* **A window that opens before the Room is on** gets the socket closed with "The Room is off. Start it first." and
  must open again after Start.
* **Uvicorn ends on SIGTERM by raising the signal again**, so `atexit` does not run at a normal stop; the browser is
  closed from the app's shutdown instead. The Room's terminals still rely on `atexit` (their restart record is right
  either way, since a record without an end counts as ended by the restart).

### The Room's browser (design 0007), window, assistant and terminal lane: not done here

* **"Get one?" for the Room's own engine** is not there: with no engine the window says "The Room has no browser yet."
  and offers Check again (the engine download is the engine lane's open item above).
* **Switching the Room's browser or terminals on and off from the rooks terminal**: the switches are in Settings,
  Tools (done after review); the terminal has no `/room browser on|off` yet.
* **Enter in a field outside a form** (a chat box made of a textarea or an editable area that sends on Enter) is not
  checked as sending a message; Enter or Space on a focused button or link, and Enter in a form field, are.
* **A held key step is matched by the key, not the element**: a second Enter on another element while one waits is told
  the first is already waiting (after a yes the step runs only if the same element still has the focus).
* **WebSockets to the app's own address** are not refused by the request rule (Chromium's `Fetch` does not see them);
  the app's sockets refuse them anyway (sign-in cookie, same origin, loopback page), and the Room's browser has no
  sign-in cookie of the app.
* **The app's address on the local network** (the computer's Wi-Fi address and the app's port) is refused only when the
  computer's own name resolves to it.
* **The Room browser's real Chromium tests on CI** now fail instead of skip (`ROOM_BROWSER_TESTS_REQUIRED=1`, bubblewrap
  installed); not yet seen green on a CI runner from this branch.
* **Typing with an input method** (Chinese, Japanese, dead keys): the live page takes key presses and paste; composed
  text from an IME is not sent yet. The phone's Type field works for any text.
* **The assistant's every acting step asks first** (the Room's rule), so a purchase asks twice: the Room's own yes, then
  the purchase's. A per-chat "use the Room's browser" yes would cut that to one; it is a decision for the owner.
* **The assistant sees no picture:** `shot` gives what is in view and where (boxes), not an image; the picture is on the
  window for the person.
* **What is not checked** before a click (said under Advanced): a page's own scripts sending data on an ordinary click
  or as you type, button words the English patterns miss, and the person's own input. A purchase button labelled only
  with an icon is not seen as one.
* **The browser's start thread.** On Linux the browser is started from the app loop's worker thread and bwrap's
  `--die-with-parent` ends it when that thread ends. The app's default executor keeps its threads for the app's life, so
  this holds today; a dedicated long-lived starter thread would make it independent of that.
* **Asked sites the person typed** are kept for this run of the app only; after a restart the assistant's form sends on
  them wait for a yes again until the person types the address or names the site in the chat.

### The Room as a small computer (design 0006): follow-ups, each its own record or line

* **"Since you were here" and an Activity window.** New programs in the Room's bin folders, files changed and points
  saved since the person last looked, with a `seen` marker. The Files window already shows that nothing was wiped.
* **A read-only file preview in Files** (`GET /api/room/files/read`). Files lists one folder at a time and changes nothing.
* **Terminals through the helper.** `rooks-try serve` (`TRY_URL`) hosts no terminals and no Files; its status says
  `can: {terminal: false, files: false}` and the page keeps the Commands window ("A terminal needs the Room on this
  computer."). Hosting the registry in the helper and proxying the WebSocket through the app would close it.
* **Windows terminals.** `terminal_pty` and the Room's terminals are POSIX only; a pseudo terminal through ConPTY is
  the way. Windows keeps the Commands window with a login Git bash (or Command Prompt, which says so).
* **A shell inside a QEMU guest** (serial or ssh console). Until then a separate computer has no Terminal window and no
  Files (`terminal_argv` is None), and Advanced says "Files live inside the separate computer. Use its screen."
* **Shells that survive an app restart** (`tmux` around the login shell). Today a restart ends every Room terminal; it
  is listed greyed with its text, the restart note says so, and its files stay.
* **A live theme switch re-theming an open xterm** (the app's Terminal page has the same gap).
* **The loopback rule on a Room that is a virtual machine.** The terminal's screen opens only on the computer running
  Rooks, even when the Room is a guest with `isolation: vm`; relaxing it there is a decision for the owner.
* **Recording click, drag, scroll, type and key steps in the run log** (from 0003 B2, listed again below).
* **Found while building lane B of 0006:**
  * Ended terminals count toward the four. After Stop with four open, the person must Close an ended one before a new
    terminal opens, and the chat tool cannot close one (use_room has no close); `start` then answers "Four terminals
    can be open in the Room. Close one to open another." Decide whether `start` may drop Rooks's own oldest ended one.
  * Start over forgets the terminals it closed (their records and logs go with the folder they stood in), so they are
    not listed greyed afterwards, unlike Stop. The record asked for one new "Terminal 1" and the cap of four; keeping
    them would have left no room for it.
  * The exit code of a command comes from a marker the Room's `~/.profile` (bash) and `~/.zprofile` (zsh) print; with
    sh, dash, fish or a profile the person replaced, busy still works (the foreground process group) but a started
    command's end and exit code are not known, and no "done" row is written.
  * A Room terminal gets its controlling terminal from util-linux `setsid -c` on Linux; on macOS it is a plain new
    session, so a shell that does not take the terminal itself (not bash or zsh) runs without job control there.
  * The WebSocket was tested through the test client with the loopback check allowed, as the app terminal's tests do;
    a real browser on this computer (uvicorn, a loopback Origin) was not driven in lane B.
  * Switching terminals off in Settings stops new Room terminals and the screen, but leaves open ones running and
    reachable through tail and send.

### Premium pass (2026-11-07): left undone, recorded at verification

* **Page caching is partial.** Jobs, Tasks and reopened chats show cached data at once; Settings, Teach, Company and
  Groups reload each visit, and Teach, Company and Groups keep their own pollers instead of the shared pulse.
* **Legacy controls.** Some inner controls on Team, Channels and the trade pack still use the old `.btn` and `.input`
  classes (already on the v3 tokens, not yet the primitives).
* **Address bar routing.** Typing `/mcp` directly reaches the backend's MCP route and shows a plain error page; the app
  links to `/extra-tools` and redirects `/mcp` only inside the app. Fix: a server side redirect for GET `/mcp` from a
  browser, or rename the backend mount.
* **Theme compatibility.** The backend, the phone app and saved settings still use the old theme ids; the web app maps
  them (`themeSync.ts`: light to `gallery`, dark to `night`). `rooks-browser --theme` accepts only light, dark,
  contrast and auto, not legacy names such as `cherry` (`ROOKS_THEME` does map them).
* **Redaction copy drift (pre existing).** `rooks-browser` keeps a copy of the backend's `redact.py`; the backend gained
  PEM and AWS patterns, so `rooks-browser/tests/test_units.py::test_redaction_is_a_verbatim_copy_of_workbench` fails at
  the branch's base commit and at its tip.
* **Fixed in phase 1a: terminal approvals with the bridge key.** `POST /v1/rooks/approvals/{id}` now refuses every
  bridge key (app.json, desk, coding job) with 403; only the Terminal access token records an answer, and only for a
  prompt the person's own terminal raised. A prompt raised with the coding job key (request id `terminal:job:`) is
  answered in the signed in app only, the token included, here and in `POST /api/needs-you/a:{id}/...` (which refuses
  it unless signed in; the list marks it `in_app_only` and the terminal's /needs sends no answer for it). The terminal
  that asked may withdraw its prompt (`/withdraw`, outcome `withdrawn`): the card closes and it can never become an
  approval; a coding job withdraws only its own prompts and no other key withdraws a job's. Tests:
  `test_auth_boundaries.py::test_a_shared_key_never_answers_a_terminal_prompt`,
  `::test_a_prompt_raised_by_a_coding_job_is_answered_only_in_the_app`,
  `::test_needs_you_never_answers_a_coding_jobs_prompt_with_the_terminal_token`,
  `::test_only_the_side_that_asked_withdraws_a_terminal_prompt`, and over real processes
  `rooks-code/tests/test_shared_loop_e2e.py::test_a_program_holding_the_apps_key_cannot_answer_the_terminals_prompt`.
* **What remains of it: the stored Terminal access token.** Anything running as the person can read the token
  `rooks login` keeps in `rooks-keys.json` and answer a prompt the person's own interactive terminal raised (the token
  is accepted for those by design: `test_the_terminal_token_answers_the_persons_own_terminal_prompt` shows a row raised
  with the app key answered by the token). So a program the agent started earlier in the same session (a background
  command the person approved) could still answer a later prompt while the person is away from the keyboard. Not
  proven closed: binding an answer to the terminal process that asked (a per prompt secret held only in its memory)
  or keeping the token in the OS keychain would narrow it. Coding jobs the app starts are covered (their prompts refuse
  the token). Without `rooks login` the person's answer typed in the terminal is no longer recorded in the app; the
  card is withdrawn instead and the terminal says to run `rooks login`.
* **Not tested with a real model.** Every chat, Room and approval flow on this branch was tested with the scripted
  harness model only; no provider key was available.
* **Versions.** The terminal reports 0.1.0 (`rooks-code` package) while AGENTS.md calls the install 1.0.0.

* **Four backend tests fail in the full run on `main` (b09f947) and on `feat/workroom`; each passes alone (verified
  2026-11-07 at both commits).** `test_connect_mail_calendar::test_assistant_reads_and_drafts_with_microsoft`
  (`assert False`), `test_desk::test_desk_emails_a_render_with_attachments` (`'a@work.example' == 'me@example.com'`),
  `test_health::test_status_page_reports_every_part_and_the_worst_wins` (`'down' == 'ok'`) and
  `test_lock_reset::test_forgotten_pin_can_be_replaced` (`429 == 200`, the in-memory login throttle) fail with the same
  assertion at both commits. They are test isolation problems (state left by earlier tests), not environment
  failures as earlier notes said. rooks-code's `test_project_sandbox` is environmental (`bwrap` is not installed in
  the container). Fix or quarantine them on `main` with their own record.
* **Compaction forgets its level on restart, and only one level per chat and model is kept (B3 of feat/workroom).**
  `assistant._SHRINK` remembers in memory how far a chat's window had to shrink so the next turn starts there; after a
  restart the first turn of such a chat pays one failed model call again before it compacts. Keeping the level in
  `conversation_summaries` would remove that call. Also, a `prompt too long` answer from a provider that is really a
  per-minute token limit (Groq's 413) is compacted rather than waited out; harmless, but it shrinks more than needed.
  Older quirk left alone: any other provider 4xx (not 429, 401, 403 or 404) is classed as "not responding", because
  `ProviderError` always carries 502. The `prompt too long` phrasings are tested only against fake servers.
* **A restart note is a system row the thread does not show yet (B3 of feat/workroom).** `restart.py` writes
  `role: system, name: restart` into the conversation ("Rooks restarted during this turn. These steps were cut off and
  not run: ..."). The model reads it as an automatic note; `GET /api/conversations/{id}` returns it; the chat's
  `rebuildTurns` ignores system rows. The thread still does not show it after lane F (`chat/Thread.tsx` keeps only
  user and assistant rows; `rebuildTurns` has no system branch), so on reload a cut off turn carries no note; render
  `role: system, name: restart` rows as a turn notice, the way the live `resumed` event is shown. The terminal
  (`rooks`) does not show it either, and its shared loop passes the `resumed` and `compacted` events by in silence.
* **Goals resumed after a restart run at once, side by side (B3 of feat/workroom).** `restart.resume_goals` starts
  one turn per opted in goal when the app comes up, with no cap and before the person has seen the app; a limit (one
  at a time, or a short delay) is a decision for the owner.
* **The Room's pointer and keyboard steps are not in the run log (B2 of feat/workroom).** `/api/room` records up,
  down, saved points, start over, commands and copies out (channel `room`); click, drag, scroll, type and key are not
  recorded, because a person stepping in produces several a second and would swamp the log. Design 0003, section 4,
  rule 4 says "every Room action"; decide whether to record them in batches (one row per step-in session) or to leave
  them out and say so on the page.
* **Done in B3: a repeated hand-off request no longer makes a second held item.** `room.request_handoff` joins a
  pending request for the same file and place (`already_asked`), and the chat turn stops asking.
* **Fixed in phase 1a: the Room MCP server took the calling agent's `approve: true` on handoff.** `rooks-try mcp`
  drops the flag (an `approve` the agent sends is ignored) and asks the person with MCP elicitation, as Rooks Desk
  does; a client that cannot ask gets `waiting_for: "a person"` and nothing is copied. rooks-code's MCP client now
  declares elicitation and puts the question to the person (also with `--yes`, mirrored to Needs you when linked); a
  question that is not a single yes or no is declined. Tests: `rooks-try/tests/test_mcp_handoff.py` (the real
  `rooks-try mcp` over stdio) and `rooks-code/tests/test_e2e.py::test_an_mcp_servers_question_*`. What remains: an
  MCP client that answers elicitation by itself (some clients auto-accept) is outside our control; the Room's HTTP
  helper (`rooks-try serve`, `POST /api/handoff` with `approve`) still trusts its caller: it needs the helper's key
  (`ROOKS_TRY_API_KEY` or `TOOLS_API_KEY`, which `security.scrub_env` keeps from child processes) and the app calls it
  only after a yes in Needs you. Not re-checked in phase 1a.
* **The Room has no real screen on macOS and Windows yet.** Only the private folder and shell (and the drawn terminal
  by name) work there; a virtual machine driver (Apple Virtualization or QEMU with a guest agent and an in-process
  screen viewer) is the next driver behind the same interface. Design 0003 records this as out of scope for the branch.
  The QEMU driver itself is untested here (no QEMU, no `/dev/kvm`): its screen and pointer need `vncdotool`, its
  commands a guest agent. The `namespace` isolation is Linux only and needs unprivileged user namespaces.

* **Presence polling fills the outbound audit log with loopback rows (R8 follow-up, found in B1 of feat/workroom).**
  Every call to the desk and browser helpers on this computer is an `egress` row (effect `local`). The presence strip
  polls every second; `needs_you` keeps the helpers' answer for five seconds, so with both helpers on an open app adds
  about 35,000 local rows a day on top of Telegram's 2,880. Two ways out, both decisions for the owner: the retention
  setting already listed above, or exempting loopback helper polls from the audit (they never leave the machine, and
  `local_only` ignores them anyway). Until then the five second keep is the only brake. The same decision covers the
  open Needs you sheet, which asks the helpers fresh every five seconds, and the Room's picture in `TRY_URL` mode,
  where each frame is one audited request to the helper.
* **A yes in Needs you starts the Room without opening the Stage (F2/F3 of feat/workroom).** `assistant.decide`
  runs an approved `use_room up` with a `Ctx` that has no live queue, so `_publish_watch` sends no `watch` event and
  the stored row is the plain '[I approved ...]' line, not the Room card; only an `up` that runs inside a turn opens
  the Stage. Either publish to the conversation's open turn (or let the Room page's status store, which already shows
  the Room as on, open the Stage) or say on the card that the Stage opens from the Room page.
* **The terminal cannot see the presence line or the Needs you inbox (B1 of feat/workroom).** `GET /api/presence`
  and `GET /api/needs-you` have no `/v1/rooks` route. The terminal's `/v1/rooks/approvals` only raises and answers
  its own file and command approvals (request ids `terminal:`), which do show in the app's inbox; a Room hand-off or
  any other held item is answered in the app only, and in the shared loop the terminal just prints that the tool is
  waiting in the app. Decide whether `rooks` gets a bridge route for the inbox (and a `/needs` command) or whether
  presence stays an app only feature; AGENTS.md says the surfaces must match.
* **Frontend gaps left by F1 to F4 of feat/workroom.** On the chat page the first Tab reaches the composer, not the
  skip link (`pages/Assistant.tsx` scrolls the thread end into view on every change). Approval cards print raw
  arguments through `argsLine` (`chat/turns.ts`), ids included, and the Room's stored status shows its home folder
  (`HIDDEN_KEY` lacks `home`); decide whether the card must show the exact arguments or a plain line. The Room's
  picture is a full PNG every second with no diffing or frame rate control, and the isolation badge shows twice on
  the Room page. The `TRY_URL` path to a separate `rooks-try serve` is tested only against a fake helper.
* **Smaller open gaps from feat/workroom, one per line:**
  * QUICKSTART.md does not name `rooks-try` (the Room), still says "All three use the same models" and lists only `rooks` and `rooks-browser` as uv tools (outside the docs lane of this branch).
  * rooks-code/README.md does not say that `rooks-desk` and `rooks-try` are added as the untrusted MCP servers `desk` and `room`, nor the `[mcp] desk = false` / `room = false` and `ROOKS_DESK_MCP=0` / `ROOKS_TRY_MCP=0` switches (outside the docs lane of this branch).
  * The Room's approval card gives one fixed reason for every Room action; building it from what the Room says it is (private folder, private desktop, guest) would be clearer (review finding honesty-copy-7, judged polish).
  * A reloaded chat timeline has no tool arguments (the conversation rows carry only tool names), so a step reads "Using the Room" until opened and the run log fills it in.
  * The step detail is drawn below the whole timeline with a caption, not under the step that was picked; the `Timeline` primitive has no slot for it.
  * Conversation titles are clipped at about 80 characters when stored, with no ellipsis.
  * History prints the raw model reference in "Default model changed to ..." (`history.py`), and the Tasks page prints due dates as ISO dates.
  * The Room's double click is sent as two single clicks close together; the program in the Room decides whether it is a double click.
  * The Stage's terminal surface only points to the terminal page; it does not embed the terminal.
  * The browser and desktop surfaces on the Stage were not exercised live (no Rooks Browser or Rooks Desk in the build container).
  * Only Studio and Lamp were captured on the new shell; Sunshine, Paper, Cherry, Neon, High contrast and Linen, the Beside screen picker and widths between 900 and 1280 px were not checked by eye; Automations was checked only with an empty list.
  * The terminal window stays dark in both modes (`--screen-*` tokens and the xterm theme in `TerminalPage.tsx`); a terminal that follows Studio and Lamp needs both changed together.
  * The no-hex guard does not catch named colour words.
  * The `Tabs` primitive is built but no page uses it yet; `PackTrade.tsx` keeps its own small dictation hook instead of `DictateButton`.
  * The desktop sidecar does not start `rooks-try serve`; the desktop app uses the Room in process.
  * `test_needs_you::test_unknown_ids_are_404` gained a "GET is 200" precondition after it was found passing vacuously; the precondition was not re-run against the old code.
  * No linter is installed in `~/.venvs/aiw` or `~/.venvs/rooks`; the branch's Python was byte-compiled and tested, not linted.
* **Windows skill sandbox (AppContainer/Job objects).** macOS Seatbelt and Linux bubblewrap are implemented; Windows isolation is planned but not wired. `isolation_layers()` reports "Windows isolation not implemented (AppContainer/Job objects planned)". See docs/skills-security.md for the design.
* **Deleted conversation ids are reused, and the run log follows the id.** `conversations.id` is a plain `INTEGER PRIMARY KEY`, so deleting the newest conversation lets SQLite give its id to the next one. `actions` rows are kept on delete (the ledger, R2) and still carry the old `conversation_id`. The new conversation's trace then shows the deleted one's turns and tool calls. Found by a test in feat/rea-p0-harness. Fix: `AUTOINCREMENT` on conversations (needs a table rebuild in a migration), or null `actions.conversation_id` on delete.
* **Bridge tokens for other local tools (item 103, Phase 1).** `/v1` accepts only `BROWSER_API_KEY` today. Other OpenAI-only tools (editors, scripts) need user-created, revocable bridge tokens and streaming (`stream: true` is refused with 400 for now).
* **Browser runs are not linked to the chat turn that started them.** Their `model_call` rows carry channel `browser` but no `parent_action_id`. Passing the turn id through the job would put them in the turn's trace (item 21 UI).

* **Live-key check of the new protocols.** The `responses` and `anthropic_messages` adapters pass contract tests against their documented and SDK-typed wire formats, but have not been run against the live APIs (no keys in this environment or CI). Manual check: one tool-using turn and one stream with a real OpenAI key and a real Anthropic key; record the result in docs/design/0002.
* **Native Anthropic for migrated connections.** Connections from before schema 2 keep Chat Completions through Anthropic's compatibility layer, which Anthropic says is for testing. Consider prompting the user to switch once the live-key check above passes.

* **Release numbers.** Workbench has no version scheme; CHANGELOG entries use the schema version and merge commit until releases exist (item 80).
* **Unseparated phone numbers.** R7 redaction does not match a phone written as one run of digits; it is indistinguishable from epoch timestamps and ids in logs. Revisit if a context-aware detector (item 78) lands.

* **Learning competes with turns on single-slot local models.** The benchmark measured learning calls racing the next turn on Ollama's one slot. Learning should yield to a waiting turn.
* **Benchmark coverage.** `bench/local_tasks.py` completed 25 of 50 tasks on CPU before the environment's time limit. Memory, calendar, drafts and "change nothing" tasks are unmeasured.
* **Image size figures before CI were inflated.** Resolved by item 111. Every "368 MB" reported before CI came from Docker's containerd image store, whose `inspect .Size` adds compressed blobs to unpacked layers (282 MB + 85 MB). CI builds from Docker Hub on the classic engine and measures unpacked layers: **248 MB** on main. A residual 34 MB gap between local layer sums (282 MB, mirror base images) and CI (248 MB) is not explained yet; CI's figure is the canonical one.
* **Remote branch `ci-demo/reintroduce-pr1-bug` still exists.** It belongs to closed PR #6 (the CI regression demonstration). This session cannot delete remote branches (HTTP 403); delete it in the GitHub UI.
* **Migrated legacy cost rows** keep the bare model name in `model`; new rows store the model ref. Reports group the two separately for the month of the upgrade.
* **`browse_web` results cannot be verified** by receipts, and say so.

* **Other tables with INTEGER PRIMARY KEY (no AUTOINCREMENT) that may reuse IDs on delete:**
  - `actions` — audit log with `parent_action_id` self-reference; if decision rows are deleted, new decisions could reuse IDs and appear under wrong parent
  - `messages` — has `ON DELETE CASCADE` from conversations, but individual message deletion could reuse IDs; `messages_fts` uses `content_rowid='id'`
  - `memories` — has nullable `conversation_id`; if memories are deleted individually, new memories could get reused IDs
  - `agent_tasks` — has nullable `conversation_id` and `parent_id` self-reference; similar reuse risk
  - `connections`, `calendars`, `mail_accounts`, `linked_accounts`, `agents` — referenced by other tables; if deleted and IDs reused, dependent rows could attach to wrong parent
  Consider migrating these to `AUTOINCREMENT` in a follow-up (schema v4+), or adding `ON DELETE SET NULL` FK constraints where missing.

