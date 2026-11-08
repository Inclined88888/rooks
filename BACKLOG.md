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

### The Room's browser (design 0007), engine and API lane: not done here

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
* **No Settings switch in the app's screens** for `room_browser` (the setting and its route exist, as for the app's
  terminal); the window says "switched off in Settings" and links there.
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
* **Terminal approvals with the bridge key (pre existing, not widened).** `/v1/rooks/approvals/{id}` lets a bridge key
  record an answer to a terminal held row (`terminal:` request ids only). It runs nothing on the server, but a coding
  job could record an answer to its own terminal prompt. Owner decision.
* **Stored Terminal access token.** A coding job with shell access runs as the person and could read the token
  `rooks login` stores; the read only bridge key closes the app's own routes, not a hostile local process.
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
* **The terminal's Room MCP server lets the calling agent set `approve: true` on handoff.** In the app, the copy out
  of the Room waits for a person in Needs you. In the terminal, `rooks-try mcp` takes the agent's own flag; rooks-code
  treats the server as untrusted, so its usual approval prompt is the only gate. Replace the flag with an MCP
  elicitation question, as Rooks Desk does, so a person answers in the terminal too.
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
* **Standalone browser-agent CLI keeps its own providers.** Outside the stack (no `BROWSER_REQUIRE_WORKBENCH`), `browser-agent run` can call Anthropic, Gemini, Ollama and the like directly. That is a separate distribution, not core, but it is a second provider layer. Retire it if the CLI gains a `--workbench` default.

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

