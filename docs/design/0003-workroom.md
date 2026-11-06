# 0003: The Workroom. Rooks works in the open.

Status: in progress on branch `feat/workroom`. Owner decision 2026-11-06: the owner deferred the four questions below to the implementer; the answers here are the implementer's recommendations, taken as decisions for this branch (numbered W1 to W4 so they do not collide with D1 to D7 in the earlier records) and reversible by the owner.

## 1. What this is

Rooks is one assistant you run yourself. It already reads your mail and calendar, keeps tasks, notes and files, runs jobs in the background, drives a browser, uses the computer in front of you, learns skills, keeps memory, checks its own claims against the database and can undo what it did. All of that is real and tested. What is missing is a single idea that makes those parts one product, and a user interface that expresses that idea instead of listing 48 pages behind a "More" button.

The idea, in one sentence:

> **Rooks has its own computer inside your app. You can watch it work, step in at any moment, hand it back, and undo anything it did.**

Three promises hang off that sentence, and every screen serves one of them:

| Promise | Meaning | What already exists | What this branch adds |
| --- | --- | --- | --- |
| **Hands** | Rooks works somewhere you can see: its own computer (the Room), a browser, a terminal, or with your permission your desktop. | Rooks Desk, Rooks Browser, Rooks Code, the app terminal, `rooks-try` (the Room's drivers; the app side was deleted on 5 Nov). | The Room comes back, honestly. A Stage pane shows whatever Rooks is using right now, with Watch, Step in, Hand back. |
| **Memory** | It keeps what it learns: facts, skills, routines, and the state of its own computer. | Memory and skills, teach by demonstration, automations, project memory, a rolling summary of long chats. | Checkpoints of the Room, long chats that compress instead of failing, a turn that survives a restart or says plainly that it did not. |
| **Proof** | Every action has a receipt. Every claim can be checked. Anything that can be undone is one tap away. | Receipts in the run log, checked answers, History with undo. | Receipts and undo inline in the conversation, a "Needs you" inbox that is always visible, the same approval card everywhere. |

Why this is the wow and not a mascot: the four tracked competitors each own one of these promises in part (Manus: a cloud computer you can take over; Hermes: memory that improves; Claude Code: hands in a terminal; OpenClaw: reach on every channel). None of them, per the competitive notes in `docs/competitive` and `ai-workspace-audit-report.md`, ships a **local, private, persistent** computer for the assistant **inside the assistant's own app**, with take over and hand back, checkpoints, receipts and undo as one loop. That combination is the claim. Per the standing rule it is **not** to be marketed as "better than X" until a head to head test is recorded in `docs/evidence`; it may be described as what Rooks does.

The inspiration the owner cited (a whole macOS running inside a terminal on Apple silicon, [govijr/terminal-mac](https://github.com/govijr/terminal-mac), and the `trycua/lume` family of agent VMs) shows the ceiling: on a Mac the Room can later be a real macOS or Linux virtual machine through Apple's Virtualization framework. This branch does not build that driver (it cannot be tested here). It builds the honest foundation: a real nested desktop on Linux, a real shell everywhere, the Stage, and the driver interface the VM drivers plug into.

## 2. The four decisions

### W1. One UI: the React app, shipped inside the Tauri shell as the desktop app

The newest commit on `main` replaced the desktop web view with `desktop/rooks-native`, an iced 0.13 window (software renderer, 2,654 lines of Rust) that signs in to the local service. The uploaded `Rooks_0.4.0_aarch64.dmg` is that window, built from `feat/native-ask`. It is the fourth separate UI for one agent (web app, Tauri shell, iced window, terminal TUI).

Decision: the React frontend is **the** UI. The desktop app is that UI in the Tauri shell (`desktop/src-tauri`; `docs/decisions/0001-app-window-is-tauri.md` already records that the app window is Tauri). The iced window stays in the tree as the optional floating Ask palette only; it is not the app and gets no new screens. Reason: a striking, animated, accessible UI is built once in React in days; iced has no comparable typography, layout or motion toolchain, and every screen built there drifts from the web and the terminal, which breaks the north star of three surfaces behaving identically.

### W2. First customer: one person, work and personal, in one private workspace

The backend is single user (one password, one memory, one key store). Companies with several people need accounts, per person memory and permissions; that is a separate phase with its own design record. This branch keeps the single owner model and makes the separation of work and personal visible through Projects, Teammates and the Stage, not through accounts.

### W3. Soul means a capability, not a character

The owner defined soul as "something new, game changing, a wow factor". Decision: the soul is the loop in section 1. The assistant keeps a name the owner can set (`assistant_name`, default "Atlas", in Assistant settings) and a presence indicator (`AssistantFace.tsx` moods already exist), but no mascot and no jokes. Personality is expressed as restraint: short sentences, plain words, receipts, never a claim without a check.

### W4. First slice: the Workroom shell and the Room, with the reliability people feel

Scope of this branch, in order of priority:

1. Design system v2 and the Workroom shell (rail, presence strip, thread, stage).
2. Chat as a living record: persistent step timeline, inline receipts, inline undo, one approval card, one reveal.
3. The Room restored honestly, with the Stage: watch, step in, hand back, save a point, start over, hand off a file.
4. Needs you: one inbox for approvals from chat, jobs, the Room, the browser and the desk.
5. Reliability that shows: a long chat compresses instead of dying on a context error; a turn interrupted by a restart is reported honestly in the thread and can be resumed; approvals are never duplicated.
6. Debt that blocks the above: the egress audit failure in `local_agents.py` (R8), the dead `navOrder.ts`, the three hand written page registrations, the theme system that never reaches the signed in shell, the stale committed `dist`.

Out of scope for this branch, recorded so nothing is dropped silently: multi user accounts; the macOS and Windows VM drivers for the Room; the iced window; a redesign of every one of the 48 pages (pages outside the shell get the new tokens and primitives but keep their layout); fine tuning, media and meetings (phase 4); embeddings for memory (recall is keyword only today, `knowledge/index.py` has the plug point).

## 3. The Workroom: layout

The signed in app is one surface with four regions. Nothing else is a top level concept.

```
┌──────┬──────────────────────────────────────┬──────────────────────┐
│ Rail │ Presence strip                       │ Stage (collapsible)  │
│      ├──────────────────────────────────────┤                      │
│ Chat │ Thread                               │ The Room / browser / │
│ Room │   turn, steps, receipts, cards,      │ terminal / desktop   │
│ Jobs │   approvals, undo                    │ [Watch][Step in]     │
│ Day  │                                      │ [Hand back]          │
│ Mem  │                                      │                      │
│ Lib  ├──────────────────────────────────────┤                      │
│ ⚙    │ Composer                             │                      │
└──────┴──────────────────────────────────────┴──────────────────────┘
```

* **Rail** (64 px, icon above an 11 px label, always visible, 44 px hit targets): Chat, Room, Jobs, Day (Mail, Calendar, Tasks), Memory (facts, skills, what it noticed), Library (Files, Notes, Documents, Sites, Projects), Settings. Day, Memory and Library open a small flyout listing their pages. Every other page is reachable through ⌘K and a "More" sheet that has a focus trap and closes on Escape. One **page registry** (`src/pages/registry.ts`) is the single source for routes, rail, flyouts, More sheet and ⌘K; the three hand written lists in `App.tsx` go away. Recent chats and projects (today's `AgentsSidebar`) become a collapsible **Chats** column inside the Chat page, open by default above 1280 px.
* **Presence strip** (one line, 44 px, above the thread, mono text): the assistant's name and mood face, what it is doing now ("Reading 3 emails", "Filling the timesheet in the Room"), what it is watching, and a **Needs you** pill with a count that opens the inbox. It is the living part of the app and is never empty (idle reads "Quiet. Watching mail and calendar."). Data: `GET /api/presence` (section 8).
* **Thread**: the conversation. Each turn keeps its own step timeline (rebuilt from the server on reload, never wiped), each step shows its receipt when the server sends one (`tool_result.receipt{verified, evidence}`), result cards carry **Undo** when History says the action is reversible, approvals are one card with one copy everywhere ("Needs your OK"), and the final reply is revealed once, not twice. The current project and the model are visible in the thread header as chips, not buried in the ⋯ menu.
* **Stage** (the right pane, built on the existing `Beside` split): the live view of whatever Rooks is using now. For the Room it shows the real screen when the driver has one, a real command view when it does not, with the driver named in plain words ("A private desktop on this computer", "A private folder and shell"). Controls: Watch (default), Step in (your mouse and keyboard go to the Room; the edge glows), Hand back, Save a point, Start over, Hand off a file (asks first). Closed by default when nothing is live; opens itself when a job starts on a surface.
* **Composer**: unchanged in function; dictation orb, attachments, model and effort become proper menus inside it; the working border (Tracer) stays.

Phones and narrow windows (below 900 px): the rail becomes a bottom bar (Chat, Room, Jobs, Needs you, More); the Stage stacks under the thread.

## 4. Honesty rules for the Room

These are the rules the deleted version broke and the reason it was removed ("the practice computer pretending to be a desktop").

1. A screen is shown only when a real display exists (nested X11 on Linux today; VM drivers later). The PIL `display` driver that paints a picture of a terminal is never chosen automatically by the app; it is renamed in the UI to "a drawing of a terminal", keeps no pointer, and is only reachable with an explicit `ROOKS_TRY_DRIVER=display` for tests.
2. The shell driver is a real shell in a private folder running as the user; the UI says so on the pane ("Commands run as you, in a folder of its own. It is not a locked off computer."). On Linux it is wrapped in `unshare -Urm` (private mount namespace) and `-n` when offline is requested, and status reports `isolation` as `none`, `namespace` or `vm`.
3. Status carries `{screen: bool, pointer: bool, isolation: str, label: str}`; the UI shows an image only when `screen` is true and input controls only when `pointer` is true.
4. Every Room action goes through the audit log; "Save a point" and "Start over" are verified against the store before they are reported done.
5. Hand off copies a file out of the Room only after a yes in the approval card; the chat tool cannot pre approve it.
6. The chat tool `use_room` (renamed from `use_try_room`) is offered only when a real driver is available; the assistant never says the Room is on without the `up` call returning running.

## 5. Copy rules (unchanged from AGENTS.md, restated for the new screens)

Plain words for people who do not program. Never on a normal screen: URLs, ids, "cli://", "OAuth", "MCP", "UTC", "Workbench", "driver", "namespace", stack traces. Names used in the UI: **Rooks** (the product; `product.ts` PRODUCT becomes "Rooks"), the assistant's chosen name, **Room** (its computer), **Stage** (the live view), **Jobs**, **Needs you**, **Day**, **Memory**, **Library**. "Needs your OK" is the one approval phrase. Buttons are verbs: Approve, Deny, Step in, Hand back, Save a point, Start over, Undo.

## 6. Design system v2: "Paper and Ink, with a saffron signal"

Decided by the implementer after the design panel could not run (usage limit). It evolves what the product already owns (the Sunshine theme and the motion system) instead of importing a generic SaaS look. Two first class themes, one accent that always means "live".

### Themes

Theme axis is `data-mode="light|dark"` on `<html>` (already set by `appearance.tsx`). The old `data-theme` ids keep working as variants layered on top, but the signed in shell must read **only** tokens: no hex in `styles.css` `.shell-agents` or in any component; the `.shell-agents` palette block is deleted.

| Token | Studio (light) | Lamp (dark) |
| --- | --- | --- |
| `--color-bg` | `#FAF8F3` | `#141210` |
| `--color-surface` | `#FFFFFF` | `#1C1915` |
| `--color-surface-raised` | `#FFFFFF` | `#221E19` |
| `--color-surface-sunken` | `#F3F0E8` | `#0F0E0C` |
| `--color-border` | `#E6E1D6` | `#2E2A24` |
| `--color-border-strong` | `#D2CBBB` | `#3D382F` |
| `--color-ink` | `#1B1A17` | `#F2EDE3` |
| `--color-ink-muted` | `#5F5A50` (6.6:1 on bg) | `#B0A89A` (9.1:1 on bg) |
| `--color-ink-faint` | `#948E82` (3.2:1, non text only) | `#756E62` (3.3:1, non text only) |
| `--color-accent` | `#F2B705` (solid fills, on_accent ink) | `#F2B705` |
| `--color-on-accent` | `#1B1A17` (12.3:1) | `#141210` (12.6:1) |
| `--color-accent-text` | `#7A4F00` (7.2:1 on bg) | `#F6C84C` (10.5:1 on bg) |
| `--color-accent-soft` | `#FFF3CC` | `#2E2410` |
| `--color-live` | `#F2B705` | `#F2B705` |
| `--color-success` / `-text` | `#1E7F4F` / `#14532D` | `#4ADE80` / `#86EFAC` |
| `--color-warning` / `-text` | `#B45309` / `#7C3A05` | `#FBBF24` / `#FDE68A` |
| `--color-danger` / `-text` | `#C0392B` / `#7F1D1D` | `#F87171` / `#FCA5A5` |
| `--color-code-bg` | `#F3F0E8` | `#0F0E0C` |
| `--color-scrim` | `rgba(27,26,23,.45)` | `rgba(0,0,0,.6)` |

The old short aliases (`--bg`, `--panel`, `--text`, `--muted`, `--accent`, `--ok`, `--warn`, `--danger`) stay as aliases of the tokens above so untouched pages keep working. Contrast figures are computed for the stated pairs; the engineer checks them again with the existing `tests/appearance.test.mjs` pattern.

### Type

Hanken Grotesk for UI at 14 px base (`--text-md` becomes 14 px; `appearance.tsx` TEXT_TOKENS already treat 14 as base, which fixes the size bug the readers found). Thread body 15 px / 1.6. Steps, receipts, presence line and terminal in JetBrains Mono 12.5 px. Bodoni Moda only for the greeting, page titles and the empty state line (28 to 32 px, weight 500, tracking -0.01em). Rail labels 11 px, weight 600, tracking 0.02em. No other sizes outside the scale.

### Shape and depth

Radius 8 / 12 / 16 (cards 12, composer and stage frame 16, chips full). Hairline 1 px borders in `--color-border`; `--shadow-2` only on raised surfaces (menus, sheets, stage frame); nothing else floats. Spacing on the 4 px scale only. Breakpoints are tokens: `--bp-narrow: 900px`, `--bp-wide: 1280px`.

### Signature moments (reuse, do not reinvent)

Thinking shimmer, word stream, timeline drawing, approval spring, done tick, working border and edge glow all exist in `motion/signature.css` and `motion/index.tsx`. New: the **Stage edge glow** when you step in (the frame's border animates in `--color-live`, 600 ms ease, held while input is captured). Reduced motion is honoured by one rule in `motion/tokens.css`; the nine duplicate `prefers-reduced-motion` blocks are removed.

### Primitives (`src/ui/`)

One stylesheet `src/ui/ui.css` and one module `src/ui/index.tsx`: `Button` (primary saffron with ink text, secondary outline, ghost, danger; sizes sm 28 px, md 36 px), `IconButton` (36 px, always has an aria label), `Card`, `Input`, `Select` (styled native select), `Tabs`, `Badge`, `Chip`, `Sheet` (side sheet with focus trap and Escape), `Toast` (one stack mounted once in the shell), `Kbd`, `EmptyState` (Bodoni line, one sentence, one action), `Stat`, `Timeline` (step rows with the drawing line), `Receipt` (verified / partly / not verified marks with evidence on hover and focus), `ApprovalCard` (the one approval card), `StageFrame` (16 px frame, live edge, controls bar), `Presence` (face, name, status line, Needs you pill).

### Accessibility

One `main` landmark (the nested `role=main` in `Assistant.tsx` goes), a skip link, visible focus rings that no component cancels (`:focus { outline: none }` is removed), hover only actions get a keyboard and touch path, every live region declared once, the More sheet and flyouts trap focus and close on Escape.

## 7. Verification

* Backend: `cd workbench/backend && env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u NVIDIA_API_KEY ~/.venvs/aiw/bin/python -m pytest -q -p no:cacheprovider -W ignore --ignore=bench`. Baseline on `main`: 724 passed, 5 failed (`test_connect_mail_calendar::test_assistant_reads_and_drafts_with_microsoft`, `test_desk::test_desk_emails_a_render_with_attachments`, `test_egress::test_no_unaudited_network_library_in_the_app`, `test_health::test_status_page_reports_every_part_and_the_worst_wins`, `test_lock_reset::test_forgotten_pin_can_be_replaced`); the egress one is fixed on this branch, the other four are environment or pre existing and are listed in BACKLOG.
* Try Room: `cd rooks-try && ~/.venvs/aiw/bin/python -m pytest -q tests` (14 pass with `mss` and `python-xlib` installed).
* Rooks Code: 161 pass, 1 environment failure (no `bwrap` in the container).
* Frontend: `cd workbench/frontend && npx tsc --noEmit -p . && npm run build && npm test`.
* Screens: a Playwright harness runs the real backend with a scripted model and captures the shell, chat, Room stage, Jobs and Needs you in both themes into `screenshots/workroom/`.
* Honesty: a backend test proves the Room reports `screen: false` for the shell driver and never auto picks the drawing driver; the frontend test `plain-screens.test.mjs` is rewritten from "there is no virtual computer page" to "the Room never shows a fake screen".

## 8. API contracts shared by the two build lanes

All routes require the signed in user (`require_user`) and the `X-Workbench` header on writes, like every other `/api` route (`tests/test_route_auth.py` enforces it).

### `GET /api/presence`

```json
{
  "name": "Atlas",
  "mood": "idle | thinking | working | needs | done",
  "doing": "Reading 3 emails",
  "where": "room | browser | desktop | terminal | chat | null",
  "watching": ["mail", "calendar", "jobs"],
  "needs_you": 2,
  "running": {"turns": 1, "jobs": 2},
  "updated_at": "2026-11-06T05:40:00+00:00"
}
```

`doing` is a plain sentence derived from the newest running turn's latest tool call (`plainStep` vocabulary lives in the frontend; the backend sends the tool name and args summary as `doing_tool` and `doing_args` too), or the newest running job's title, or `null`. `needs_you` counts pending held tool calls across all conversations plus pending desk and browser job approvals.

### `GET /api/needs-you`

A list, newest first, each `{id, kind: "approval | job | room | browser | desktop", title, detail, since, conversation_id, job_id, actions: ["approve", "deny"]}`; `POST /api/needs-you/{id}/{approve|deny}` routes to the right system (`actions.decide`, `jobs`, desk or browser proxy).

### `/api/room` (the Room; replaces the removed `/api/try`)

`GET status` returns `{available, running, screen, pointer, isolation, label, note, driver (advanced only), last_checkpoint, checkpoints: [...]}`. `POST up|down|checkpoint{label}|reset{name}|click{x,y,button,count}|drag|scroll|type{text}|key{keys}|run{command,timeout}|handoff{src,dest,request_id}`; `GET screenshot` (PNG, no store, served from the last frame without waiting for a running command). Every blocking call runs in a thread (`asyncio.to_thread`). `handoff` without an approved `request_id` creates a held action and returns `{held: true, request_id}`; approving it in Needs you performs the copy.

### Chat events

`watch` events for the Room carry `{surface: "room", job_id: "<room job id>", goal}`; the frontend maps surface `room` to `/api/room/screenshot`. `tool_result` keeps `receipt{verified, evidence}` and the frontend renders it. A new `resumed` event `{reason: "restart", at}` is emitted at the top of a turn that continues after a restart, and a new `compacted` event `{dropped_rows, summary_words}` when the window was compacted to fit.

## 9. Work packages and file ownership

Two lanes run in parallel; within a lane, packages run in order. A package never edits files owned by the other lane. Shared facts come from this document only.

**Lane F (frontend, `workbench/frontend/**` only):**
F1 design system v2, primitives, page registry and the Workroom shell (rail, presence strip, stage pane host, More sheet, ⌘K from the registry, mobile bar). F2 chat as a living record. F3 the Room stage, Jobs and Needs you, History inline undo. F4 sweep: hardcoded hex out of feature CSS, tests rewritten, `tsc`, build, `npm test`.

**Lane B (backend, `workbench/backend/**`, `rooks-try/**`, `rooks-code/rooks_code/config.py`, `install.sh`, `desktop/launcher/install_helper.py`, `AGENTS.md`, `BACKLOG.md`, `CHANGELOG.md`):**
B1 presence and needs-you APIs plus the `local_agents.py` egress fix. B2 the Room restored and made honest (package fixes, `/api/room`, `use_room`, watch events, surfaces, hooks, tests). B3 reliability: overflow shrink and retry with a `prompt too long` classification, tool aware compaction with the `compacted` event, restart handling with the `resumed` event and `goals.resume_on_restart` consumer, held approval dedupe.

The orchestrator rebuilds `workbench/frontend/dist`, runs every suite, captures screenshots, and commits.
