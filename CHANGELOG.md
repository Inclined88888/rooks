# Changelog

Every user-visible change that needs action, or changes data on upgrade, gets an entry: date, version, breaking changes,
migration steps, rollback steps. Workbench has no release numbers yet (BACKLOG). Entries are identified by schema
version and the merge commit on `main`.

## Unreleased · Windows and the work suites · branch feat/windows

Design records `docs/design/0011-windows.md` (Windows on a par with macOS and Linux) and
`docs/design/0012-work-suites.md` (Microsoft 365 and Google Workspace). No schema change in the entries below.
Rollback: revert the commits.

- **Terminals in the Room on Windows** (design 0011, section 1). On Windows 10 1809 and later the Room's Terminal window
  works as it does on macOS and Linux: New terminal opens PowerShell (PowerShell 7 when installed, else Windows
  PowerShell), and when Git for Windows is there a menu beside it offers Git Bash. A terminal keeps running when you
  leave the page, shows its text again when you come back, says when a program is running and how the last command
  ended, closes with code 129, and ends everything it started. Four at most, as elsewhere; Stop and Start over close
  them; after a restart they are listed as ended with their text. Terminals Rooks opens use Git Bash when it is there
  (as a quick command does), else PowerShell; each terminal and each result says which (`shell_kind`), so the assistant
  writes the right kind of command. The app's own Terminal page is PowerShell too. Underneath: a pseudo console
  (ConPTY) and a job object per terminal (`rooks-try/rooks_try/winproc.py`, plain `ctypes`), the shell in its job from
  its first instruction. PowerShell gets the Room's profile as a command, so there is never an execution policy bypass
  or an encoded command; it reads the Room's own `Documents\PowerShell\profile.ps1` when you make one. On Windows every
  line sent from the phone row or `/room send` is recorded in the run log by its length only (Windows cannot say from
  outside whether a terminal is waiting for a password). How a command ended reaches Rooks in the terminal's output and
  through a private channel only your account can open (Advanced says so); on the windows-2022 runner both arrived.
  Older Windows says "This version of Windows is too old for terminals in the Room." Tests that failed on the old code
  (on windows-2022, commit 1703d0e): `rooks-try/tests/test_winproc.py` (could not import `winproc`) and all ten in
  `workbench/backend/tests/test_room_terminal_windows.py` ("Terminals are switched off in Settings."), plus
  `workbench/frontend/tests/room-windows.test.mjs` (four, locally). CI: a new job "Windows: Room terminals" in
  `ci.yml`, and CI now also runs on pushes to `feat/windows`. Not tested: a real Windows 10 or 11 PC (the runner is
  Server 2022), Windows on Arm, ConPTY before build 20348, PowerShell's constrained language mode, AppLocker or WDAC,
  and a bundled `conpty.dll`/`OpenConsole.exe` (not shipped yet; Windows' own ConPTY is used).
- **The Room's browser starts in the packaged app** (2e939c0). The step that hands the browser its pipe ran Python with
  `-c`; the desktop app is one packaged program with no Python, so on a Mac the Room's browser always said "could not
  start". The packaged app now runs that step with its own program (`--rooks-pipe-step`).
- **When the Room's browser does not start, it says why.** Instead of only "The Room's browser could not start.", the
  Browser window, the phone view, the `rooks` terminal (`/room browse`) and the assistant say one of: no browser was
  found on this computer to run it; the browser on this computer refused to start; the wall that keeps it inside the
  Room could not be set up. What was run, its exit code and the last of what it printed are under **Advanced** in the
  Browser window (`failed` in `GET /api/room/browser` and in the Room's status), never on the normal line and never in
  the log. A wall that fails still keeps the browser closed: there is no fallback to running without it.
  Tests that failed on the old code: `rooks-try/tests/test_browser_engine.py` (one per reason),
  `workbench/backend/tests/test_room_browser.py::test_a_browser_that_did_not_start_says_why_with_the_detail_under_advanced`,
  and `workbench/frontend/tests/room-browser.test.mjs` ("a browser that did not start says why").
- **CI proves the packaged app's Room browser.** The desktop build (`.github/workflows/desktop.yml`, the macOS and Linux
  jobs) now starts the frozen sidecar, opens the Room's browser through its API on a loopback test page, and checks the
  page's text and a frame arrive (`desktop/scripts/smoke_sidecar.py --room-browser`). Windows is not covered: the
  Room's browser is not on Windows yet (design 0011, section 2).

## Unreleased · Workplace cleanup · branch cleanup/workplace

The cleanup the owner approved in `docs/architecture.md` (section g): delete what is dead, replace the old browser
agent, move old reports into `docs/history/`, hide developer features behind Advanced (hidden, not deleted), and call
the product Rooks on every normal screen, keep one memory, and correct the documents that contradicted the code
(section i). One schema change: the memory move
(`SCHEMA_VERSION` 5, below); one connection row is renamed (below). Rollback: revert the branch's commits, and for the
memory move restore the backup it takes.

- **Fixes from the review of the memory step** (each test failed on the tree before; `workbench/backend/tests/test_one_memory_review.py`
  unless named).
  - **`ws login` and `ws memory` work again.** The memory step removed `/api/memories`, which the terminal chat client
    (`cli/ws`) uses to check its Terminal access token and to list memories; both answered "Error 404". `GET
    /api/memories` is back, read-only, on the one store (search with `?q=`), and refuses a request without a session
    or the token (401, the sample the CI image check expects). Writing stays on `/api/knowledge/memories`.
    `test_assistant.py::test_cli_token_auth` checks it again.
  - **A sensitive memory never reaches a cloud model by another way.** The prompt's memory block left memories marked
    sensitive out for cloud models, but chat's `search_memory` tool, project context, the learner's "already known"
    list and the bridge's `/v1/rooks/memory` gave them back. Now only a model on this computer finds them with the
    search tool; the other lists leave them out. The Memory page shows them as before.
  - **The upgrade keeps what you decided on the Memory page.** A copy of an old fact that you had replaced there (for
    example "Lives in Sydney" replaced by "Lives in Melbourne") came back as a second, active fact. It now stays
    replaced. Only installs that ran the memory step before this fix could have the extra fact; forget it on the
    Memory page.
  - **A pinned fact is not silently replaced by a guess.** Chat's remember pins what you say about yourself; a later
    unpinned guess about the same thing (by the loose "is a" rule, "Their manager is a stickler" against "Is a nurse")
    now waits under "Needs your call" and the pinned fact stays in use. A newer pinned fact still replaces it.
  - **Forgetting a newer fact brings back the one it replaced.** Before, the older fact stayed stored but no screen
    showed it, so it could not be seen or forgotten; undoing a remember lost the earlier fact. Forgetting an older
    version keeps the chain, so "why" still shows what the fact in use replaced.
  - **Only a secret with its value is refused.** "Works as a legal secretary" and "Prefers token rings" were refused
    from chat and the terminal, and dropped from the old plaintext table at upgrade, because the check matched the
    words alone. Now a secret word must come with its value ("my password is ...", "PIN 4471", "api key: ..."). Keys
    by their shapes are refused as before.
  - **A correction on the Memory page cannot store a key.** Editing a memory checked only its length; it now refuses
    key shapes like adding one does.
  - **Rooks Browser and Rooks Desk say "Rooks app"** for the app's smart router and in their messages
    (`rooks-browser/tests/test_rooks_name.py`, `rooks-desk/tests/test_rooks_name.py`), as `rooks` already did. Rooks
    Desk's macOS permission steps keep "AI Workspace", the name macOS shows until the desktop app is renamed.
  - **Documents.** `docs/data-model.md` marks the two removed stores as history and describes the sensitive, forget
    and secret rules; `adapt/__init__.py`, `adapt/feedback.py` and `main.py` no longer describe "What I know about
    you".
  - **Not changed, on purpose:** paid-plan checks stay off by default even on an install that once recorded billing
    as live (the owner's decision in section g.3; no Rooks cloud sells plans). A build that sets `AIW_PLAN_CHECKS=1`
    gets the remembered state back.

- **Documents and small parts that contradicted the code** (section i; each item there now says fixed, partly fixed
  or open: 17 fixed, 2 partly, 3 open).
  - **VS Code add-on finds the app** (contradiction 20). It defaulted to `http://127.0.0.1:3100`, the server
    install's port, but the desktop app starts on a new port each launch, so on a normal install the add-on could not
    reach it. It now reads the open app's address from `app.json` the way `rooks` does (same file, same path rules, a
    file left by an app that has quit is ignored after a health check), takes only the address and never the key next
    to it (the add-on signs in with its own Terminal access token), and falls back to the server port. The
    `aiWorkspace.url` setting is empty by default; an address typed there still wins. **Action:** none; a setting you
    set by hand is kept. Test: `vscode-extension/test/address.test.mjs` (failed on the old code: no lookup existed and
    the default was the server port).
  - **The app is no longer given the CLI launchers' addresses or keys** (contradiction 11). `setup.sh` wrote
    `CLAUDE_CODE_URL` and `CODEX_URL`, Docker passed them and `CLAUDE_CODE_API_KEY` and `CODEX_API_KEY` to the app's
    container, and `config.py` defined all four; nothing read them. They are removed from `config.py`, `setup.sh`, the
    `workbench` service and `.env.example`. The `claude-code` and `codex` launcher services keep their own key from
    `.env` and `setup.sh` still makes it. An existing `.env` keeps its old `*_URL` lines; nothing reads them, and they
    can be deleted. `cli-launcher/README.md` shows how to call a launcher with the key from `.env`. Test:
    `test_repo_cleanup.py::test_the_app_is_not_given_the_cli_launchers_addresses_or_keys` (failed on the old code);
    `cli-launcher/test/setup.test.mjs` now checks that no address is written. **Rollback:** revert the commit.
  - **`scripts/test-all.sh` runs the suites it skipped** (contradiction 12): `cli/tests`, the CLI launcher's tests,
    the VS Code add-on and the phone app (typecheck, lint, tests); the last two are skipped by `--quick`. AGENTS.md
    says what it runs and what only the online checks run (security scan, installs on three systems, Docker images,
    desktop and native window builds, real-screen runs).
  - **Documents.** README: an email is sent after your yes (not draft-only); your own Claude Code, Codex or Copilot
    works today (the "planned add-on, not built yet" line is gone) and the Code page is behind Show developer tools;
    the browser sections describe Rooks Browser, which the app starts itself, with the `browser` add-on as the same
    program for servers; "Why Rooks". QUICKSTART is titled Rooks. SECURITY.md supports `main` at 1.0.6 and the latest
    release (not `integration/v0.3`) and no longer promises a signed updater, which is off until the signing key
    exists. Design records 0003 to 0006 say what was merged and by which pull request. `docs/native-app-plan.md`
    says its first milestone was built and then narrowed to the Ask palette. Decision record 0001 has a note pointing
    at design records 0003 (W1) and 0007 (room-browser branch). docs/README's "100 reasons": false items corrected
    (mail, "no shell tool", "inside your container", the tested/untested table) and shipped items lost their roadmap
    marker (memory export, scopes and page, skills page, Signal, WhatsApp, Slack, Discord). The teammates, packs,
    voice and team lead guides no longer read as unmerged branches. `companion.py`'s description names its real users
    (the Mac notch app and the phone app; no web screen) (contradiction 15).

- **One memory** (section g.2, first two rows; the audit found the Memory page showed nothing). What the assistant
  knows about you was kept in three places: the old plaintext `memories` table, the encrypted "What I know about you"
  store (`adapt_facts`: chat's remember and forget, the terminal's /memory) and `kn_memories` (the Memory page, copied
  from adapt_facts once a minute). A fact told in chat did not show on the Memory page, forgetting it on the Memory
  page left it in the prompt through the other store, and the prompt carried two memory lists whose ids meant
  different things. Now there is one store, `kn_memories`, used through `knowledge/facts.py` by chat's remember,
  forget and search tools, the background learner, the terminal (`/v1/rooks/memory`, `/context`, `/remember`,
  `/forget`), feedback lessons, projects, history undo and imports; the prompt has one memory list.
  - **A newer fact replaces an older one about the same thing**, using `knowledge/memory.py`'s predicates (lives_in,
    works_at, role, phone, email, birthday, prefers:*) and its `superseded` status: "Moved to Melbourne" replaces
    "Lives in Sydney" in the prompt, and "Why do you know this?" shows what it replaced. This changes the old rule for
    facts about you: two of your own statements no longer become a question; the newer one wins. A guess that
    disagrees with what you said yourself still waits under "Needs your call", and your word stays in use meanwhile
    (before, both were set aside until you chose).
  - **A key or password never goes into memory** from chat, the terminal or the Memory page (keys by their shapes:
    sk-, AIza, ghp_, AKIA, JWTs, private keys), because memories go into prompts. Before, chat's remember tool saved
    whatever it was given.
  - **One screen.** The Memory page has "Tell me something", correct in place, why, pin, sensitive, forget, "Forget
    everything", and a Learning tab with the four switches, the work it has seen and what it learned from your
    changes. About you (`/about-you`) and the chat's Memory tab (`/assistant-memory`) are gone; both addresses open
    the Memory page, and Settings, Privacy, Projects and the chat's menu link there.
  - **Routes:** `/api/learn/facts` (and `/api/learn/legacy-memories`) and the write routes of `/api/memories` are
    removed; use `/api/knowledge/memories` (with `POST /api/knowledge/memories/forget-all`). `GET /api/memories` stays,
    read-only, for `cli/ws` (see the review fixes above). `/api/learn/work` gives the work list
    `/api/learn/facts` used to carry. The terminal's routes are unchanged.
  - **Data on upgrade (`SCHEMA_VERSION` 5, `db.migrate_v5`):** every fact in `memories` and `adapt_facts` moves into
    `kn_memories`, encrypted with the memory key, de-duplicated by its words (the once-a-minute copies count as the
    same fact), keeping its source, dates, pin and uses; then both tables are dropped. A backup
    `workbench.db.pre-v5-<time>.bak` is taken first. Passwords and keys are not moved (the old code dropped those
    from `memories` too); facts sealed with a different app secret cannot be read and stay in `adapt_facts`. If the
    memory key is locked at upgrade (a desktop keychain), start-up is not blocked: nothing changes, and the move runs
    the first time memory opens with the key. Knowledge migration 4 indexes the moved facts for search.
    **Rollback:** stop the app, replace `workbench.db` with the newest `workbench.db.pre-v5-*.bak`, run the previous
    build. Facts saved after the upgrade are then lost.
  - **Tests** (each failed on the tree before): `workbench/backend/tests/test_one_memory.py` (remember in chat shows
    on Memory, in the terminal's /memory and its prompt context; forget on the Memory page, in the terminal or in
    chat is gone everywhere and from the next prompt; "Moved to Melbourne" replaces "Lives in Sydney" in the prompt;
    a correction on the Memory page is what the next prompt uses; a key is refused; the move keeps every fact from
    all three stores on a database built as the last release left it; a locked key at upgrade loses nothing) and
    `workbench/frontend/tests/one-memory.test.mjs`. Existing tests that read the old stores now read the one store;
    `test_knowledge.py`'s rule for two statements of your own changed with the behaviour above. Also checked on a copy
    of a database the previous build made with facts in all three stores, and in a real run of the built app on a
    fake model with Playwright (told a fact in chat, saw it on the Memory page, corrected it, the next prompt used the
    correction, forgot it from the terminal); screenshots were taken locally and are not in the repository.

- **Rooks on every normal screen** (section g.4, contradiction 3). The server's pages and messages say Rooks instead of
  "AI Workspace" or "Workbench": the page a used sign-in link shows, the Google and Microsoft Connect results, the
  name to give an app password (iCloud, Yahoo, Gmail), the Apple Mail and Mac steps, the backup's readme, calendar
  exports, Slack and Discord set-up, shared teammate pages, and the descriptions of the email-draft tool. The Computer
  page's Mac steps say to switch on Rooks. When an organisation must approve the sign-in, the message also gives the
  old name, because Google and Microsoft still list the sign-in app as AI Workspace until it is renamed there.
  Internal names are unchanged: `aiworkspace://` links, `~/.ai-workspace`, the `ai-workspace` command,
  `AI_WORKSPACE_*` and `WORKBENCH_*` settings, the `X-Workbench` header, Docker project and image names.
  - **Wake phrase.** A new install listens for "hey rooks". Anyone who never changed it keeps waking it with "hey
    workspace" too; a phrase of your own (Settings, Voice) works as before and replaces both.
  - **Data on upgrade:** a hosted-models connection named "AI Workspace Cloud" is renamed "Rooks Cloud" the next time
    the plan is checked, keeping its id, history and default model. Rollback: after reverting, rename the row back to
    "AI Workspace Cloud", or the old code adds a second connection beside it.
  - **Docker server:** a new install is called Rooks (`WORKSPACE_NAME`, Open WebUI's title, the search server's name,
    the tool server's name in Open WebUI). An existing `.env` keeps its `WORKSPACE_NAME`; change it there to rename.
  - **Tests:** `workbench/backend/tests/test_rooks_name.py` scans the server's strings, the built screens and the Docker
    defaults for the old names, with an explicit allow list (all six tests failed on the tree before); a wake phrase
    test in `workbench/frontend/tests/anywhere-voice.test.mjs` (failed before).
- **Modules named after old branches carry their purpose** (section g.4): `v02_api.py` is `automations_api.py`,
  `v02_hooks.py` is `projects_hooks.py`, `v02_mobile.py` is `projects_mobile.py`, `features_v02.py` is
  `plan_tiers.py`. Every route keeps its method and path (700 compared before and after). The model catalog builder
  moved out of the app to `scripts/build_model_catalog.py` (run it with the app's Python; it used to be
  `python -m app.catalog_build`).
- **Developer tools are hidden behind one switch** (section g.3). The Terminal, Code (coding jobs), the run log,
  Insights, System status, Compare models, Fine-tune, Extra tools, Packs and the Trade, Legal and Study pack pages are
  no longer in the More sheet or the command menu (none was on the top bar or in its menus), and the More sheet no
  longer links to Open WebUI, Paperclip or Hermes. Settings, Advanced has **Show developer tools**, off on a new
  install and on an upgrade: turn it on to list them all again, under Advanced. The install remembers the choice (the
  server's settings, `dev_tools`), so every window and paired browser agrees; only a signed in person or paired
  browser can change it, never a helper or coding job with a bridge key. Every address still opens (`/terminal`,
  `/code`, `/runs`, `/packs/trade` and the rest), so bookmarks and links from chat results keep working. With the
  switch off, Chat has no Chat/Code tabs, no Plan or Build, no "Code" or "Continue in terminal" in its menu, and a
  Build mode saved earlier does not come back until the switch is on; Settings, Tools and Connect no longer link to
  Extra tools. The `rooks` terminal is unchanged. The goals routes had no screen to hide (goals are set from chat).
  **Action:** someone who uses the Terminal or Code page turns the switch on once.
- **Paid-plan checks are off by default** (`account.py`, section g.3). No Rooks cloud sells plans, so no feature asks
  for an upgrade, even if a cloud address is set and says billing is live, or the install remembered it was live. The code stays; a build opts in with
  `AIW_PLAN_CHECKS=1` (`AIW_ENFORCE_PLANS` still forces either way).
- **Tests** (each failed on the tree before the change): `workbench/frontend/tests/developer-tools.test.mjs` (with the
  switch off none of these pages is in the rail, a flyout, the More sheet or the command menu; with it on all are;
  their addresses open; the outside links, the chat modes and the switch itself) and
  `workbench/backend/tests/test_developer_tools.py` (off on a new install, kept by the install, never on when signed
  out, a bridge key cannot flip it, plan checks off by default and still on when a build opts in). Screenshots of the
  top bar and the More sheet, off and on, light and dark, 1440x900 and 390x844, were taken locally and are not in the
  repository.

- **Removed: 375 files, 3,226 text lines, 40,578,218 bytes** (measured with git against `f837498`): 347 old
  screenshots (40 MB, tracked although `.gitignore` excludes the folder), draft launch posts with claims that are false
  today, two stale root reports, a script that only ran in one developer's folder, three screens nothing could open,
  and the old `browser-agent/`.
- **Screens.** The Customize page is gone: `/customize` and the old `/connect` link open Settings, which has every row
  it linked to. The chat's unreachable Skills tab is gone; its list of learned and hand-written skills is still on the
  Skills page ("Learned or written here"), now with loading, empty and error states. The unused "What I improved" card
  is gone. A test fails if any link, menu entry or redirect in the app points at a page that does not exist.
- **Desktop app.** Settings, Desktop app no longer lists three "coming soon" helpers that will not ship that way.
- **Server.** `GET` and `PUT /api/trade` are gone (no screen called them); a saved trade is still shown.
- **Docker server: the `browser` add-on is now Rooks Browser.** Action needed on a server install: run
  `./setup.sh` again (or `docker compose build browser && docker compose up -d`) so the new image is built. It is the
  same agent and approvals as the desktop app: a sensitive step waits for a yes on the Browser page or in Needs you. It
  needs `BROWSER_API_KEY` (setup.sh already makes one) and refuses localhost, the LAN and the stack's own hosts.
  - **Paperclip, Hermes and Open WebUI no longer get a browser tool or the browser key.** That key answers approvals,
    and those add-ons run agents on their own. Browse from Workbench's chat instead. An existing Hermes setup may still
    list a `browser` tool server that no longer answers; remove it in the Hermes dashboard. `setup.sh` clears the old
    Open WebUI entry.
  - `BROWSER_MONTHLY_STEP_LIMIT` is gone (Rooks Browser has no monthly cap); each job still stops after 50 steps at
    most, and model calls are counted in Workbench's usage.
- **Old audits and evidence** (`docs/AUDIT.md`, `PHASE0-GATE.md`, `ROOKS-FINISH-REPORT.md`, `docs/evidence`,
  `docs/night`, `scripts/audit`) moved to `docs/history/`, with links fixed.
- **Tests.** `workbench/backend/tests/test_repo_cleanup.py` (removed files stay removed, the browser add-on is Rooks
  Browser in service mode, Paperclip and Hermes never get the shared key, no CI job for the old agent),
  `workbench/frontend/tests/removed-pages.test.mjs` (no removed screen, no link to a page that does not exist), a unit
  test in `desktop/src-tauri/src/sidecars.rs`, and `test_customer_filing.py` for the trade routes. Each failed on the
  tree before its change. The new CI job `browser-image` builds the add-on image and checks its health check and token;
  the image was not built locally (no Docker daemon here).

## Unreleased · The Room's browser and the installer after review: walls that hold · branch room-browser-native-app

Design record: `docs/design/0007-room-browser-and-native-app.md`, section 8. Every fix below has a test that failed on
the code before it.

- **The app's own address is refused from the browser's first start.** The rule only knew the ports the browser's own
  routes had seen, so a browser the assistant opened first (after every app restart, the usual case) could open the
  app. Now the ports this app's process listens on are read when the browser starts (`/proc` on Linux, `lsof` on
  macOS, plus the phone's Wi-Fi door), every request to the app tells it (not only the browser's routes), and when no
  port is known the browser does not start ("The Room's browser stays closed: it could not check that pages in it
  cannot reach Rooks itself.").
- **Names with a dot at the end** (`localhost.`, `foo.localhost.`), which Chromium sends to loopback, are refused like
  `localhost`. An app on port 80 or 443 is matched without the port in the address too.
- **Keys no longer get past a hold.** Enter or Space on a focused button or link is checked as a click on it (a
  purchase on any site, a form or message on a site nobody asked for), any key in a card form as typing there; only
  keys that move around (Tab, the arrows, Escape, PageDown and the like) skip the look. Tab, Tab, Enter on "Add to
  cart" now waits for a yes in Needs you.
- **The helpers' shared key no longer reads the Room's browser.** `GET /api/room/browser/tabs` and `/page` (and
  `/open`) take the signed-in person or the Terminal access token only; the app.json and Rooks Desk keys, which the
  browser and desk helpers hold and pages can steer, are refused even for reads. The rooks terminal says how to sign
  in (`rooks login`) when the app refuses it. The Room's status still reads with that key.
- **An offline Room's browser without bwrap** (macOS, Linux without it) goes through a proxy that answers nothing,
  loopback included, instead of relying on proxy variables Chrome on macOS does not read.
- **Settings has the switches the Room's windows point to**: Settings, Tools, The Room: Terminals and The Room's
  browser. The windows say "Switch it on in Settings, under Tools" and their button opens that section.
- **Installer**: the question "a Chrome or Edge window, or your usual browser?" was never asked from `curl | bash` (a
  terminal opened "r+" cannot seek, so it read as no answer, and no answer was taken as the window). It is asked now,
  and nobody answering in 60 s is no answer: the launcher asks later, never a window nobody chose. The Rooks app is
  installed only when its SHA-256 matches the release's `SHA256SUMS-desktop`; prereleases are skipped; a cut download
  says that once and no longer also says "none published".
- **CI**: the backend job installs bubblewrap and sets `ROOM_BROWSER_TESTS_REQUIRED=1`, so the Room browser's real
  Chromium tests fail instead of skipping when no browser can start.
- Upgrade: nothing to do. Someone who used the rooks terminal's `/room tabs` or `/room page` with only the app.json key
  runs `rooks login` once (Settings, Terminal access). Rollback: revert the branch; no data changes.

## Unreleased · The new mark: a tower with a gold door · branch room-browser-native-app

Design record: `docs/design/0007-room-browser-and-native-app.md`, section 7.

- **Rooks has its own mark**: the chess rook as a plain tower, one rounded slab with three merlons and an arched
  doorway lit in gold (the light is on, the assistant is home), on an ink tile. At 16 px it is still a tower with a gold
  door. It replaces the purple lines (desktop app), the letter R (browser tab), Expo's sample icons (phone) and the
  first letter of the assistant's name (top bar).
- Where it shows: the desktop app's icons (`desktop/src-tauri/icons`, every PNG size, `icon.icns`, `icon.ico`, made by
  `npx tauri icon desktop/app-icon.svg`), the desktop splash, the Ask palette's icons (`desktop/rooks-native/assets`),
  the browser tab (`favicon.svg`, also the Linux menu icon the installer writes), the phone app's icon, Android
  layers, splash and web icon (`mobile/assets`), the top bar's search button, the welcome and sign-in cards beside
  "Rooks", and the loading screen. `desktop/scripts/make_icons.py` draws the files Tauri does not make.
- Not changed: the terminal banner keeps the word "Rooks" (a chess glyph is drawn wide or as an emoji by some
  terminal fonts, so it did not read well as plain text); the README has no logo; `rooks-browser/app` has no icon
  files. Shortcuts the installer made before keep the old picture until the installer runs again.
- Upgrade: nothing to do; the next installer run or app update carries the new icons. Rollback: the icons are files
  only, no data changes.

## Unreleased · Rooks is its own program: the app by default, no Chrome window nobody chose · branch room-browser-native-app

Design record: `docs/design/0007-room-browser-and-native-app.md`, part 2 (as built: section 6).

- **The installer installs the Rooks app by default** (`--native auto`; `install.ps1`: `AI_WORKSPACE_NATIVE`, default
  `auto`). It takes only a real app release (`vX.Y.Z` or `desktop-vX.Y.Z`) at or above this copy's version, never the
  Ask palette's `rooks-native-v*` release and never an older app. No such release exists for 1.0.6 yet, so today it
  installs nothing and says "none published for this computer at version 1.0.6 or newer yet". A download that fails
  under `auto` no longer stops the install.
- **`ai-workspace` never opens a Chrome window nobody chose.** It opens the Rooks app when it is installed (under the
  new or the old name). Without one it asks once: "There is no Rooks app for this computer yet. Open Rooks in a Chrome
  or Edge window, or in your usual browser?" The installer asks it when someone is at the terminal; started from the
  Dock, Finder or the Start menu with no answer yet, Rooks opens in the usual browser and the page asks with the same
  words. The answer is kept (`install.json`); `ai-workspace --shell window|browser` changes it, `--status` says
  "opens in: ...". The macOS Applications shortcut no longer forces `--web`. New: `install.sh --shell window|browser`
  and `AI_WORKSPACE_SHELL`.
- **The page's bar** (outside the Rooks app only) says that line with "A window of its own", "My usual browser" and
  "Not now", and saves the answer for the launcher (`POST /api/desktop/shell`: a signed-in person only, never the
  app.json key or the tools key; it writes only the `install.json` the launcher named, and only those two answers).
- **The app is called Rooks**: product name, window title, splash, update prompt, macOS permission texts, the launcher
  and the installer. The identifier stays `com.inclined88888.aiworkspace`, so the data folder, the webview's storage
  and the keychain items do not move; the binary name and the `aiworkspace://` links stay. The Ask palette is packed
  as "Rooks Ask" so the two cannot replace each other.
- **What WebKit does not do, the Rooks app does**: links that would open a new window go to your browser
  (`open_external`, web addresses only), downloads are saved to Downloads with a notification, the microphone prompt
  is answered (camera, screen and location still ask), copies that wait for the server use a `ClipboardItem`, and
  Meetings says "Recording the computer's sound needs Chrome. The microphone works." where it cannot. Compiled and
  unit tested on Linux; not yet run in a real WebKit window (BACKLOG).
- Upgrade: run the installer again. Nothing to migrate; data stays where it was. Rollback: `install.sh --native no`
  keeps the window or browser; an earlier copy reads the same data folder. Copies of the 1.0.5 app named "AI Workspace"
  are still found and opened until replaced.

## Unreleased · The Room's Browser window, the assistant in it, and /room browse · branch room-browser-native-app

Design record: `docs/design/0007-room-browser-and-native-app.md`, sections 1.3, 1.5 and 1.6 (as built: section 5).

- **A Browser window on the Room's desk**, after Terminal in the dock. Tabs (eight at most), New tab, back, forward,
  reload or stop, an address bar, and the live page: click, double click, type, scroll, copy (Ctrl or Cmd+C puts the
  page's selection on your clipboard) and paste. F6 leaves the page. It is there only when the Room has a browser on
  this computer; otherwise it says why in plain words ("The Room has no browser yet.", "switched off in Settings",
  "not on Windows yet", "runs elsewhere"). With the Room off it says so and lists the tabs it kept. After an app
  restart it says "The app restarted, so the browser closed. Your tabs and sign-ins are kept." The Stage beside the
  chat shows it too.
- **On a phone** (or any touch screen) the window shows a still of the page every 2 seconds, with taps, Scroll up and
  down, a Type field and Enter: "On a phone you can tap, scroll and type. Dragging, hovering and shortcuts need the
  computer."
- **The assistant can use the Room's browser.** `use_room` gains browse, page, shot, click, type, scroll, key, back and
  tabs. Looking (page, shot, tabs) is never asked about; every other step asks first, as in the rest of the Room. On
  top of that a step waits for your yes in Needs you when it looks like a purchase (on any site, or a form with card
  fields), sends a form, a message or a sign-in to a site you did not name in this chat or type into the address bar
  yourself, or clicks inside another site's frame. Page text never counts as you naming a site. It never types a
  password: it asks you to type it yourself. While it acts the window says "Rooks is using the browser"; your own click
  or key takes it back, and its next step waits for your yes. Presence says "Looking at a page in the Room's browser".
- **The run log** keeps the site and path (never the query), the element's name and "(N characters)" for typing, never
  the text, also in the chat step's own row.
- **The rooks terminal:** `/room browse ADDRESS` (`--new` for a new tab), `/room tabs` and `/room page` print the same
  words through the app, with the terminal's own key.
- **Fixes on the way.** A tab is named by its page's title also after a form posts and redirects (it showed the
  address). A frame still drawn at the old size just after a resize is dropped, so a click lands where it was made (a
  socket test that read the first frame failed now and then on it).
- **No migration.** Nothing changes on upgrade; rollback is removing the branch.

## Unreleased · A real browser in the Room (engine and API) · branch room-browser-native-app

Design record: `docs/design/0007-room-browser-and-native-app.md`. This entry is the engine and API lane; the Browser
window on the Room's desk, the assistant's `use_room` browse actions and the terminal's `/room browse` land from their
own lanes.

- **The Room has its own browser.** A real Chromium the app starts when the Room is on and a page is opened. It runs
  headless, so no window appears on your screen; you see it only as the Room's live picture. It is driven over a pipe,
  never a network port. Its sign-ins and cookies live in the Room's own folder (`.room-browser`), never in your own
  browser's profile; passwords are never saved. On Linux with bubblewrap it runs with the Room's folder over your home
  folder and no network when the Room is offline; elsewhere it runs as you, and the app says so.
- **What it refuses.** A file outside the Room's folder, and this app's own address, are refused for every request,
  typed or from a page.
- **Downloads** land in the Room's `Downloads` with a safe name (`notes (2).txt` when the name is taken); one stops at
  2 GB. They leave the Room only through Hand off and your yes in Needs you.
- **Tabs and limits.** Eight tabs at most ("Eight tabs are open. Close one to open another."). Over 1.5 GB of memory
  the least recently viewed background tab is put to sleep (kept as its address); over 2.5 GB the browser closes and
  its tabs are kept. The disk cache is 100 MB.
- **Stop, Save a point, Start over, restart.** Stop closes the browser and keeps its tabs. Save a point closes it for
  the copy (caches left out) and opens it again. Start over closes it before the Room's folder is replaced, so sign-ins
  made since that point are gone. When the app restarts, the browser closes cleanly, the next start reopens the tabs
  (the front one loads, the others wait asleep) and says "The app restarted, so the browser closed. Your tabs and
  sign-ins are kept."; a chat cut off by the restart says the same.
- **Status** has `can.browser` and `can.browser_off_reason` (`no_engine`, `windows`, `helper`, `switched_off`) and a
  `browser` part (open, tabs, notes). Settings has `room_browser` (on by default) to switch it off.
- **API.** `WS /api/room/browser/ws` (signed in, same origin, this computer only, one window at a time): JPEG frames
  as they change, state as JSON, and mouse, wheel, key, text, resize, address, back, forward, reload and tab messages.
  `POST /api/room/browser/open`, `GET /api/room/browser/tabs` and `GET /api/room/browser/page` also take the rooks
  terminal's Terminal access token (a bridge key only reads, and reads never start the browser). The phone's still
  (`GET /frame`), taps (`POST /act`), `GET /shot`, `POST /start`, `POST /close` and closing a tab are yours only.
- **Run log.** Opening and closing the browser, every page a route opens (host and path, never the query), and one
  "You used the browser for N min" row; what you type is never recorded.
- **No migration.** Nothing changes on upgrade; rollback is removing the branch (the `.room-browser` folder in the
  Room's home can be deleted).

## Unreleased · Phase 1a: terminal safety · branch phase-1a/terminal-safety

No schema change, nothing to migrate. Rollback: revert the branch's commits.

- **Fixes from the phase 1a review.** A coding job's own prompt is now refused in Needs you too when answered with the
  Terminal access token (only the signed in app answers it; the terminal's `/needs` lists it as "answer in the app"
  and sends nothing), and only a job withdraws a job's prompt. Deny rules in `rooks` now also catch a shell reading
  from the input (`| bash -s`, `| sh -`, `| sudo -s`, `| su`), `bash -c "$X"`, `bash -c -- '...'`, brace expansion
  (`{rm,-rf,x}`), `$'rm'`, a program name in a variable behind `sudo`, and `su -c`, `script -c`, `busybox`,
  `unshare`, `fakeroot` and similar wrappers. The guard on Rooks' own rule files reads the command as the shell does,
  so `.rooks/set''tings.json`, `cd .rooks && ...` and `./.rooks//settings.json` are asked about. "Always allow here"
  is no longer offered in an unasked folder that has skills or commands of its own (choosing it would have trusted
  them unseen). A Claude model priced under `[prices]` with two numbers gets Anthropic's cached price rule again, so
  the dollar cap keeps counting. Tests: `rooks-code/tests/test_permissions.py` section 9, `test_caching.py`,
  `test_workroom.py`, `workbench/backend/tests/test_auth_boundaries.py` (each failed before the fix; scripted fake
  model, no real model key).

- **Skills and your own commands in `rooks`, with the app off.** Skills are folders with a `SKILL.md` (a `name` and a
  `description` in front matter, then the steps) in this folder's `.rooks/skills` or `.claude/skills` and your own
  `~/.rooks/skills` or `~/.claude/skills`. Only names and descriptions go into the instructions; a skill's steps reach
  the model only when it calls `load_skill`, the tool the app's saved skills already use (a skill file is used before
  an app skill of the same name, and the app's skills still work when it is connected). `learn = false` does not turn
  skill files off. Your own commands are `.rooks/commands/NAME.md` and `.claude/commands/NAME.md` (this folder and
  yours): `/NAME words` sends the file's text with `$ARGUMENTS`, `$1`, `$2` filled in; `rooks "/NAME words"` and
  `rooks -p "/NAME words"` too. Built-in command names always win. `/skills` lists the app's skills, skill files and
  your commands, each saying where it comes from and whether it is used. **A folder's own skills and commands are used
  only after you trust the folder** (the trust of the permission rules: the one-time question at start now also lists
  them, or `/permissions trust`); until then they are listed as not used, the session start says so, `load_skill`
  refuses them and `/NAME` says why instead of running (headless exits 3). A command file grants nothing: front matter
  such as `allowed-tools` is not honoured and `!` shell lines are not run. A folder's skill or command file linking
  outside the folder is never read; descriptions are shown without control codes. Not yet: the app does not show skill
  files, and a session on the app's shared loop does not offer them. Tests: `rooks-code/tests/test_local_skills.py`
  (each failed before the change; scripted fake model, no real model key).

- **Prompt caching, charged at the cached price in `rooks`.** Anthropic requests already marked the system prompt,
  the tool list and the conversation for caching; now what the provider reports is used. Input read from the cache
  (Anthropic `cache_read_input_tokens`, OpenAI `prompt_tokens_details.cached_tokens`, DeepSeek
  `prompt_cache_hit_tokens`) and input written to it (Anthropic `cache_creation_input_tokens`) are counted apart and
  charged at the cached price: `/cost` shows them ("20,000 of the input read from the cache, 21,000 written to it"),
  each receipt's model call has `cache_read_tokens` and `cache_write_tokens`, the headless result's `tokens` has
  `cache_read` and `cache_write`, and the dollar cap counts the cached price. Before, every cached token was charged at
  the full input price: cache reads were overcharged (a session could stop at the cap early) and Anthropic cache
  writes, which cost 1.25x the input price, were undercharged (the cap could be crossed). The cap's estimate for the
  next call now uses the cache write price when it is higher. Cached prices are in the built-in table (Claude models
  by Anthropic's rule: a read 0.1x, a write 1.25x the input price); a `[prices]` entry takes them as
  `[input, output, cache read, cache write]`. A call that used the cache with no known cached price has an unknown
  cost, never a guess, and Rooks says once that the dollar cap cannot be enforced (the token cap still is). Tests:
  `rooks-code/tests/test_caching.py` (all but the request-marks test failed before the change; scripted fake model,
  no real key, so no live call has checked that a provider reports cache reads above zero).

- **Headless `rooks` for scripts and CI.** `rooks -p "task"` (or the task piped in: `echo "task" | rooks -p`) runs one
  task and never waits for input: a step that would need your OK (an edit, a command, an MCP tool, an MCP server's
  question to you) is denied at once, reported, and the run exits with code 3. Only what you set up beforehand lets a
  step run: a permission rule, a trusted folder, or `--yes` (which still never answers an MCP server's question to
  you). A headless run is not linked to an app chat, so nothing waits in Needs you. `--output-format text` (the answer
  on stdout, steps and denials on stderr), `json` (one result: answer, session id, model calls, tokens, cost, what was
  denied and why, exit code) or `stream-json` (one event per line: start, assistant text, tool call, tool result,
  approval asked, approval denied, notice, end). Both are described by `rooks-code/rooks_code/schema/headless.schema.json`.
  Keys, tokens, emails and phone numbers are hidden in this output, as in the receipts. Exit codes: 0 done, 1 not
  finished or an error, 2 bad usage or cannot start, 3 something was denied. `rooks_code.sdk.run(prompt, cwd=...,
  on_event=...)` is the same run in-process for Python scripts, returning the same result object; `rooks -p` uses it.
  `-P claude-code` and `-P codex` are refused in headless mode (use `claude -p` or `codex exec`). Tests:
  `rooks-code/tests/test_headless.py` (each failed before the change; scripted fake model, no real model key).
  `rooks-code[dev]` now needs `jsonschema` for that test.
- **Only a person answers a terminal's question.** The open app's own key (app.json), Rooks Desk's key and a coding
  job's key can no longer record an answer to a question the `rooks` terminal asked: any program on this computer can
  read app.json, a command the agent ran included, so it could have said yes to its own question. An answer typed in
  the terminal is recorded in the app with the Terminal access token (`rooks login`); without it the answer still
  stands in the terminal and the app's card closes. A question from a coding job the app started is answered in the
  app only, not even with the token. Breaking for scripts that answered `/v1/rooks/approvals/{id}` with the app.json
  key: they get "Only you can answer this" (403) now.
- **The Room asks you before a file leaves it, in the terminal too.** `rooks-try mcp`'s `handoff` no longer takes
  `approve: true` from the agent calling it. The server asks the person itself (MCP elicitation, as Rooks Desk does),
  and `rooks` now puts such a question to you, also with `--yes`, and mirrors it to Needs you. A program that cannot
  ask gets "waiting for a person" and nothing is copied. The same goes for Rooks Desk's questions in `rooks`: a
  sensitive step it used to refuse there (the terminal could not ask) is now put to you.
- **Permission rules in `rooks`.** `[permissions] allow` and `deny` in `rooks.toml`, and a project's own in
  `.rooks/settings.json`: `bash(pytest *)`, `bash(npm test)`, `edit(src/**)`, `mcp(notes/search)`. Deny wins and
  applies in every mode, auto-accept (`--yes`) included; a refused step exits with code 3 in a one-shot run. A
  compound command (`pytest; rm -rf x`, `&&`, pipes, `$(...)`, backticks, a redirect to a file, `VAR=value` in front)
  never matches an allow rule unless every part does; a command too hard to read is asked about even in auto-accept
  while a command deny rule exists. A project's allow rules apply only after you trust the folder (a one-time
  question, kept by the folder's real path in `rooks-trust.json` next to `rooks.toml`; `/permissions trust` or
  `untrust`); until then they are ignored and Rooks says so. A new choice at the question, `h`, always allows that
  exact command in this folder (a precise rule in `.rooks/settings.json`). `/permissions` shows the rules in plain
  words. A command naming Rooks' own rule files is asked about in every mode, so the agent cannot grant itself a
  rule. Not in the app's Settings yet (phase 1b parity pass). Tests: `rooks-code/tests/test_permissions.py` (each
  failed before the change; scripted fake model, no real model key).
- **The terminal audit's defects, fixed in `rooks`** (each with a test in `rooks-code/tests/test_audit_defects.py` that
  failed before the fix, run against the scripted fake model, no real model key):
  - A no ends the turn. A reply that declines ("OK, I will not change it.", "I'll leave it as is.") is no longer taken
    for an announced step, and after you deny a change Rooks never nudges the model to carry on.
  - `a` approves only that exact command, changes to that one file, or that one tool of one MCP server, for the rest of
    the session; the question says which ("Approve this exact command for this session"). It used to approve every
    command (or every edit, or every MCP tool of every server) for the session. Breaking for anyone who relied on
    one `a` covering all commands: you are asked again for each different one.
  - `/init` reloads the project instructions, so the AGENTS.md it writes is followed from the next request on.
  - `/doctor` in a session checks the address that session uses (`--base-url`, the app's), not only the config file's.
  - A one-shot run exits with code 3 when a change or command was denied (typed `n`, no input, a hook). Exit codes
    are listed in `rooks-code/README.md`: 0 finished, 1 not finished, 2 cannot start, 3 denied. Breaking for scripts
    that treated a denial as success (it exited 0).
  - A model error is said in plain words with no address ("The AI service is busy or down right now. Try again in a
    minute. /doctor (or rooks doctor) shows the details."); the full detail stays in the session's record and /doctor.
  - One meaning of "plan": Shift+Tab's settings are now asks first, auto-accept and dry run (was "plan only"), so they
    never share a word with `/mode chat|plan|build`; the line under each answer says "build mode", and the agent's
    checklist shows as "checklist 2/5" (was "plan 2/5").
  - One version number: `rooks --version`, `rooks-code/pyproject.toml` and AGENTS.md now say 1.0.6, the `VERSION` file.
  - The README says what is true: answers stream in as they are written.

## 2026-11-08 · The Room as a small computer · branch feat/room-desktop

The Room keeps what you do in it. Design record: `docs/design/0006-room-desktop.md`. This entry was written by the
backend lane; the Room page's desk and the terminal's `/room` verbs land in the same branch from their own lanes.

- **A terminal that stays.** The Room has real terminals: a login shell inside the Room's own folder, kept on this
  computer's app while you go to chat and back, with its text there again when you return. Nothing run in one has a
  time limit, so a long installer finishes. Up to four at a time, apart from the app's own terminal.
- **What you install is found.** Every shell and every quick command in the Room reads the Room's own profile, and
  the Room's `~/.local/bin`, `~/bin` and `~/.cargo/bin` come first on its PATH, so a tool an installer put there works
  in the next terminal and in the assistant's next command. The Room writes `~/.profile` and `~/.zprofile` once, only
  when they are missing; it never changes yours.
- **Files.** The Room's folder can be looked through whether the Room is on or off; nothing in it is changed from there.
- **Stop and Start over close the terminals first** and say how many. Stopped terminals stay listed with their text;
  after Start over one new terminal opens. A restart of the app ends them too, and a chat that was cut off by it says
  "Terminals in the Room ended; their files are still there."
- **The assistant can start long work in the Room** (`use_room` start, then tail to watch it, files to look) and says
  honestly whether it is still running and how it ended. A terminal the assistant works in takes no typing until you
  press Take this one, so your keys are never read as its output. A quick command still stops after two minutes and now
  says "Stopped after 120 seconds. For something long, start it in a Room terminal."
- **The run log** records each terminal opening and closing, every command Rooks starts and how it ended, and lines
  sent from a phone or `/room send`; what you type in a terminal is not recorded, only "You used the terminal for N min".
- **The rooks terminal reaches more of the Room** with its Terminal access token: its terminals, Files, Save a point,
  Start over and Hand off (a hand-off still waits for your yes in Needs you). The app.json key still only reads.
- Migration: none; the schema is unchanged. The Room's terminals keep their text in the Room's folder
  (`~/.ai-workspace/try-room/work/terminals`, at most 2 MB each). Rollback: previous commit; the seeded `~/.profile` and
  `~/.zprofile` in the Room's home stay and are harmless. No secrets changed; a Room terminal gets none of the app's
  secrets and no key, token, secret or password from its environment.

## 2026-11-07 · Rooks Browser app (preview) · branch feat/browser-app-landing

A browser of our own that the browser agent can drive: `rooks-browser/app`, an Electron window with tabs, an address bar,
private tabs and an **Ask Rooks** panel that reads the page you are on or does a task in it while you watch, with the same
site rules, approvals and receipts as the agent in Chrome. Design and security model: `docs/design/0005-rooks-browser-app.md`.

- **Start it** with `cd rooks-browser/app && npm install && npm start`. Tasks need the `rooks-browser` command on this
  computer (the Rooks installer puts it there); without it the panel says so and browsing still works.
- **Preview only.** It is not in the installers, the desktop app or the Room yet, and it has been tested on Linux only
  (macOS and Windows are untried). BACKLOG lists what is still missing.
- **What the review changed before landing.** A page the rules refuse is one blocked row in the receipt, never the app's
  own "could not open" page as a visited page, and rows keep the order things happened. After a page fails the address
  bar keeps the address that failed and says "Could not open", never "Secure". A permission you allowed a site earlier in
  the run reads as denied inside the agent's tab, the same as asking for it. The control channel refuses a private tab
  and never takes a private tab that is in front. The app's local-address and host-pattern rules give the same answers
  as the Python agent's for every reserved range and for `[...]` patterns, and the parity test now guards them. Typing
  a LAN or link-local address, or `[::1]`, opens it over plain http like `localhost`. The task helper gets none of the app's
  secrets and no other key, token, secret or password from the app's environment, only its own token and the model keys
  it reads itself (such as a key for OpenAI or Anthropic exported in the terminal you started the app in). Panel messages are plain sentences with the technical reason under
  "Details". CI runs the app's tests on Linux under a virtual display, and `scripts/test-all.sh` runs them when `npm`
  and `xvfb-run` are present.
- Migration: none. Rollback: previous commit. No secrets changed.

## 2026-11-07 · The session branches, integrated · branch integration/2026-11-07

Merges feat/coworkers (#13) with fix/coworker-guards, fix/main-ci-green (#16) with claude/agents-on-ci-green, fix/install-blank-window (#19),
fix/mobile-companion-lock-actions (#18), design/chat-controls (#17, which carries design/glass-shell #15), security/hardening-2026-11
and fix/model-defaults-sync, with the unique pieces of fix/test-isolation-and-linux-sandbox (#14) ported onto #16. Each branch was reviewed
and its serious findings fixed here. The entries below this one describe the security hardening and the Room's shell field in full.

- **Coworkers in the terminal.** `/team` shows your coworkers and the lines of work, `/team set up construction` shows the
  team Rooks proposes, `/team create construction` makes it (its jobs wait in `/needs`), `/team remove construction` removes it.
  The app.json key only reads; creating or removing a team needs the terminal's own sign in (Settings, Terminal access).
- **Coworkers.** Welcome has a fifth, skippable step ("What do you do?") and a Coworkers page proposes a small team for a line of work.
  Scheduled and coworker runs no longer refuse a step that needs a yes: it waits in Needs you, the inbox says so, and a later yes
  runs it once as that coworker. Asking the assistant to schedule something shows an approval card first. The app's own connector
  (`/mcp`) no longer runs skill scripts outright: the call waits in Needs you, and the tools key cannot answer it.
- **Glass navigation.** The left rail is a floating top bar with one sliding pill; phones get a floating dock. AI-cliché icons are
  gone, Team's "AI runs" is "Split tasks", and the chat and three more pages draw the shared controls. Motion off, reduced motion,
  high contrast and reduced transparency all get a solid, still bar. Owner's call to keep: `--glass-filter`, `--glass-shadow` and
  `--dur-slide` in `workbench/frontend/src/tokens.css` revert it.
- **Terminal containment on Linux.** `sandbox = "project"` now holds on Linux with bubblewrap (`install.sh` offers it with the other
  helper apps). Without a working bubblewrap a command is refused before you are asked about it, never run uncontained. Windows has
  no containment yet; the approval line says "not kept inside the project folder on Windows". `sandbox = "full"` is unchanged.
- **Phone.** Allow, Decline and Answer on a Companion notification work from the lock screen; Answer takes typed text and never
  answers for you. The phone's Companion calls now reach routes the server has (they went to a path that did not exist).
- **Installs.** A fresh one-command install opens the app again: the committed web UI was missing its files, so every install from
  `main` since 02:31 UTC today opened a blank window. The web UI is committed in full, CI fails when it is out of date, `--status`
  checks the page's files, and the release zip ships the build it just made.
- **Sign in.** The tools key no longer mints a window session; only the native window's own key does. Breaking only for something
  outside this repository that used the tools key at `/api/desktop/local-session`.
- **Models.** The terminal, browser and desk default to `claude-sonnet-5-5` like the app, send no temperature to Claude (current
  models refuse one), and price the current Claude models.
- **Analysis sandbox.** Calls into libc through `ctypes.pythonapi` are refused, not only newly opened libraries.
- Migration: none. Rollback: `main` at 5579160. Secrets are unchanged; nothing needs rotating.

## 2026-11-07 · The Room says which shell it has; agent receipts are tested for secrets · branch claude/agents-on-ci-green

Builds on `fix/main-ci-green` (its redaction resync and Git for Windows shell for the Room).

- **The Room on Windows without Git for Windows** still runs commands in Command Prompt, which reads `a; b` as one
  command and exits 0. Status and every result now carry `shell` (`"sh"` or `"cmd"`), with a plain note in the `cmd`
  case, and the Room's run tool tells the model so.
- Rooks Desk gets the redaction copy guard Rooks Browser already had, and both agents get a test that a receipt never
  stores a private key or an AWS key id.
- `scripts/test-all.sh` runs the rooks-browser and rooks-desk suites (CI already did). Playwright's Chromium download
  is optional there.
- Migration: none. Rollback: previous commit.
## 2026-11-07 · Security hardening · branch security/hardening-2026-11

- Breaking (Docker): the Workbench image no longer trusts `X-Forwarded-For` from any client. Behind a reverse proxy,
  set `FORWARDED_ALLOW_IPS` to its address. `SETUP_CODE` now reaches the container, so first run setup asks for it.
  Rebuild or pull the image: the old one still trusts every client.
- Breaking: `TOOLS_API_KEY` no longer opens the account (`/api`). It still opens `/tools` and `/mcp` for the add-ons.
- Skill scripts ask before every run where bubblewrap is not available (Docker, macOS, Windows); in an unattended run
  (a scheduled job, a coworker, another program through the app's connector) the run waits in Needs you. `run_python` asks in a conversation with untrusted content on those systems. Both sandboxes
  block `ctypes`.
- Output from MCP tools keeps the conversation marked untrusted on later turns.
- Files open with a sandboxed content policy, so an SVG from an email cannot run script.
- `rooks-desk serve` and `rooks-browser serve` refuse requests a browser marks as cross site and anything not sent as
  `application/json`.
- Docs and installers point at `Inclined88888/rooks`.
- If a Docker install was ever reachable from the network or other containers: reset the password and rotate the
  keys it held. Migration: none. Rollback: previous commit.

## 2026-11-07 · Separate keys for the native window, background jobs and helpers · branch integration/auth-native-workroom

- The native window signs in with its own key (`NATIVE_SIGNIN_KEY`, written each launch to `native.json`, 0600, never
  to `app.json`); it only mints a session on loopback and is not a bearer. The shared `app.json` key (PR #10's sign in)
  no longer signs in or opens the account.
- Coding jobs get their own key, never the `app.json` key: `/v1` only, no Workroom, no answers to terminal prompts.
- Coding jobs, model CLIs, user MCP servers and the browser and desk helpers no longer inherit the app's secrets
  (`APP_SECRET`, `TOOLS_API_KEY`, the bridge keys) from its environment. This hole existed on `main`.
- Record: `docs/security/agent-credentials.md`. Migration: none; the sidecar writes `native.json` on the next launch.
  Rollback: previous commit (restores the shared key sign in).

## 2026-11-07 · Premium pass: restraint · branch feat/workroom

Design record: `docs/design/0003-workroom.md` section 6 (design system v3, restraint).

- **Removed:** the thinking shimmer, word by word reply reveal, cursor trail, approval spring, drawn tick, working
  border and every decorative glow; the Motion page; the Sunshine, Paper, Cherry, Neon, Linen, Gallery, Studio and Lamp
  themes; the Bodoni serif.
- **Look:** Light, Dark and High contrast; one sans family, mono only for code, commands and receipts; one type scale
  (12/13/14/16/20/28), one 4 px grid, radius 6/10, hairline borders, one shadow for floating things only; neutral
  colours with amber only for what is live or needs you. The only motion is a fade of 150 ms or less. The Room keeps a
  still amber border while you have stepped in.
- **Every page** rebuilt on the shared primitives with loading, empty and error states and a phone layout.
- **Speed:** one pulse request carries presence, Needs you and job notices. Background requests a minute: chat 62 to
  6, the Room 94 to 28, Jobs 48 to 10, Tasks 24 to 6. Pages warm on hover; Jobs, Tasks and chats reopen from cache.
- **Keyboard:** everything in ⌘K with shortcut hints; `?` lists every shortcut; g then c, r, j, t, m or s moves
  between Chat, Room, Jobs, Tasks, Mail and Settings.
- **Terminal:** the same three themes, names and calm look; `/room`, `/needs`, `/jobs` and one `/help`. The terminal's
  own sign in (Terminal access) can start the Room and answer Needs you; the app.json bridge key, which coding jobs the
  app starts also hold, can only read them.
- **Moved:** Extra tools is at `/extra-tools` (`/mcp` redirects); Packs is reachable again under More.
- Migration: none. A saved theme maps to the nearest of the three. Rollback: check out the previous commit.

## 2026-11-06 · The Workroom: presence, Needs you, the Room, reliability · branch feat/workroom

Design record: `docs/design/0003-workroom.md` (binding for this branch). Packages: F1 to F4 (the app) and B1 to B3 (the service), listed in the order a person meets them.

- **The Workroom shell and design system (F1).** One set of colour, type and spacing tokens with two modes, Studio
  (light) and Lamp (dark); the older themes stay in Appearance as layers on top. A rail of pages with flyouts and a
  More sheet, the presence line at the top with the Needs you pill, the Stage beside the chat, and a bar at the
  bottom on phones, all built from one page list (`pages/registry.ts`) that also feeds the palette. Shared parts
  (buttons, cards, tabs, sheets, toasts, the approval card, the Stage frame) live in `src/ui/`. The chat list is a
  column inside the chat. The app calls itself Rooks. One main landmark, a skip link, focus rings everywhere, and
  every sheet and flyout keeps focus inside and closes on Escape.
- **The chat as a living record (F2).** Every turn keeps its step timeline after it finishes, with receipts and Undo
  inline, one approval card everywhere, and a stored answer shown in plain words (no ids or raw JSON). A yes or no
  given later closes the step it answers. The Room's steps read in plain words, and a watch event opens the Room on
  the Stage.
- **Presence (B1).** `GET /api/presence` says what the assistant is doing right now: its name, a mood (idle, thinking,
  working, needs, done), the current step in plain words with the tool and a redacted summary of its arguments,
  where it is working (chat, terminal, browser, desktop, Room), what it watches (mail, calendar, jobs, Room), how many
  things need you, and the turns and jobs in flight. It reads state the app already keeps, never calls a model, asks
  the helpers on this computer at most every five seconds (half a second per request), and is cached for one second.
- **Needs you (B1, F3).** `GET /api/needs-you` is one inbox for everything waiting on you, newest first: held actions from
  chat, jobs and schedules, jobs that ask before they start, and steps the desk and browser helpers paused on.
  `POST /api/needs-you/{id}/approve` and `/deny` answer each item in the system it came from, exactly once: a second
  answer is refused, so nothing is run twice from the inbox. Both routes need the signed in user.
  In the app the inbox is a side sheet opened from the pill at the top, the phone bar and the Jobs page; it lists
  every item with the one approval card, and a Room hand-off reads as what it is about, never by its request number.
- **The Room (B2, F3).** The assistant's own computer is back in the app, honestly this time. It is the `rooks-try`
  package: a Linux guest when QEMU and an image exist, a private desktop with a real terminal in it when Xvfb exists
  (Linux), else a private folder and shell. The app side is `app/room.py` (`/api/room`: status, up, down, checkpoint,
  reset, click, drag, scroll, type, key, run, handoff, screenshot) and the chat tool `use_room`, offered only when a
  real driver is there; the terminal gets the same package as the MCP server `room`; the installer installs it when
  the folder exists.
  - What it says about itself: status carries `screen`, `pointer`, `isolation` (`none`, `namespace` or `vm`), a plain
    label and a note, and `/api/surfaces` carries `room: {available, label, isolation}`. A picture is served only when
    a real screen exists and the Room is on; the drawn terminal ("A drawing of a terminal") is never picked on its own,
    has no pointer, and does not count as a Room for the chat tool. The private folder says "Commands run as you, in a
    folder of its own. It is not a locked off computer."; on Linux its commands run in a private mount namespace (and
    with no network when the Room is offline) when `unshare` works, which is what `namespace` means.
  - What it keeps: saved points never collide in a name, the twenty newest are kept and status names the ones removed;
    "Save a point" and "Start over" are checked against the store before they are reported done.
  - What it never does alone: copying a file out of the Room holds a request in Needs you (`kind: room`) and copies
    once, after a yes there or on the approval card; the chat tool cannot approve it. Every up, down, saved point,
    start over, command and copy is a row in the run log on channel `room`; a refused request is on record too.
  - For the Stage: `use_room` with `action: up` publishes a watch event `{surface: "room", job_id: "room", goal}`, and
    the same card is saved with the reply. Presence reports `where: room` and watches the Room while it is on.
  - The package itself: the nested desktop no longer starts a black canvas with the system Python; it starts a window
    manager when one exists and otherwise a terminal that fills the screen, with this interpreter for any helper; a
    command run in it sees the Room's display; the local HTTP helper compares its key in constant time, serves the last
    picture without waiting behind a running command, and has drag and scroll.
  - In the app (F3): a **Room** page and the Room on the Stage. The picture is drawn only while the Room is on and has
    a real screen; Watch, Step in and Hand back appear only when clicks reach something real; without a screen the
    page is a real command view. Save a point, Start over and Hand off a file are on the page; the rail shows a live
    dot while the Room is on. Jobs and History are rebuilt on the shared parts, with Undo inline in History.
- **Reliability people feel (B3).**
  - A chat that got too long no longer dies on the model's context error. The error is recognised for what it is
    (`prompt too long`, from OpenAI, Anthropic, Gemini and compatible servers, and Ollama's full window), the router
    stops there instead of trying every other provider with the same prompt, and the turn compacts the window and
    asks again, up to three times: the budget is halved, the oldest tool results become one line stubs that still
    lead to the full result through `read_tool_result` (kept under `tool_results`, id `m<message>`), whole old
    exchanges go only after that, and the chat gets a `compacted` event `{dropped_rows, summary_words}` each time.
    When nothing can be left out, or three tries were not enough, the turn ends with "This chat got too long for the
    model. Start a new chat or pick a model with more room." The record is never touched: every result stays whole in
    the thread; only what the model is sent shrinks. The next turn in that chat starts from the window that fitted.
  - The rolling summary is tool aware: tool rows are in it, one line each (the tool, ok or failed, the first 80
    characters of its result), and a note the app wrote (a restart) as a note. When the window is already over budget
    at the start of a turn, or is being compacted, the summary of what fell out is refreshed before the model is
    asked, so it sees it now rather than next turn; otherwise the refresh runs in the background as before.
  - A restart is reported honestly. Every turn still running when the app comes back is closed as interrupted
    ("Rooks restarted during the turn") and its conversation gets a plain note as a system row ("Rooks restarted
    during this turn. These steps were cut off and not run: ..."). The next turn in that conversation opens with a
    `resumed` event `{reason: "restart", at}`. Goals that asked to carry on (`resume_on_restart`) are continued by a
    task that starts with the app, one more round each as a normal turn (registered like any turn, so Stop works),
    never past a held approval. Jobs keep their rule: paused, with Resume.
  - Approvals are never duplicated. A call that is already waiting for your OK with the same arguments is not held
    again: the model is told it is waiting (request number included) and the turn stops with an honest line ("I asked
    once and stopped instead of asking again") instead of asking the model on; the run log records the repeat as
    `duplicate` and the turn as `held`. The Room's hand-off does the same: a second ask for the same file and place
    joins the request that is already in Needs you.
  - The check that catches a false "I sent the email" no longer catches a true one. A send that ran in the turn, or
    one you approved from the card or Needs you, backs the sentence; without one the reply is still withdrawn, with the
    reason in plain words ("no email was sent in this conversation").
- **Sweep (F4).** Colours come only from the tokens (no hex left in feature styles), one reduced motion rule that
  Appearance also applies, two breakpoints (900 and 1280 px), one main landmark on every page, dead code removed, and
  the theme picker previews the Workroom itself. Every page was checked in the shell on a laptop and a phone in both
  modes.
- **Outbound audit (R8, B1).** The helpers' health checks (browser, computer use) now go through the audited client;
  `tests/test_egress.py::test_no_unaudited_network_library_in_the_app` passes again. The loopback port probe that
  finds a free port for a helper is listed there with its reason (a bind sends nothing).
- Migration: none (no schema version change, no data rewritten). The restart notes are ordinary rows in `messages`
  (`role: system`, `name: restart`); compacted results reuse the `tool_results` table with ids `m<message id>`. New
  settings `TRY_URL` and `TRY_API_KEY` are optional (a separate `rooks-try serve`); without them the Room runs in
  process when the package is installed.
- Rollback: check out the previous commit. Set `ROOKS_TRY_MCP=0` so the terminal stops adding the `room` server, and
  ignore `/room` in the app (the tool is only offered while the package is installed; uninstall `rooks-try` to remove
  it). Nothing in the database changes shape: held hand-offs are ordinary held actions and can be denied from Needs
  you, the restart notes are plain messages the older code ignores, and the leftover `tool_results` rows are harmless.
## 2026-11-06 · Ask in the native window; the bridge key signs in · branch feat/native-ask

- **Ask.** The native Rooks window (`desktop/rooks-native`, 0.4.0) can give Rooks a task. Home has a box; the rail has
  an Ask page with the transcript, recent chats, and a composer. The reply streams in as it is written; each tool shows
  as one short line; an `approval_required` event becomes an Allow / No card; Stop calls `POST /api/assistant/stop`.
  Thoughts, receipts and cards never leave the service.
- **Fix: the native window could not attach to a running service.** `workbench_server.py` writes the bridge key
  (`BROWSER_API_KEY`) into `app.json`, but `POST /api/desktop/local-session` and bearer auth compared it with
  `TOOLS_API_KEY`, so a second window always got `401 Invalid key`. New `security.check_app_key` accepts either key
  (both per-install random secrets, loopback only); `local-session` and `surfaces.bearer_ok` use it.
- Migration: none. Data: none. Rollback: revert the commit.

## 2026-11-01 · Long tool results, step limit setting, repeat guard · branch feat/rea-p0-harness

From the competitor review (P0 items 1, 2 and 4):

- **Long tool results are kept, not cut.**
  - Before: a tool result over 20,000 characters (a long email thread, web page or listing) was cut there and the
    model never knew. Now the full result (up to 2 million characters) is stored with its conversation.
  - The model sees the first 14,000 and the last 4,000 characters, the size, and an id. The new `read_tool_result`
    tool reads any part by offset, or finds the passages that mention a phrase. It is offered only once a conversation
    has a stored result.
  - Reads are scoped to the conversation that produced the result. A result from web or email stays untrusted when read
    back, so approval holds still apply.
- **Step limit is a setting.**
  - The default is still 12 model calls per turn.
  - `PUT /api/settings` accepts `max_steps` (overall, 1 to 100, 0 restores the default) and `max_steps_channels`, for
    example `{"schedule": 30}` (0 removes an override). `GET /api/settings` reports them.
- **Repeat guard.**
  - After 3 identical failures in a row (same tool, same arguments, same error), that exact call is refused for the
    rest of the turn. The model is told why.
  - A second attempt at a blocked call ends the turn with an honest summary.
  - New outcome `repeat_blocked` for tool calls and turns; it counts as a failure in the run log. A success, or a
    different call in between, resets the count.
- Migration: new table `tool_results`, created on start, with no data change and no schema version bump. Rows are
  deleted with their conversation.
- Rollback: check out the previous commit. The leftover `tool_results` table is ignored.

## 2026-11-01 · Goal mode: durable objectives with round allowance and verified completion · branch feat/rea-goal

- **Goal mode** attaches a durable objective to a conversation. When a turn ends without the goal met, the assistant
  automatically continues with a new turn, up to a user-settable round allowance (default 5, hard ceiling 50).
- Stops when: the model calls `complete_goal` (verified via receipts so "done" must be backed by confirmed effects);
  allowance exhausted; user cancels; a held approval is pending (never continues past a held action); repeated
  failure/no progress.
- Persists in DB; resume after restart only if `resume_on_restart=true` was set.
- API (`/api/goals`): create/get/list/cancel/pause/resume/update with auth dependencies.
- Progress events integrate with `assistant.py` (turn loop, `hold_reason`), `automations.py`, `jobs.py`, `cli_agents.py`.
- Tests with fake LLM fixtures: continues until met; stops at allowance; stops on pending approval; unverified "done"
  doesn't end it; cancel; persistence across reload.
- Migration: none (new `goals` table created on startup). Rollback: run previous image; table is ignored.

## 2026-10-30 · Sunshine theme and Claude plan via Claude Code · branch feat/sunshine-claude

- **Sunshine theme (new default)**: bright, warm and airy: near-white warm background, soft cards, a clean sans
  (Hanken Grotesk) throughout, pill buttons and a #FFC83D accent used sparingly (text uses an AA darker amber, #8A5A00).
  Paper, Linen, Gallery and Night stay in Appearance, and a saved choice is kept on upgrade. Home, chat, settings,
  first run and the browser agent page are decluttered. Screenshots: `screenshots/sunshine/`.
- **Your Claude plan through Claude Code**: first run offers "Use your Claude plan through Claude Code" with install and
  sign-in status. The new **Coding agent** page runs your own signed-in `claude` (or `codex`) headless in a folder you
  pick: live steps, approvals per edit/command, follow-ups in the same session, and a diff. The app never signs you in or
  reads a token. API: `/api/cli-agents`. See [docs/CLAUDE-CODE.md](docs/CLAUDE-CODE.md).
- **Rooks Code**: `-P claude-code` and `-P codex` delegate to those CLIs with Rooks-style approvals.
- Migration: none. Rollback: pick Paper in Appearance to get the previous look.

## 2026-10-30 · Computer use: Rooks Desk (phase 5) · branch feat/computer-use (on release/v0.1-rc)

- **Rooks Desk** (`rooks-desk`, new package), a computer-use agent for macOS, Windows and Linux/X11:
  - Screenshots of every monitor, downscaled for the model.
  - Mouse, keyboard and hotkeys.
  - Apps and windows.
  - Accessibility trees (AX, UI Automation, AT-SPI).
  - A shell with streaming output.
  - Files in allowed folders, and the clipboard.
  - Each step is plan → act → verify. A `done` claim is checked against the files the task names, and a model that
    says "saved" when nothing was saved gets told so once, then fails.
- **Safety.** It asks before shell commands (and before typing into a terminal), files outside the allowed folders,
  deletes, email and messages, purchases and logins.
  - Logins and dangerous commands can't be pre-approved.
  - Read-only commands that print file contents (`cat ~/.ssh/id_rsa`) still ask outside the allowed folders; `env`
    and `printenv` always ask; commands it runs never see the bridge key or its own token.
  - App and folder allow-lists; password managers are denied by default.
  - A red frame and an on-screen bar while it works.
  - Kill switch: Ctrl+Alt+Esc, the top-left mouse corner, `rooks-desk stop`, or Stop everything.
  - A JSONL receipt with a screenshot per step, and a dry-run mode.
  - `rooks-desk setup` walks through the macOS Screen Recording and Accessibility permissions.
- **MCP.**
  - `rooks-desk mcp` exposes `use_computer` plus 18 low-level tools. Sensitive steps become MCP elicitation questions
    and are refused when the client can't ask you.
  - Rooks Code adds it automatically as the server `desk` (`[mcp] desk = false` or `ROOKS_DESK_MCP=0` turns it off).
  - Rooks Desk can call other MCP servers (`rooks-desk mcp-servers add NAME -- CMD`), for example an AutoCAD server.
    See `rooks-desk/docs/AUTOCAD.md`.
- **App.**
  - New **Computer** page: a live screen, thinking, actions, thumbnails, live shell output, Allow / Deny, Stop
    everything, a "What it may touch" editor, and "Don't ask me this time before it: run commands / save files
    outside my folders / send emails" for a no-stops run.
  - `/api/desk/*` proxies to the Rooks Desk the desktop app starts for you (`WORKBENCH_ROOKS_DESK=0` turns that off).
  - The assistant gets a `use_computer` tool when Rooks Desk is running.
- **Smart router.** It knows which models can see. Requests with screenshots go to a vision model first: Gemini Flash;
  Groq Llama 4 Scout or Maverick and Qwen 3.8; OpenRouter's free Gemma 3, Llama 4 and Qwen2.5-VL. If no vision model
  is available, the images are left out with a note rather than failing. `rooks-desk` is a strong channel.
- **Mail.** `send` supports Cc and attachments. New bridge endpoint `POST /v1/desk/send_email`:
  - It answers only the `rooks-desk` channel with the bridge or desk key.
  - Rooks Desk asks you before it sends.
  - Limits: 20 attachments and 20 MB in total.
- **Installer.** Installs `rooks-desk` (skip with `--no-desk`) and prints the per-OS permission notes. `ai-workspace
  --status` lists it.
- **CI.**
  - A `rooks-desk` job on Ubuntu, macos-14 and windows-2022 (unit tests, a backend import, the CLI).
  - On windows-2022 a real-desktop smoke test (open Notepad, type with real input, read it back through UI
    Automation); on macos-14 it reports the permission state and skips what macOS hasn't allowed.
  - A `rooks-desk-e2e` job that drives Mousepad and xfce4-terminal under Xvfb and uploads the screenshots.
- **Data / migration**: none. Rooks Desk keeps its settings and receipts in `~/.rooks-desk`. **Rollback**: `uv tool
  uninstall rooks-desk`, or install with `--no-desk`.

## 2026-10-30 · Release candidate v0.1 · branch release/v0.1-rc (all feature branches combined)

- **One-command install without Docker**: `install.sh` (macOS, Linux) and `install.ps1` (Windows) install `ai-workspace`,
  `rooks` and `rooks-browser` for the current user. uv brings Python 3.12. When the source has no prebuilt web UI and the
  computer has no Node.js, the installer downloads Node.js 22 from nodejs.org, checks its SHA-256, builds, and removes it.
  See [QUICKSTART.md](QUICKSTART.md).
- **Launcher**: the window opens on a one-time sign-in link served by the app (one use, two minutes), so the launch token
  is never on a command line or in a URL. This fixes a blank "Your file couldn't be accessed" (ERR_FILE_NOT_FOUND)
  window on macOS caused by an earlier temporary redirect file. It waits for the app and checks the web UI loads, logs to
  `logs/launcher.log`, and has `--logs`; `--status` also shows the UI check, version and logs folder. The installer's
  Applications / Start menu shortcut is no longer mistaken for the native app and now has the real icon.
- **Agents**: `rooks` and `rooks-browser` accept `GROQ_API_KEY` and `GEMINI_API_KEY` directly, and explain how to set up a
  model when none is available. rooks-browser on Groq backs off on rate limits, trims long pages to fit, and recovers
  malformed replies.
- **Browser agent page**: live picture while a run works, a screenshot per step, the agent's thinking and actions, and
  Allow / Deny for paused sensitive steps.
- **CI**: `macOS window` workflow (macos-14) installs with the one-command install and checks the window shows the UI.
  The desktop build falls back to ad-hoc signing when the Apple certificate secret cannot be imported.
- **Local models**: the first chat works with whichever Ollama model is installed; Rooks Code prefers an installed
  coder model when Ollama is the only provider; one answer is capped at `OLLAMA_NUM_PREDICT` (4096) tokens; the assistant
  only offers `web_search` when a search provider is set up.
- **Rooks Code**: more robust parsing of tool calls written as text by small models (several JSON objects in one block,
  duplicates run once, mixed native and text calls).
- **CI**: new `mobile` job and an `installer` job that runs the one-command install on Ubuntu, macOS and Windows.
- **Data / migration**: none. **Rollback**: reinstall from `main`.

## 2026-10-30 · Cloud by default: "Choose how to think", Sign in with ChatGPT, smart router · branch feat/cloud-models (builds on feat/skills-and-motion)

- **First run is now "Choose how to think"**, shown on the desktop app's first start and in Docker whenever no model is connected. It offers four options:
  - **Free cloud** (recommended): a guided Gemini or Groq key. It opens the key page, takes the key by paste or from the clipboard, recognises the provider and checks the key before saving it.
  - **Sign in with your subscription**: ChatGPT, through OpenAI's official open-source flow. Claude, SuperGrok and Google AI show "not available" with the reason and a link to the source.
  - **Paste API keys**: OpenAI, Anthropic, xAI, Google, Groq, OpenRouter, Mistral, DeepSeek, or any OpenAI-compatible URL.
  - **Local Ollama**, marked advanced.
- **Smart router.** `auto` (also `auto:fast` and `auto:strong`) is the default model once any cloud provider is connected.
  - Each turn uses a fast or a strong model depending on the task.
  - On a 429, a quota or credit error, a 5xx or an outage, the router moves to the next provider.
  - A provider that hits its daily limit is parked until its reset.
  - Each answer shows who replied and how many free requests are left.
  - The new **Models** page (`/models`) sets the order, the models per tier and the local fallback, and shows quota meters.
  - Chat, the assistant, research, Rooks Code and Rooks Browser all use the router (`-P workbench -m auto`, `X-Workbench-Channel`).
- **New presets**: Groq, xAI, Mistral and DeepSeek. Setup's `GROQ_API_KEY` and `XAI_API_KEY` are now seeded as connections.
- **API.** New endpoints:
  - `/api/providers/detect` and `/api/providers/validate`
  - `/api/router` and `/api/router/reset/{id}`
  - `/api/auth/subscriptions`
  - `/api/auth/chatgpt/*`
  - `/api/status` gains `needs_models`.
- **Data / migration.** One new table is created on startup: `router_state` (additive). The router settings are stored in the `router` setting. Existing default models are not changed; `auto` becomes the default only when no default was set.
- **Rollback.** Check out `feat/skills-and-motion`. The old build ignores `router_state`, but a default model of `auto` has to be changed back in Settings.
- **Docs**: `docs/models-and-router.md`, and `docs/hosted-free-tier.md`, which is a design only.
- **Tests.** The backend has 212 passing tests, including:
  - router fallback with fake 429, daily-limit and 5xx providers
  - stream fallback and quota headers
  - onboarding and key validation
  - Sign in with ChatGPT end to end against a fake OAuth server
- **Bundle.** JS is 464.11 kB (137.34 kB gzip) and CSS is 56.48 kB (11.83 kB gzip).
- **Screenshots** are in `screenshots/models/`.

## 2026-10-30 · Signature motion, simple appearance controls, secure GitHub skills · branch feat/skills-and-motion (builds on feat/premium-ui)

- **Tracer.** While the assistant, a research job, a browser-agent task or a run is working, a thin cherry line with an ink tip travels around the composer or card border. It is drawn as an SVG rect with `stroke-dashoffset` on the compositor, so it adds no layout work.
- **Motion.** Added page-turn route transitions, staggered cards, press and hover feedback, and nav dots.
  - There is a new **Motion** setting: Full, Subtle (slower tracer, fades only) or Off (a static 1px line, no animation).
  - The OS "reduce motion" setting always wins.
- **Appearance page** (`/appearance`, also in the sidebar foot and the Cmd/Ctrl-K palette) has these controls, all with a live preview:
  - Theme: Paper, Linen, Gallery or Night
  - Typeface: Editorial, Modern, Classic or System
  - Text size: 12–18 px
  - Spacing: Comfortable or Compact
  - Motion
  - Accent: Cherry, Ink, Cobalt, Forest or Ochre

  Settings are stored in the browser as `wb-appearance`. The old `wb-theme` value migrates automatically ("dark" becomes Night). The sidebar Light/Dark switch is gone; the palette has "Paper theme", "Night theme" and similar commands.
- **Simpler navigation.** The sidebar now has three groups:
  - Primary: Home, Chat, Tasks, Notes, Calendar, Mail
  - Agents: Automations, Skills, Research, Browser agent
  - A collapsible **More** group (remembered as `wb-nav-more`) holding the admin pages
- **Skills page** (`/skills`; the old `/assistant-skills` redirects to it).
  - Add a skill or MCP server from a GitHub link, or search GitHub.
  - Every candidate passes an 8-stage gate: pinned fetch, code scan, prompt-injection scan, permission manifest, sealed trial run, risk verdict, your per-permission approval, and run-time enforcement with an audit log.
  - High risk is blocked unless you type `install <name> anyway`.
  - Updates re-run the gate and show a diff. Access an update newly asks for is never pre-ticked.
  - Installed skills can be turned off or uninstalled. Blocked run-time actions become requests under **Activity**.
  - Installed skills are available to the assistant (`load_skill`, `run_skill_script`) and to Rooks Code over MCP.
  - Details and known gaps: `docs/skills-security.md`.
- **Data / migration.** Three new tables are created on startup (`hub_skills`, `skill_audit`, `skill_permission_requests`; additive, `CREATE TABLE IF NOT EXISTS`). Skill files live in `DATA_DIR/skills/{staging,installed}`. No existing data changes.
- **Rollback.** Check out `feat/premium-ui`. The new tables and `DATA_DIR/skills` are ignored by older builds and can be deleted.
- **Tests.**
  - Backend: 197 pass, including 30 skill-gate tests in which every malicious fixture comes out High and is refused, and the benign ones come out Low and install.
  - Frontend: `npm test` runs 6 Appearance unit tests with Node's built-in runner.
- **Bundle.** JS is 444.43 kB (132.37 kB gzip) and CSS is 51.25 kB (10.93 kB gzip).
- **Screenshots** are in `screenshots/skills/`, including `tracer-composer.mp4` and `tracer-composer.gif`.

## 2026-10-30 · iPhone and Android companion app (phase 4) · branch feat/mobile-app (builds on feat/premium-ui)

Workbench side (pairing, API, push hook). The app itself is in `mobile/`; its lines follow.

- **Pairing.** Settings → Phone shows a QR code and an 8-character code (5 minutes, single use, stored hashed). The phone exchanges it for a device token (`wbd_…`, stored hashed; kept in the phone's Keychain/Keystore). Settings lists paired phones and unpairs them. Ten wrong codes per address per 5 minutes are refused.
- **Scoped phone API** under `/api/mobile/*`: home glance, approvals approve/deny, runs and traces, tasks, notes, conversations, model list, chat (streamed, channel `mobile`), photo and voice attachments, push token. A device token cannot reach Settings, keys, mail, the password or other phones. Decisions from the phone are logged with channel `mobile`.
- **On your Wi-Fi.** Desktop app: "Phone access on this Wi-Fi" starts a listener on `0.0.0.0:8766` (`WORKBENCH_MOBILE_PORT`) that serves only `/api/mobile/*` and `/healthz`; remembered across restarts. Docker: `BIND_ADDRESS=0.0.0.0` plus `MOBILE_URLS`.
- **Away from home.** A relay address (Tailscale, Cloudflare Tunnel, or a future relay) in Settings or `MOBILE_RELAY_URL` is offered to the phone after the Wi-Fi address. See `docs/mobile-pairing.md`.
- **Push (off by default).** "Approval needed" and "Run finished" through Expo's push service, only when Settings → Phone → Push notifications is on and a phone registered a token. Needs Expo/APNs/FCM credentials in the app build.
- **New tables** `devices` and `pairing_codes` (created automatically; no data migration, schema version unchanged). New dependency `segno` (QR codes, pure Python). Rollback: run the previous build; the two tables are ignored.
- Screenshots: `screenshots/mobile/settings-phone-*.png`.

The app (`mobile/`, Expo SDK 58, React Native, TypeScript, Expo Router; see `mobile/README.md`):

- **Screens.** Today (what needs you, an ask box, jobs on the desk, tasks, notes), Chats, Chat (streaming-style reveal, Markdown and code blocks with copy, tool receipts, inline approvals), Approvals (one-tap Approve/Deny, tab badge), Runs (live status, "Needs a look", receipt with trace), Settings (paired computer, model, Paper/Ink/System, haptics, notifications, unpair) and Pair (QR scan, typed address and code, `aiworkspace://pair` deep link).
- **Compose from the phone.** On-device dictation (development build), photo from camera or library, image/audio files (10 MB); attachments go to the computer and are referred to in the message.
- **Security.** Device token in SecureStore (Keychain/Keystore, this device only); tokens revocable from either side; every chat and decision from the phone is logged as a receipt with channel `mobile`; chat sends an Idempotency-Key; no secrets or credentials in the repo.
- **Push.** Expo push for "Approval needed" and "Run finished"; tapping opens the approval or run. Needs an EAS project id plus APNs/FCM V1 credentials (documented).
- **Look.** The editorial redesign on the phone: warm paper `#F5F1E8` and ink, Bodoni Moda and Hanken Grotesk, cherry red `#D21F3C`, baby-blue fills, hairline rules, square corners, fade/lift page turns and haptics. Optional dark (Ink).
- **Builds.** `eas.json` profiles for a development client, an Android preview APK and store builds; README covers Expo Go, TestFlight, Play internal testing and store release (Apple US$99/year, Google Play US$25 once).
- **Checks.** 37 jest tests (pairing links, SSE parsing, Markdown, reveal, turn reducer, API client), typecheck, lint, `expo-doctor` 20/20, web export. Phone screenshots: `screenshots/phone-*.png`.

## 2026-10-30 · Editorial UI redesign (light-first) · branch feat/premium-ui (builds on feat/desktop-app)

Replaces the dark, gradient "premium" look with a quiet 90s fashion-editorial style. The structural work from the premium pass is kept: command palette, code blocks, skeletons, streaming and accessibility.

- **Light by default.** Warm paper (#F5F1E8) and near-black ink (#141311). Dark mode is an opt-in toggle (Light / Dark in the sidebar or the palette). It is stored in `wb-theme` and no longer follows the OS setting.
- **Type.** Bodoni Moda (Didone, optical sizes) for headings and the wordmark, Hanken Grotesk for the UI and JetBrains Mono for code. All three are bundled locally (OFL 1.1). Inter has been removed.
- **Colour.** One accent, cherry red (#D21F3C; #B5122B for text), and a baby-blue secondary (#D5E5F4) used only for fills. Every text pair meets WCAG AA.
- **No gradients, glow, blur or sparkle icons.** The logo mark is now a typographic wordmark. Surfaces are flat with hairline rules and square corners, and nav items are text only.
- **Motion** is limited to fades and small page turns, and is fully disabled under `prefers-reduced-motion`.
- **Desktop splash and welcome screen** were restyled to match. The splash bundles its own Bodoni subset (116 KB).
- **Bundle:** JS 410.07 kB (122.45 gzip), CSS 37.41 kB (8.13 gzip).
- Screenshots are in `screenshots/editorial/`.

## 2026-10-30 · Premium UI redesign + animations · branch feat/premium-ui (builds on feat/desktop-app)

* New design system in `workbench/frontend/src/styles.css`: tokens for colour, type, spacing, radius, elevation and
  motion, with light and dark themes checked for WCAG AA contrast. The theme follows the OS; a System / Light / Dark switch
  in the sidebar overrides it (stored in the browser as `wb-theme`).
* Inter and JetBrains Mono are bundled (`@fontsource-variable`, OFL 1.1). The app makes no font requests to the network.
* Cmd/Ctrl+K command palette for pages, new chat / note / task and the theme.
* Chat: new message layout, code blocks with a language label and a Copy button, a streaming reveal with a caret,
  a typing indicator, an auto-growing composer with the model picker, and suggestion cards on an empty chat.
* Redesigned app shell and sidebar, auth, the desktop welcome flow and the desktop splash (`desktop/ui/index.html`), with
  skeleton loaders, empty states, toasts and modals.
* Motion stays between 120 and 240 ms and is CSS only. All of it switches off under `prefers-reduced-motion`. Focus
  rings are visible and every new control works from the keyboard.
* Bundle: JS 398.6 → 411.1 kB (gzip 118.7 → 122.7 kB), CSS 14.5 → 39.6 kB (gzip 3.8 → 8.6 kB), plus 88.7 kB of Latin
  fonts (Latin Extended, 85 kB, loads only when a page needs it). No new JS dependencies.
* Docs: README image size now uses the CI figure (248 MB), and the BACKLOG note for item 116 records that it is merged.

No API, schema or backend changes; no action needed on upgrade. Rollback: revert the merge.

## 2026-10-30 · Desktop app for macOS and Windows (preview) · branch feat/desktop-app

* New `desktop/`: a Tauri v2 app that runs Workbench natively, without Docker. The backend is frozen with PyInstaller
  and started as a sidecar on `127.0.0.1` with a per-user data folder; the window signs itself in with a one-time
  launch token (no password).
* First-run welcome: paste an API key for any key-based provider, or use local Ollama, then land in chat.
* Provider keys, `APP_SECRET` and the tools key live in the OS keychain in the desktop app.
* `.github/workflows/desktop.yml` builds `.dmg` (Apple silicon + Intel), `.msi` + `.exe`, `.deb` + `.AppImage` on manual
  dispatch and on tags. Signing, notarisation and the updater activate when their secrets exist
  ([docs/desktop-release.md](docs/desktop-release.md)). Builds are unsigned until then.
* MIT `LICENSE` added (owner to confirm).

Docker installs: no action needed and no schema change. The new backend behaviour only switches on with
`WORKBENCH_DESKTOP=1`, which only the desktop app sets; Docker keeps Fernet-encrypted keys under `APP_SECRET`.
Rollback: revert the merge; desktop-app data lives in its own per-user folder and does not touch Docker volumes.

## 2026-10-30 · Terminal coding agent (Rooks Code) · Phase 2

**New:** `rooks-code/`, a model-agnostic coding agent for the terminal (OpenAI, Anthropic, OpenRouter, any
OpenAI-compatible server, Ollama, LM Studio). Interactive and one-shot modes; read, search, diff-based edits and shell
commands in a loop; approval by default, trusted folders, `--dry-run`, undo of the last prompt's change set, hard
per-session token and dollar caps, a stdio MCP client, and receipts in Workbench's run-log format
(`rooks receipts import --db workbench.db`). Standard library only, Python 3.11+. CI tests it on macOS, Windows and Linux.

**Migration steps:** none. It is a separate, optional tool: install with
`uv tool install "git+https://github.com/Inclined88888/ai-workspace#subdirectory=rooks-code"`. Workbench, its database
and `cli/ws` are unchanged.

**Rollback steps:** `uv tool uninstall rooks-code` (or `pip uninstall rooks-code`). Per-project `.rooks/` folders hold
only receipts and undo snapshots and can be deleted.

## 2026-10-30 · Rooks Browser: a local AI browser agent (phase 3)

New, optional: `rooks-browser/`, a browser agent that drives your own Chrome or Edge through Playwright. It installs
as a ≈ 150 MB Python package, not a 2.5 GB image.

* **Models:** OpenAI, Anthropic, OpenRouter, Ollama, OpenAI-compatible servers or Workbench's model connections.
* **Pages:** it reads the page's element list and text, plus screenshots for vision models.
* **Actions:** search (SearXNG or a fallback search page), open, click, type, scroll, extract and download.
* **Approvals:** it asks before form submits, purchases, messages and logins.
* **Sites and receipts:** it keeps per-site allow and deny lists, and logs every visited URL as Workbench run-log
  receipts.
* **Passwords:** it never stores or types them.
* **Ways to call it:** a CLI, a local HTTP API that is compatible with the `browser` add-on's job API, and an MCP server.

Nothing changes for existing installs. The `browser` add-on, Workbench and the database are untouched.

* **To try it:** `uv tool install ./rooks-browser`.
* **To use it from Workbench:** set `BROWSER_URL=http://host.docker.internal:8765` and `BROWSER_API_KEY` to the token
  you start `rooks-browser serve --host 0.0.0.0` with.
* **Rollback:** remove those two settings, or uninstall the tool.

## 2026-10-29 · Fix upgrades from the original ROOKS database

Older ROOKS installations used `tool_runs(at, ok, actor, mission_id, ...)` before
receipt-style `created_at`/`outcome` fields existed. Upgrades now detect and migrate
both layouts instead of crash-looping with `no such column: created_at`. Original
timestamps, execution outcomes, latency, conversation links and actor/mission
metadata are preserved; historical success is not labelled verified. Sensitive
arguments/errors are redacted in the new trace. A full pre-upgrade database backup
is retained. Unknown layouts roll back without dropping the source rows.

Rebuild/restart Workbench after pulling this fix. No database reset, volume deletion,
secret rotation or manual SQL is needed. Existing schema-v2 installations are unchanged.

## 2026-10-29 · Phase 0 acceptance and release foundations · 73, 79, 83, 84, 80

* Authenticate main API schema discovery at `/api/openapi.json`.
* Terminal tasks carry persisted idempotency keys; `ws retry` deliberately reuses
  the key. Stream failures exit nonzero; config writes are atomic and private.
* Paperclip telemetry is explicitly disabled via upstream environment controls.
* Add keyless signed-artifact release workflow and verification instructions.
* Exercise task write/read/restart under a 1 GiB core-container limit in CI.
* Verify credential encryption through API writes and ciphertext readback tests.

No schema/key migration. Recreate enabled Paperclip containers to apply its new
environment. Roll back the image/client if needed; preserve volumes and APP_SECRET.
[Phase 0 gate](docs/history/PHASE0-GATE.md) records the acceptance assumptions and limits.

## 2026-10-29 · Official Codex CLI launcher · Phase 1 item 117

Optional `codex` profile reuses Item 116's unchanged Node transport. The official
CLI is pinned to 0.163.0; a CLI-specific adapter sanitizes login status and forwards
only the task result. Analytics, feedback and all OTel exporters are disabled.

Enable and authenticate through [the official CLI](cli-launcher/CODEX.md).
No database migration or core dependency change. Roll back by disabling the profile;
auth and workspace volumes remain. Live login/inference and egress checks require
owner acceptance.

## 2026-10-29 · Official Claude Code launcher · Phase 1 item 116

**New:** optional `claude-code` Compose profile, with the official CLI pinned to 2.1.308.
The dependency-free Node transport checks official CLI auth, sends tasks on stdin,
returns output privately, and terminates bounded subprocesses. Nonessential traffic
and auto-updates are disabled. No provider/session adapter or core Node dependency.

**Migration steps:** opt in with `./setup.sh --with claude-code` (include any existing
add-ons in the list), then sign in through the official CLI. See [launcher setup and
API](cli-launcher/README.md). No database migration or breaking change.

**Rollback steps:** disable with `./setup.sh --with none`, or rerun setup listing only
your other add-ons. Login and workspace volumes are kept; official logout and volume
removal are documented separately. Existing core installs stay off by default.

## 2026-10-29 · Outbound audit log · Phase 0 item 75

**New**
* Every outbound request Workbench makes is recorded in the run log as an `egress` row: destination host, local or
  internet, which part of Workbench made it, method and path, outcome and latency. Query strings are not recorded,
  and tokens in URL paths are masked.
* The System status page has an **Outbound connections** section. It shows each host contacted in the last 24 hours, and
  a "Local only" line when nothing went beyond this machine or its private network.
* API: `GET /api/egress?hours=24` (1 to 2160). It needs sign-in or the CLI token.

**Not covered:** traffic that add-on containers make themselves, for example pages the browser agent visits or models
the ollama container downloads. Workbench's own calls to them are recorded. See BACKLOG.

**Breaking changes:** none. The run log grows by one row per outbound request. **Migration steps:** none (schema v2
unchanged; design record 0001 documents the rows). **Rollback steps:** run the previous image. Existing `egress` rows
stay and are ignored.

## 2026-10-29 · System status page · Phase 0 item 25

**New**
* A **System status** page (sidebar, `/status`) shows each part as Working, Degraded, Down or Not set up, with the reason
  and the probe time. Parts covered:
  * the database (schema version, free disk) and the four background loops;
  * every model connection, probed for real: a rejected key or an unreachable server is Down, even when model names
    were typed in by hand;
  * the browser and SearXNG add-ons;
  * web search, Telegram, calendars and mail accounts.
* Checks run only when the page is opened or Check again is pressed, never in the background (R8). Results are kept for
  one minute. Paid search APIs (Brave, Tavily) are shown as configured but not probed, because a probe costs a query.
* API: `GET /api/health` (`fresh=true` to re-check). It needs sign-in or the CLI token. A probe also records `last_ok_at`
  and `last_error` on the connection.

**Changed**
* `/healthz` now also reads the database. It answers 503 when SQLite is unreadable, the schema version is wrong or the
  data volume has under 50 MB free, so Docker marks the container unhealthy instead of reporting it healthy.

**Breaking changes:** none. **Migration steps:** none (schema v2 unchanged). **Rollback steps:** run the previous image.

## 2026-10-29 · A change is made once · Phase 0 item 28

**New**
* When a model repeats a write in the same turn (the same tool with the same arguments, nothing else changed in between),
  the repeat is not run. The run log records it as `duplicate`, and the model is told it was already done. Reads and
  retries after a failure still run.
* `POST /api/assistant/chat` accepts an `Idempotency-Key` header. A retried request with the same key is not run again;
  the answer is 409 with the first turn's `conversation_id`, `turn_id` and `outcome`. A malformed key gets 400.
* Telegram no longer answers a message twice when the bot restarts before Telegram has been told the message was read.

**Breaking changes:** none. A client that sends an `Idempotency-Key` it reuses for different messages will now get 409;
send a new key per message. **Migration steps:** none (schema v2 unchanged; design record 0001 documents the keys).
**Rollback steps:** run the previous image. Rows recorded as `duplicate` stay in the run log and count as neither success
nor failure in the reliability record.

## 2026-10-29 · Run log page · Phase 0 item 21

**New**
* A **Run log** page (sidebar, `/runs`) lists every turn and every model call made outside a turn, newest first, with its
  outcome, channel, model, model and tool call counts, tokens, cost and duration. Filter by channel or show only runs
  with a failed step.
* Opening a run shows its trace: each model call (provider, auth kind, protocol, latency, tokens, cost), each tool call
  (effect, redacted arguments, failure, receipt) and each approval decision nested under the call it answered.
* API: `GET /api/runs` (`limit`, `before`, `channel`, `failed`, `conversation_id`) and `GET /api/runs/{id}`. Both need a
  signed-in session or the CLI token. Encrypted raw arguments of held calls are never returned.

**Breaking changes:** none. **Migration steps:** none; the page reads the existing run log (schema v2 unchanged).
**Rollback steps:** run the previous image. No data changes.

## 2026-10-29 · The browser agent uses Workbench's models · Phase 0 item 3 (part b)

**Breaking changes**
* `BROWSER_LLM_PROVIDER` and `BROWSER_LLM_MODEL` in `.env` are no longer used by the stack. The browser agent now calls the
  models connected in Workbench through Workbench (`/v1/chat/completions`, authenticated with `BROWSER_API_KEY`).
  * Pick the model on the Browser agent page.
  * From chat, the conversation's model is used.
  * Paperclip and Hermes browser runs use Workbench's default model.
* The browser container no longer receives `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY`.
  Inside the stack it refuses any other provider (rule R1).
* Browser model calls now appear in Workbench's usage (channel `browser`). Monthly totals rise by what browser runs already
  spent, which was previously invisible to Workbench.
* The standalone `browser-agent` CLI, used without Workbench, keeps its direct providers.

**Migration steps**
1. Connect the model you want the browser to use in Settings → Model providers. A previous browser-only key must be
   added there.
2. Run `./setup.sh` or `docker compose up -d` to recreate the browser container.

**Rollback steps:** run the previous images. Their compose file passes the provider keys to the browser container again.

## 2026-10-29 · Schema version 2: connections (auth kind + protocol) · Phase 0 item 3

**Breaking changes**
* The `providers` table is replaced by `connections`. Each connection has an `auth_kind` (API key, local Ollama, OpenAI
  compatible server, subscription sign-in) and a `protocol` (Chat Completions, OpenAI Responses, Anthropic Messages, Ollama
  native) instead of the old `kind`. Ids are kept, so every saved model choice (`3/claude-…`) keeps working.
* `/api/providers` returns `auth_kind`, `protocol`, `state` and `last_error` instead of `kind`. It still accepts `kind` when
  creating a connection.
* New connections from the **OpenAI** preset use the Responses API, and from the **Anthropic** preset the native Messages API.
  Existing connections keep the protocol they used (Chat Completions); change it in Settings → Model providers.
* Connection types that are not legitimate are refused with an R5 message. No existing connection is affected: none can be of
  that type.
* A connection that cannot be used (for example one that needs sign-in) no longer breaks the model list; it shows its error in
  Settings.

**Migration steps:** automatic on first start. Workbench copies the database to `workbench.db.pre-v2-<UTC time>.bak`, then moves
every provider into `connections` in one transaction. On failure nothing changes and the database stays at version 1.

**Rollback steps**
1. `docker compose stop workbench`
2. Replace `workbench.db` with the newest `workbench.db.pre-v2-*.bak` (delete `workbench.db-wal` and `workbench.db-shm` if present).
3. Start the previous image.
4. Connections added after the upgrade are lost.

## 2026-10-29 · Logs and error messages are redacted (R7, item 110) · PR #4

**Breaking changes**
* Logs, the run log's text columns, HTTP error bodies (including 422 validation errors) and chat error events no longer
  contain the following, each replaced by a marker such as `<redacted>`, `<redacted:key>`, `<email>` or `<phone>`:
  * Telegram bot tokens
  * cookies and session ids
  * Authorization header values
  * JWTs
  * provider API keys (`sk-…`, `sk-ant-…`, `sk-or-v1-…`, `AIza…`, `gh*_…`, `xox*-…`, `tvly-…`, Workbench `wb_…` terminal tokens)
  * named secrets (`api_key`, `access_token`, `refresh_token`, `id_token`, `client_secret`, `password`, …)
  * email addresses
  * phone numbers
* Anything that parsed Workbench logs for those values (for example an email address in an approval or receipt trace)
  now sees the marker.
* Conversations, notes, mail and other user data are not changed.

**Migration steps:** none. It applies from the first start.

**Rollback steps:** run the previous image. Log lines written while this version ran stay redacted.

**Known limit:** a phone number written as one unbroken run of digits (`0412345678`) is not redacted. It cannot be told
apart from timestamps and ids.

## 2026-10-29 · Schema version 1: one run log (`actions`) · PR #3, merge 36b8070

**Breaking changes**
* The tables `usage`, `tool_runs`, `turn_checks` and `pending_actions` are replaced by one table, `actions`. External
  scripts that queried the old tables must query `actions` (see docs/design/0001-run-log-and-connections.md for the
  column mapping).
* Approval request ids change during the upgrade. The web app refetches them. An id copied before the upgrade and typed
  into `ws approve <id>` returns 404: run `ws approvals` again.
* **Cost reports split for one billing period.** Legacy `usage` rows keep the bare model name (`gpt-x`) in `model`.
  New rows store the model reference (`3/gpt-x`). For the month of the upgrade, Settings → Usage lists the same model
  twice, once per form, and the totals per model are split across the two lines. The monthly total and the per-agent
  budgets are correct, because they sum all rows. From the next month the split disappears.
* Model calls made by research, writing assist, compare and task breakdown are now recorded and counted. Monthly
  totals can rise compared with before, because that spend was previously invisible.

**Migration steps:** automatic on first start.
1. If any legacy table exists, Workbench copies the database file to `workbench.db.pre-v1-<UTC time>.bak` next to it
   (in the `workbench` volume).
2. All legacy rows are copied into `actions` in one transaction, the legacy tables are dropped, and
   `PRAGMA user_version` is set to 1.
3. If anything fails, the transaction rolls back, the database stays at version 0 with all data, and the error is
   logged.

**Rollback steps**
1. `docker compose stop workbench`
2. In the `workbench` volume, replace `workbench.db` with the newest `workbench.db.pre-v1-*.bak` (and delete
   `workbench.db-wal` and `workbench.db-shm` if present).
3. Start the previous image.
4. Anything recorded after the upgrade (costs, approvals, tool runs) is lost.