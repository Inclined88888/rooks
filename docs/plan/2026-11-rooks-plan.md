# Rooks: the plan to match the leaders, and why people would pick it

Written 2026-11-08, revised the same day after a sceptical review (last section). Not committed. Inputs: three audits of Rooks run on 2026-11-08 against a scripted fake model (terminal **[A-T]**, app **[A-A]**, learning and automations **[A-L]**), design records 0003, 0004 and 0006, BACKLOG.md, CHANGELOG.md, LICENSE, VERSION, and the competitor research under Sources (**[S1]** to **[S29]**). Anything else is marked *(our judgement)*. The browser is set aside for now, as the owner asked.

## 1. The goal

Rooks is a personal assistant for work and home that a non-technical person can trust with real tasks. It is one assistant across the terminal, the app and the phone, with one memory. It has its own computer, the Room, where everything can be undone. It does what you teach it every day and asks before it acts, and no background agent ever approves its own request. The terminal must match Claude Code, Codex and Hermes for coding work. The app must match Claude Cowork and ChatGPT for daily work. Where Rooks claims to be different, the difference must be real and tested.

Two of those sentences are not true today, and the plan fixes them before the pitch uses them: a coding job can record an answer to its own terminal prompt through the bridge key, and the Room's terminal MCP server takes `approve: true` from the calling agent (BACKLOG, "Terminal approvals with the bridge key" and "The terminal's Room MCP server"). On macOS and Windows the Room is a private folder and shell, not a separate computer (BACKLOG, "The Room has no real screen on macOS and Windows yet").

**What "as good as the competitors" means:**

| Surface | The bar |
| --- | --- |
| Terminal | Every must-have from [A-T] closed: rewind, permission rules by command, headless JSON and a library, MCP over HTTP with sign-in, prompt caching, local skills and commands, full hooks. No known defect open. No path by which an agent answers its own approval. |
| App | One memory you can see, web search with no key, approvals reachable away from home Wi-Fi, tools loaded on demand, every [A-A] defect fixed, fewer pages. |
| Learning | Teach once, it runs daily, it holds anything that sends or pays for your yes. Skills are versioned and can be rolled back. New facts replace old ones. The terminal can do all of it. |
| Install | A signed desktop app with updates on, and a one-line install a non-technical person finishes alone (tested with real people, not only VMs). Uninstall leaves nothing behind. |
| Proof | A fixed task set run with real keys, published with pass rate, tokens and cost, next to Claude Code on the same model. Without it "as good as" is a claim, not a result. |

## 2. Where Rooks stands today

CC = Claude Code. Cowork = Claude's assistant app. Marks: ahead, level, behind, missing.

### Terminal (`rooks`, from [A-T])

| Capability | Rooks today | Leaders | Mark |
| --- | --- | --- | --- |
| Read, edit with diff, run; plan mode | Solid | CC [S3], Codex; OpenCode plan/build on one key [S26] | level |
| Choice of model | 18 providers, local models, the user's own CC or Codex CLI | CC: Claude only [S2]; Codex CLI: API keys and configurable providers [S16]; Hermes, OpenCode, Aider, Crush: any model [S10, S26, S29]; Goose: 15+ providers and existing Claude, ChatGPT or Gemini plans through ACP [S25] | ahead of CC; level with the open-source field |
| Spending cap, receipts | Hard cap per session (tokens and dollars), receipt per call, edits checked by sha256 | CC: per-org spend limits and usage credits [S8]; Hermes v0.23.0: spend limits on paid MCP tools [S11] | ahead on a per-session hard cap; partly matched |
| Write sandbox | On by default (Linux, macOS); network open; none on Windows | CC: off by default [S7]; Codex: read-only, network off [S15]; Hermes: Docker, SSH, Modal, Daytona, Vercel backends [S10] | ahead of CC, behind Codex and Hermes |
| Approval holes | A coding job can record an answer to its own terminal prompt through the bridge key; Room MCP `handoff` takes the agent's `approve: true` (BACKLOG) | not in the research | defect |
| Rewind code and conversation | Files only | CC /rewind [S4]; Hermes v0.23.0 [S11]; OpenCode /undo and /redo, Gemini CLI checkpoints [S26] | behind |
| Permission rules by command | "a" approves a whole class of action | CC allow and deny rules [S3]; Codex exec policy [S14] | behind |
| Headless JSON output, library | None; piped input opens the interactive loop | CC `-p` and Agent SDK [S1]; Codex `exec` [S16] | missing |
| MCP | stdio only; "a" on one MCP tool approves every MCP tool | CC, Codex: HTTP with sign-in [S1, S18] | behind |
| Prompt caching | None | CC; Aider `--cache-prompts` [S29] | missing |
| Project instructions | Reads AGENTS.md, CLAUDE.md, ROOKS.md (`extras.py:31`), but only at start | CC, Codex | level once `/init` reloads |
| Skills and commands without the app | None; `.claude/skills` and `.claude/commands` are not read | CC skills [S1]; Hermes writes its own [S10] | missing |
| Hooks | One `before_tool` script | CC: about 30 events [S5] | behind |
| Sub-agents | Built-in, one at a time | CC: custom, 20 at once [S6] | behind |
| Resume with replay, fork | No replay, no fork | CC; Codex resume and fork [S16] | behind |
| Editor | `vscode-extension/` exists, still named "AI Workspace" 0.1.0, talks to the app, not to `rooks` | CC VS Code and JetBrains [S1]; Codex VS Code, Cursor, Windsurf [S16] | behind |
| Version | `rooks` says 0.1.0, `VERSION` says 1.0.6, AGENTS.md says 1.0.0 | | defect |

### App (from [A-A])

| Capability | Rooks today | Leaders | Mark |
| --- | --- | --- | --- |
| Approvals | Held at the tool boundary; one item in chat, Needs you, phone (same Wi-Fi) and terminal | Cowork asks per app [S20]; Dispatch pushes approvals to the phone, limited beta [S21]; CC Remote Control steers a session from the phone [S1] | ahead once the two holes above close |
| Models | 15 providers, ChatGPT (sign-in) and Claude and Copilot (the user's own CLI), router with fallback | Cowork: Anthropic's account and cloud [S19] | ahead |
| Run log, insights, undo | Solid | not in the research | ahead *(our judgement)* |
| The Room | Persistent terminals, Files, save points; 11 of 11 checks; a real desktop only on Linux with a display; on macOS and Windows a private folder and shell that "is not a locked off computer" | Cowork uses your real machine, no Linux [S20]; Manus is cloud only [S24]; Hermes Daytona and Modal environments hibernate and keep state [S10]; CC cloud sessions run in isolated VMs [S27] | ahead on Linux (private, persistent, save points); behind elsewhere and on a hosted computer |
| Memory | Chat saves to one store; the Memory page reads another and shows nothing | Claude memory viewable and editable [S22] | behind |
| Web search | Off until a key is added | On by default in the assistant apps | behind |
| Phone | Same Wi-Fi only, not in the stores, Expo Go or a dev build | Dispatch [S21]; Hermes and OpenClaw reach you through Telegram and other chat apps anywhere [S10, S23] | behind |
| Scheduled tasks | Solid, local, one at a time; nothing runs while the computer is off | Cowork runs them with your computer off [S19]; OpenClaw keeps run history with retries [S28] | behind on "laptop closed" and on retries |
| Tools per call | 70 tools, about 30 KB, every call | CC tool search [S1] | behind |
| Connectors, voice | MCP in one click; Slack etc. need developer setup; browser voice only | Claude connectors, ChatGPT voice | behind |
| Pages | 46 routes; four overlapping team pages | about 5 places | behind |
| Licence and ChatGPT sign-in | LICENSE is proprietary ("All rights reserved"), but BACKLOG 101 relies on OpenAI's flow for "this MIT open-source app"; commercial distribution needs OpenAI's approval | Codex CLI Apache-2.0, Hermes MIT, OpenCode MIT [S16, S10, S26] | blocker |
| Updates | Tauri updater compiled out until a signing key exists (`desktop/src-tauri/Cargo.toml`) | store and auto-updated apps | missing |

### Learning and automations (from [A-L])

| Capability | Rooks today | Leaders | Mark |
| --- | --- | --- | --- |
| Memory from chat, encrypted, shared with the terminal | Solid | Hermes curates its own memory on your own server [S10]; OpenClaw keeps memory on your hardware [S23] | level; ahead on encryption at rest only |
| Newer fact replaces older | Both kept, both sent | Claude, Hermes | behind |
| Skills it writes itself | No versions; announces changes that did not happen ("Saved a reusable ." with no name) | Hermes writes and improves skills, added locks [S10, S11] | behind, and breaks the "never fakes" rule |
| Skills from GitHub | Scan, sandbox trial, typed confirm, diffs, audit log | OpenClaw's marketplace had malicious skills (secondary) [S23] | ahead |
| Teach by showing | Browser recorder solid but needs the browser add-on; desktop records window titles only | No demonstration learning in ChatGPT memory or Hermes *(our judgement from the research; not stated by any source)* | ahead (browser), behind (desktop) |
| Routines from patterns | Keyword classifier makes false "I noticed" cards; habit offer needs exact repeats | Hermes cron from conversation [S10] | behind |
| Gates on learned work | Never learns from web or mail turns; routines cannot send; every schedule asks | Hermes added per-skill locks in v0.22.6 [S11]; no source says its cron jobs ask first *(our judgement)* | ahead |
| Same in the terminal | Memory only | Hermes: the CLI is the main surface [S10] | behind |

## 3. Why someone would pick Rooks

Only what Rooks has, or this plan builds, and only where it is truly different. Each row says what must be true before it can be said in public.

| Reason | Rooks | Competitor's position | Risk the gap closes |
| --- | --- | --- | --- |
| **Your models, your plans, your machine** | Any provider, local models, the user's own plans, fallback when one runs out | CC is Claude-only under "All rights reserved" [S2]; users hit weekly caps in one to two days [S9]; Codex meters jump 70% to 100% in minutes [S17]; Cowork removed "Only on your computer" on 2026-10-06 [S19] | Already matched by Hermes [S10], OpenCode [S26], Aider [S29], and Goose, which also uses existing Claude, ChatGPT and Gemini plans [S25]. Not a reason on its own. A Claude plan works only by running the user's own Claude Code CLI, which draws on the same weekly cap [S9]; Anthropic forbids any other route (BACKLOG 106). Fallback softens limits, it does not remove them. |
| **Approvals that hold, even in the background** | Enforced at the tool boundary, not the prompt; scheduled and coworker runs wait in Needs you (0004 sections 8, 9). True only after phase 1a closes the bridge-key and Room MCP holes. | Codex can send approvals to an `auto_review` subagent [S14]; CC's auto mode has a classifier approve and is the default starting mode from v2.1.283 [S3]; OpenClaw runs tools on the host unless sandboxed [S23]; Dispatch already pushes approvals to the phone [S21] | Medium: both have strong permission systems but chose automation. *(our judgement)* |
| **One assistant, one memory, everywhere** | Same facts, skills and Needs you in app, terminal, phone and chat apps; a chat fact reached the terminal [A-L]. Today the app's own Memory page shows nothing [A-A]. | CC memory is per repository [S1]; Claude memory reaches Cowork only in the cloud [S22]; Hermes v0.23.0: one gateway owns each session across CLI, TUI, Desktop, Webapp, editors, bots and cron [S11], but its memory is hard to inspect (review summary) [S13] | High: Hermes already ships this. Rooks wins only with memory you can see and correct (phase 2). |
| **Its own computer, with save points** | The Room: private, persistent, save points, Start over, files leave only after a yes. A separate computer only on Linux; on macOS and Windows a folder and shell. | Cowork uses your real screen, awake, no Linux [S20]; Manus is cloud only, billed per minute [S24]; Hermes runs commands in Docker, SSH or cloud sandboxes that keep state [S10]; CC cloud sessions are isolated VMs [S27] | High outside Linux. Say "on Linux" until a VM driver ships (out of scope, section 5). No one in the research has save points and hand-off approval as one loop *(our judgement)*. |
| **Teach once, it runs daily, it asks first** | Recorder, playbook, schedule, held send; phase 3 makes it one tested loop. Needs the browser add-on, which is set aside. | No demonstration learning in the leaders *(our judgement from the research)* | Medium: Hermes ships fast [S11]. Weak while the browser is parked: the desktop recorder sees window titles only. |
| **It never fakes a result** | Receipts, edit checks, "price unknown, so the dollar cap cannot be enforced" | Hermes issue #99752: partial work called finished [S12] | Rooks breaks it today: the skill note announces saves that did not happen [A-L]. Fix in phase 2 before saying it; keep the "test fails on old code first" rule. |
| **Plain words, coworkers by trade** | Plain-words rule on every screen; a team per trade, every job off until a yes | Hermes setup called too complex (anecdotal) [S13]; CC agent teams use about 7x tokens [S8] | Medium: Cowork is polished for consumers [S19]. Rooks breaks it today on Channels, in terminal model errors (raw URL) and on approval cards (raw ids). |

**What the pitch lacks: a price.** Hermes, OpenCode, Aider and Goose are free and open source [S10, S26, S29, S25]; CC and Codex come with plans people already pay for. Rooks is proprietary with no price and no hosted tier (`docs/hosted-free-tier.md`: "Why not build it now"). A person comparing free-and-open with closed-and-unpriced picks free. This is the owner's decision, needed in week 1 (section 6), because it also decides ChatGPT sign-in (BACKLOG 101) and store listings.

**Where Rooks will not win, and should not try.** Model quality. Community size: CC about 154.9k stars [S1], Hermes about 261.6k [S10], OpenCode about 225.3k [S26]. Release pace: one Hermes patch bundled about 776 PRs [S11]. Cloud runs at scale with the laptop closed [S19]. IDE extensions, CI and enterprise seats [S1]. The pitch is "the private assistant that does real work and asks first", not "the biggest coding agent" *(our judgement)*.

## 4. The plan

Phases are one to two weeks of agent work each; phase 1 is now two phases, because nine deliverables including MCP sign-in, rewind and hooks do not fit in two weeks. Tests first: each new test must fail on today's code. "Real run" means driven end to end (a pseudo terminal, Playwright, or the HTTP API) with the scripted model unless a key is given. An acceptance test that the scripted model can pass by being scripted to pass it does not count: the test must check what Rooks offered, stored or refused, not what the fake model chose.

### Phase 1a: terminal safety and scripts (2 weeks), in `rooks-code/rooks_code/` and `workbench/backend/app/`

| Deliverable | Acceptance (real run) | Files |
| --- | --- | --- |
| [ ] Close the approval holes: a bridge key cannot answer a `terminal:` request raised by the same session's job; the Room MCP `handoff` ignores `approve` and asks the person (elicitation, as Rooks Desk does) | A command run by the agent reads the stored key and POSTs an answer to its own pending request: refused (accepted on today's code). `handoff approve: true` from the agent still waits for a person | `rooks_link.py`, `rooks-try` MCP server, `agent.py` |
| [ ] Fix [A-T] defects: a refusal ends the turn; "a" approves one command (and one MCP server, not all); `/init` reloads; `/doctor` uses the session address; a denial exits non-zero; no raw URL in errors; one meaning of "plan"; one version number | The audit's scripts (s1 to s9, today only in a scratch folder) are ported into `rooks-code/tests/` as pass/fail tests, one per defect, each failing on today's code | `agent.py`, `tui.py`, `cli.py`, `words.py`, `tests/` |
| [ ] Permission rules by tool and command pattern, per project and user; a cloned repo's project rules apply only after the person trusts the folder | Allow `pytest *`, deny `rm *`: pytest runs unasked, `rm` refused in every mode, `echo` still asks; `pytest; rm -rf x` is not matched by `pytest *`; an untrusted project's allow rule is ignored and says so | `agent.py`, `config.py` |
| [ ] Headless: `-p`, piped prompt, JSON and stream-json, exit codes, `sdk.py` | A script pipes a task, parses JSON, gets non-zero on a denial; `-p` never waits for input; every stream-json line validates against a schema file in the repo; a test drives a task through `sdk.py` in-process | `cli.py`, new `sdk.py` |
| [ ] Prompt caching; cached tokens in `/cost` and in the dollar cap | The fake model returns Anthropic `cache_read_input_tokens` and OpenAI `cached_tokens`; `/cost` and the cap charge the cached price. Live: a second Anthropic call reports cache reads above zero | `providers.py`, `agent.py` |
| [ ] Local skills (`.rooks/skills/*/SKILL.md`) and custom commands, app off; also read `.claude/skills` and `.claude/commands`, so a CC user brings theirs | `/skills` lists a project skill and its body reaches the model only when loaded; a `.claude/commands/x.md` runs as `/x` | `learning.py`, `extras.py`, `tui.py` |
| [ ] Live pass with one real key (moved from phase 4) | The ported tests plus caching and headless, run once against Anthropic or OpenAI; the report says which | none |

### Phase 1b: terminal depth (2 weeks)

| Deliverable | Acceptance (real run) | Files |
| --- | --- | --- |
| [ ] Rewind code, conversation or both (`/rewind`, Esc Esc), including files changed by commands | Rewind three prompts to the first: files and transcript match; survives `-c`; a file changed only by a shell command is restored too (CC does not track those [S4]) | `undo.py`, `tui.py`, `tools.py` |
| [ ] MCP over HTTP and SSE with sign-in, resources, prompts | The reference "everything" server over streamable HTTP behind a fake sign-in server: tool, resource and prompt all work; the token is kept out of the config file | `mcp.py`, `config.py` |
| [ ] Hooks: session start, prompt submit, before and after tool, stop, notification | Each fires once in a scripted session; non-zero `before_tool` blocks; a hook that hangs is stopped after its time limit; project hooks need the folder trusted | `agent.py`, `config.py` |
| [ ] Resume with replay; fork | `/resume` shows earlier turns; fork writes a new session and the old one is unchanged | `tui.py`, `cli.py` |
| [ ] Parity pass: skills and permission rules reachable in the app's Settings | The same rule set in the app shows in `rooks` and the reverse | `rooks_link.py`, Settings page |

Unlocks: the terminal stands next to CC and Codex without a footnote, and scripts and CI can drive it.

### Phase 2: app must-haves (2 weeks), in `workbench/`

| Deliverable | Acceptance (real run) | Files |
| --- | --- | --- |
| [ ] One memory store and page; a newer fact replaces the older; existing facts from both stores migrated | `remember` in chat shows on Memory and in `rooks /memory`; forget in one removes both and from the next prompt; "moved to Melbourne" replaces Sydney in the prompt; a copy of an old database upgrades with every fact kept (`SCHEMA_VERSION` bumped) | `adapt/knowledge.py`, `knowledge/`, `teammates/memory.py`, `memory/Knowledge.tsx`, `db.py` |
| [ ] Web search with no key, in the desktop app without Docker (`searxng/` needs Docker) | Fresh install, no keys: `web_search` is in the offered tools; live: the default backend returns results for three fixed queries | `search.py`, `assistant.py` |
| [ ] Tools on demand | A plain turn offers at most 20 tools; on a labelled set of 30 requests (including "tell Bob I'm running late", no mail word) the needed tool is offered in at least 29. The test reads the offered list, not the fake model's call | `assistant.py`, `adapters.py` |
| [ ] Approvals away from home, first step: push to the phone and answer a held item from Telegram, the channel that already exists | A held send is answered "yes" from a Telegram test chat and runs; a "yes" from a sender not paired is refused | `teammates/channels.py`, `needs_you.py`, `push.py` |
| [ ] Needs you from the terminal: `/needs` exists (`workroom.py:618`) but has no `/v1/rooks` route (BACKLOG) | With only the Terminal access token, `/needs approve` runs a held Room hand-off; with the bridge key it is refused | `rooks_link.py`, `workroom.py` |
| [ ] [A-A] defects and the honesty defects: Jobs count, raw Markdown in Inbox, phone header, old name ("hey workspace", `aiworkspace://`, `vscode-extension`), Channels wording, `/files` speed, restart note in the thread, raw ids on approval cards, the empty "Saved a reusable ." note | One Playwright assertion per defect at 1440 and 390 wide, each failing on today's code, plus 0 console errors across the walk | pages named in [A-A], `chat/turns.ts`, `learn.py` |

Unlocks: the memory and "never fakes" promises are kept, and approvals reach you away from home.

### Phase 3: the learning loop (1 to 2 weeks)

| Deliverable | Acceptance (real run) | Files |
| --- | --- | --- |
| [ ] Teach once, runs daily, asks first, as one loop | Record a task, save the playbook, schedule it; the run holds at "send"; a yes in Needs you (or Telegram) sends it; the result is in the inbox | `adapt/playbooks.py`, `scheduler.py`, `pages/Teach.tsx` |
| [ ] Versioned SKILL.md skills: history, rollback, success counts, refine after failure, owner lock | Repeat a turn: no note; a failure makes a new version; rollback restores; a locked skill is never rewritten | `learn.py`, `skill_store.py`, `db.py`, `SkillsTab.tsx` |
| [ ] Patterns without false matches; reworded requests count | On a labelled set of 40 messages, no offer on the 20 that are not habits ("Brisbane, basic question" among them); a reworded third request gets the offer | `adapt/jobs.py`, `automations.py` |
| [ ] Terminal parity: `save_skill`, `/routines`, `/automate`, `/teach` | Each works from `rooks` and shows in the app | `learning.py`, `tui.py`, `rooks_link.py` |
| [ ] Schedules in parallel with time limits, run history, retries (0004 section 7); a run missed while the computer was off runs once on wake and says so; tool list per coworker | A slow job does not delay a due one; a run due during a simulated sleep runs once after it with "ran late"; a coworker without mail tools cannot send | `scheduler.py`, `company.py` |

Unlocks: the loop no competitor in the research offers *(our judgement)*.

### Phase 4: polish, install, release (2 to 3 weeks)

- [ ] **Fewer pages**: one Coworkers page (from four), one page for notes, documents and pages. Test: routes in `registry.ts` go from 46 to at most 30; every removed route redirects; no page is reachable only by typing its address.
- [ ] **Signed installers** (macOS, Windows, Linux) from the Tauri app, with the updater on. Test: a fresh VM per system installs, signs in, chats and approves once; an install of the previous release updates and keeps its data; uninstall leaves no files or services.
- [ ] **Five non-technical people** install and finish one task alone, watched, not helped. Each place they stop is a defect.
- [ ] **Phone anywhere**: an end-to-end encrypted relay (the relay sees only ciphertext, tested) and store builds; voice out of the box.
- [ ] **Windows decision applied**: either the restricted-token sandbox and ConPTY terminals ship, or every Windows screen and the release notes say "commands run as you" and the Room is a folder.
- [ ] **Terminal "shoulds"**: parallel custom sub-agents, network-off sandbox, reasoning shown, transcript expand, image paste, git commit flow.
- [ ] **Clean gate**: the four full-run test failures fixed, `bwrap` in CI, `./scripts/test-all.sh` ends "All passed."
- [ ] **Proof run with real keys**: 20 fixed coding tasks run by `rooks` and by CC on the same Claude model, and by `rooks` on one local model; pass rate, tokens and cost published as measured. Plus ChatGPT sign-in live (BACKLOG 101) if the licence allows it.
- [ ] **Release** with notes and docs, under the one version number chosen in week 1.

## 5. What stays out, and the risks

**Out for now:** the browser (next project), IDE extensions (an old "AI Workspace" VS Code extension exists in `vscode-extension/`; rename or hide it, do not grow it), cloud computers we host (the phase 4 relay is the one hosted piece and carries only ciphertext), accounts for several people (0003 W2), macOS and Windows virtual machines for the Room, our own models.

| Risk | Mitigation |
| --- | --- |
| No real model keys, so quality, cost and speed are unmeasured | One live pass at the end of phase 1a and each later phase; the phase 4 proof run. Until then reports say "scripted model". |
| Licence: LICENSE is proprietary, but ChatGPT sign-in was built on OpenAI's open-source flow (BACKLOG 101) | Owner decides in week 1. Default if unanswered: hide ChatGPT sign-in in release builds and keep API keys. |
| The user's own plans are governed by Anthropic's and OpenAI's terms and limits (BACKLOG 106, [S9], [S17]) | Only the official CLIs and official sign-in; say on screen that the plan's own limits apply. |
| Signing certificates and store accounts take weeks and money | Order them on day 1; ship unsigned previews with plain warnings meanwhile. |
| Windows: no command sandbox, no Room terminals (BACKLOG); most non-technical people use Windows or macOS, where the Room is a folder | Decision in week 1 (phase 4 item); test on a Windows VM before release; never call the Room a separate computer there. |
| No price | Owner decides in week 1; the plan does not assume revenue. |
| The owner's time | One list of open decisions per phase, each with a default that applies if unanswered. |
| Estimates are agent-time guesses; phase 1 was under-sized once already | Re-estimate after phase 1a from measured days. |
| Competitors move fast [S11] | Compete on the loop, privacy and approvals, not feature count. |

## 6. The first two weeks, in order

1. **Day 1.** Run every suite and record the numbers. Fix or quarantine the four full-run failures; add `bwrap` to the test environment. Order signing certificates and store accounts. Put five decisions to the owner, each with a default: licence (default: proprietary, ChatGPT sign-in hidden), price (default: none until 1.0), one version number (default: `VERSION`'s 1.0.6, applied to `rooks` and AGENTS.md), Windows in or out of the 1.0 promise (default: in, with honest wording), default web search backend (default: one that needs no Docker).
2. **Days 1 to 2.** The approval holes (bridge key, Room MCP `approve`), then the refusal and the "a" approval. One failing test each, then the fix: they are safety bugs and the pitch rests on them.
3. **Days 3 to 4.** Port the audit scripts into `rooks-code/tests/`; the remaining terminal defects.
4. **Days 5 to 6.** Permission rules with folder trust, and an approval choice "always allow this command here".
5. **Days 7 to 8.** Headless `-p`, JSON, stream-json with its schema, exit codes, `sdk.py`.
6. **Day 9.** Prompt caching.
7. **Day 10.** Local skills and commands, including `.claude/skills` and `.claude/commands`.
8. **Days 11 to 12.** Slack for what overran; the live-key pass if a key exists.
9. **Day 13.** Docs and CHANGELOG.
10. **Day 14.** Full gate ("All passed."), the ported audit tests as proof, a PR to `main`. Rewind, MCP over HTTP, hooks and resume follow in weeks 3 and 4 (phase 1b).

## Sources

[S1] code.claude.com/docs/en/overview; github.com/anthropics/claude-code · [S2] github.com/anthropics/claude-code LICENSE.md · [S3] code.claude.com/docs/en/permission-modes.md · [S4] …/checkpointing.md · [S5] …/hooks.md · [S6] …/sub-agents.md · [S7] …/sandboxing.md · [S8] …/costs.md · [S9] github.com/anthropics/claude-code/issues/9424 · [S10] github.com/NousResearch/hermes-agent · [S11] …/hermes-agent/releases · [S12] …/hermes-agent/issues/99752 · [S13] search summaries of eesel.ai and Trustpilot reviews (not read directly) · [S14] github.com/openai/codex codex-rs/protocol/src/config_types.rs · [S15] …/protocol.rs · [S16] github.com/openai/codex, codex-rs/cli/src/main.rs · [S17] github.com/openai/codex/issues/30918 · [S18] codex-rs/cli/src/mcp_cmd.rs · [S19] support.claude.com/en/articles/15520349 · [S20] support.claude.com/en/articles/14128542 · [S21] support.claude.com/en/articles/13947068 · [S22] support.claude.com/en/articles/11817273 · [S23] github.com/openclaw/openclaw docs/gateway/security; conscia.com (secondary) · [S24] layer3labs.io/guides/manus-ai-pricing (secondary) · [S25] github.com/block/goose · [S26] github.com/sst/opencode; github.com/google-gemini/gemini-cli · [S27] code.claude.com/docs/en/claude-code-on-the-web.md · [S28] github.com/openclaw/openclaw docs/automation/cron-jobs.md · [S29] github.com/Aider-AI/aider

## What the critic changed

- **Claims that competitors already match.** "Choice of model" is no longer "ahead of Codex": the Codex CLI takes API keys and other providers [S16], and Goose already uses existing Claude, ChatGPT and Gemini plans [S25]. The spending cap is "partly matched" (CC per-org limits [S8], Hermes spend limits [S11]). The sandbox is behind Hermes's backends too [S10]. Hermes's "one gateway per session" was misread: v0.23.0 owns each session across every surface [S11]. Phone approvals are matched by Dispatch [S21]. Memory privacy is "encryption at rest only", since Hermes and OpenClaw also keep memory on your machine. Rows citing our own audit as if it were research are now marked *(our judgement)*.
- **Contradictions with the repository.** The "no agent approves its own request" promise is broken today by two BACKLOG items; they are now the first work. The Room is a separate computer only on Linux. "It never fakes" is broken by the skill note. Versions disagree (0.1.0, 1.0.6, 1.0.0). LICENSE is proprietary while ChatGPT sign-in relies on an open-source flow. `/needs` already exists in the terminal, so that deliverable now names the real gap (no `/v1/rooks` route). A VS Code extension already exists under the old name. `rooks` already reads CLAUDE.md.
- **Forgotten must-haves.** Folder trust for project rules and hooks (a cloned repo should not grant itself permissions), reading `.claude/skills` and `.claude/commands`, memory migration, missed runs after sleep, retries, the updater, upgrade and uninstall tests, testing with five real non-technical people, a published proof run, and a price.
- **Phase size and order.** Phase 1 is split into 1a and 1b. The phone relay and store builds move to phase 4; phase 2 reaches you away from home through the existing Telegram channel instead. The licence decision moves from release to day 1, and the first live-key pass from phase 4 to phase 1a. Phase 3 no longer depends on the phone relay.
- **Acceptance tests that proved nothing.** The audit scripts are in a scratch folder, so "rerun s3 and s9" becomes ported tests. Tool selection is checked on what was offered, not on what the scripted model called. Caching needs cached-token counts and a live check, not just marks in the request. "No defect" in the page walk is now one assertion per defect. Single examples became labelled sets. "No duplicate idea in `registry.ts`" became a route count with redirects.
