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

* **Claude Code launcher add-on (Item 116, decision D2).** Merged to `main` as an optional official CLI hand-off in `cli-launcher/` (Compose profile `claude-code`). Item 117 (Codex) is merged on the same transport. Still open: a maintainer has to validate live subscription login and a real prompt. Node stays in the add-on (R6).
* **Idempotency across interleaved writes (item 28 follow up).** A model loop of the form A, B, A runs A twice, because a repeat is only recognised when no other change ran in between (so toggles keep working). Closing it needs per tool semantics (which writes are naturally idempotent). Design record 0001, "Idempotency keys".
* **The web chat does not send an Idempotency-Key yet.** It never retries a request, so there is nothing to deduplicate; the CLI (item 84) should send one.

* **Add-on egress is not in the outbound audit log (item 75 follow-up, R8).** The browser agent's own page loads, model downloads by the ollama container, Paperclip and Open WebUI connect from their own containers. The browser agent already lists visited URLs in its job steps; ingesting them as `egress` rows (and asking Paperclip/Open WebUI for an equivalent or documenting their egress) would make local-only mode verifiable for the whole stack, not only Workbench.
* **Audit log retention.** `egress` rows are kept forever. With Telegram on, long polling adds about 2,880 rows a day (estimate, not measured). Needs a retention setting with a documented default, and an export before pruning.
* **Link egress rows to the run that caused them.** Egress rows have no `parent_action_id`; a context variable carrying the current turn would put a turn's outbound calls in its trace.

## Found during work, not yet scheduled

* **The Room's pointer and keyboard steps are not in the run log (B2 of feat/workroom).** `/api/room` records up,
  down, saved points, start over, commands and copies out (channel `room`); click, drag, scroll, type and key are not
  recorded, because a person stepping in produces several a second and would swamp the log. Design 0003, section 4,
  rule 4 says "every Room action"; decide whether to record them in batches (one row per step-in session) or to leave
  them out and say so on the page.
* **A repeated hand-off request from the model makes a second held item.** `use_room` with `action: handoff` and no
  `request_id` always holds a new request; if the model asks twice for the same file before a person answers, Needs
  you shows two. B3's held approval dedupe should cover it (same tool, same arguments, one still pending).
* **The terminal's Room MCP server lets the calling agent set `approve: true` on handoff.** In the app, the copy out
  of the Room waits for a person in Needs you. In the terminal, `rooks-try mcp` takes the agent's own flag; rooks-code
  treats the server as untrusted, so its usual approval prompt is the only gate. Replace the flag with an MCP
  elicitation question, as Rooks Desk does, so a person answers in the terminal too.
* **The Room has no real screen on macOS and Windows yet.** Only the private folder and shell (and the drawn terminal
  by name) work there; a virtual machine driver (Apple Virtualization or QEMU with a guest agent and an in-process
  screen viewer) is the next driver behind the same interface. Design 0003 records this as out of scope for the branch.

* **Presence polling fills the outbound audit log with loopback rows (R8 follow-up, found in B1 of feat/workroom).**
  Every call to the desk and browser helpers on this computer is an `egress` row (effect `local`). The presence strip
  polls every second; `needs_you` keeps the helpers' answer for five seconds, so with both helpers on an open app adds
  about 35,000 local rows a day on top of Telegram's 2,880. Two ways out, both decisions for the owner: the retention
  setting already listed above, or exempting loopback helper polls from the audit (they never leave the machine, and
  `local_only` ignores them anyway). Until then the five second keep is the only brake.
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

