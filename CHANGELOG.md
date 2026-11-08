# Changelog

Every user-visible change that needs action, or changes data on upgrade, gets an entry: date, version, breaking changes,
migration steps, rollback steps. Workbench has no release numbers yet (BACKLOG). Entries are identified by schema
version and the merge commit on `main`.

## Unreleased · Phase 1a: terminal safety · branch phase-1a/terminal-safety

No schema change, nothing to migrate. Rollback: revert the branch's commits.

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
[Phase 0 gate](docs/PHASE0-GATE.md) records the acceptance assumptions and limits.

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