# 0006: The Room as a small computer. Desk, windows and a dock, with a terminal that stays.

Status: built and merged to `main` (pull request #26, 2026-11-08); written as a design record on 2026-11-07. Builds on 0003 (the Workroom; sections 4, 5 and 6 bind this record). Three designs were drawn and two judges scored them; the record below is built from the winner with the grafts the judges named and without the ideas they rejected. Lanes: backend, frontend, terminal (section 8). Tests first (section 9).

**How the winner was chosen.** The judges split (one scored The Bench 28 to the Desk's 26; the other scored the Desk 25 to The Bench's 23; the totals tie at 25.5 each). The owner's own words decide the tie: "i want better new ons type ui", an OS-type UI, a computer you use, not a status card. The Bench refuses that in so many words ("No dock, no desktop metaphor"); the Desk gives it within the honesty rules (the app's own chrome around the Room is allowed as long as nothing pretends to be the Room's screen). So the Desk is the base. From The Bench and Looking in it takes, by the judges' graft lists: the phone command row that types into the same shell through an HTTP route; the skip link, Escape to the shell and the aria-live chrome line; the Start over confirm that names how many terminals close and the focus returns; Save a point off the event loop with its waiting words; the Stop words "The Room is off. Everything in it is kept." and Files working while the Room is off; elapsed time and "Done (code 0)" on the Rooks tab plus a coarse run log row for the person's own use of a terminal; `can: {terminal, files}` in status; `$HOME/.cargo/bin` on the PATH; the restart note printed into the ended terminal; the "Take this one" step so the assistant never reads the person's keystrokes as its own output. Rejected, from both judges: Escape or number keys stolen from the shell; `--color-primary` fills on the dock; a run log fed by the shell's history file; raising the chat tool's cap to 600 s; moving the honest line under Advanced on phones; the "Since you were here" scan, the activity feed and a file preview (follow-ups, section 10); and the Desk's own two faults, answered here: the dock carries no verbs (the Room bar is the one toolbar with verbs; the dock only opens and closes windows), and nothing that decides what exists comes from the browser (terminal list, names, order and state come from the server; the browser remembers only which windows are open, a convenience).

## 1. What this is

The Room is Rooks's own computer inside the app: a private place where the assistant and the person install and try things. Today the Room page is a status card with a one-line command box: each command runs in a fresh non-login `sh -c` with the host's PATH (a tool an installer put in `~/.local/bin` or a line it added to `~/.bashrc` is invisible to the next command; `cd`, exports and virtualenvs vanish), a command is killed at 120 s (a real install does not fit), and the command box's lines are React state that is gone when the person opens chat and comes back. The files in `~/.ai-workspace/try-room/home` were never wiped; the person experiences a reset anyway. This record turns the Room page into a small computer: a desk with a few plain windows (Terminal, Files, Saved points, and Screen only when a real screen exists) and a dock that opens and closes them. The terminal is a real login shell started inside the Room's own home, kept alive on the server when the person walks away, with its text replayed when they come back, no time limit, and the Room's own profile and PATH so what was installed is found. Everything around the Room is the app's own chrome (solid surfaces, tokens, primitives); the only dark thing is the terminal's own screen.

The owner's report it answers, verbatim: "if i use try room suppose i run curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash just to test it and go to chat comeback to try room that will be reset i cant access them again and i want better new ons type ui easy to use and aesthetically pleasing". After this record: that command runs in a Room terminal with no cap and streams as it goes; going to chat and back shows the same terminal with the same text and the same shell; `hermes` is on the PATH in that terminal, in the next one, and in the assistant's own `run`; the Files window shows the installed folder whether the Room is on or off; and the page looks and works like a computer you use.

## 2. The page

Full width (the Room is a board, as 0003 section 6 allows: "full width for boards and the Room"), under the app's glass top bar. Everything on the page is solid: no `.glass`, no `backdrop-filter` (tests/glass.test.mjs enforces that blur stays in `src/shell/shell.css`). One font (Hanken Grotesk) for all chrome, JetBrains Mono (`--font-mono`) for the terminal, the honest line, file sizes and point names. The 4 px grid throughout.

### 2.1 Desktop, 1440 px, light theme

Side gutters 24 (`--space-5`), 16 (`--space-4`) between regions. Heights: Room bar 48, Desk the rest of the viewport (min 560), Dock 56. The desk's height is `calc(100vh - var(--topbar-h) - 48px - 56px - 2 * var(--space-5))`, min 560 px; the page itself does not scroll on desktop, windows scroll inside.

```
┌ Room bar (48) ──────────────────────────────────────────────────────────────────────────────────────┐
│ ● On   The Room · A private folder and shell                  [Stop] [Save a point] [Start over ▾]   │
│                                                      [Hand off a file] [Watch beside the chat] [⋯]  │
├ Desk (--color-surface-sunken) ──────────────── minmax(0,1fr) ──────────────┬──── 360 ───────────────┤
│ ┌ Terminal ────────────────────────────────────────── [+ New terminal] ─┐  │ ┌ Files ─────────────┐ │
│ │ A shell inside the Room. What you install here stays.                 │  │ │ What is in the     │ │
│ │ [Terminal 1] [Rooks ●]                                                │  │ │ Room's folder.     │ │
│ │ ┌ ○ ○ ○  Terminal 1 ─────────────────────────────────────────────┐    │  │ │ Home › Desktop     │ │
│ │ │ $ curl -fsSL https://… | bash                                   │    │  │ │ ▸ Downloads  folder│ │
│ │ │ Installing hermes…                                              │    │  │ │ ▸ hermes     folder│ │
│ │ │ (xterm, --screen-bg, 13 px mono, fills the window)              │    │  │ │   notes.txt  2 KB  │ │
│ │ └─────────────────────────────────────────────────────────────────┘    │  │ └────────────────────┘ │
│ └───────────────────────────────────────────────────────────────────────┘  │ ┌ Saved points ──────┐ │
│                                                                            │ │ Copies of the      │ │
│                                                                            │ │ Room's files…      │ │
│                                                                            │ │ before hermes      │ │
│                                                                            │ │ 7 Nov, 14:02       │ │
│                                                                            │ │ [Start over from here] │
│                                                                            │ └────────────────────┘ │
├ Dock (56) ──────────────────────────────────────────────────────────────────────────────────────────┤
│ [▣ Terminal] [▤ Files] [⚑ Points]      Commands run as you, in a folder of its own. It is not a      │
│                                         locked off computer.  [Your home folder kept apart]          │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Regions, each with its size, tokens and primitives:

* **Room bar** (48 px, `role="toolbar"`, `aria-label="The Room"`, solid `--color-surface`, 1 px `--color-border` below, padding 0 16): on the left an 8 px live dot (`--color-live`, only while `status.running`) then one line in sans 14: the state word from `roomStateWords` (**On** / **Off** / **Not installed**) in `--color-ink` 500, a middle dot, the status `label` in `--color-ink-muted`. On the right the verbs as 28 px `Button`s: **Start** (the one `primary` button, only while off) or **Stop** (`secondary`, while on); **Save a point** (`secondary`); **Start over ▾** (a `Menu` whose items are the points, newest first, by `pointLine`; disabled with title "Save a point first" when there are none); **Hand off a file** (`secondary`, opens the hand off panel under the bar); **Watch beside the chat** (`ghost`, as today); **⋯** (`IconButton`, a `Menu`: **Advanced** (opens the Advanced sheet), **Close every terminal**). One `role="status"` live region sits in the bar (visually the state word's wrapper) and announces: "The Room is on.", "The Room is off. Everything in it is kept.", "Saved a point: before hermes.", "The Room is back at before hermes · 7 Nov, 14:02.", "Terminal 1 ended.". Below 1280 px the verbs keep their icons and lose their words (title keeps the word), as the glass pill does.
* **Desk** (`--color-surface-sunken`, no texture, no wallpaper, no icons; `display: grid; grid-template-columns: minmax(0,1fr) 360px; gap: 16px; padding: 16px`): the left column holds the primary window (Terminal, or Screen when `status.screen`), the right column stacks the secondary windows (Files over Saved points, each min 200 px; Files `flex: 1`, Saved points `auto`, max 40 % of the column). A closed window gives its space to the others; with only the primary window open it spans both columns; with only right-column windows open they fill the width as one column of two. The desk is `main`'s content; the page has one `main` (the `Page` primitive, `wide`).
* **Window** = `Card` (`padding="none"`, `as="section"`, `aria-labelledby` its title, `--color-surface`, 1 px `--color-border`, `--radius-md` 10 px, no shadow) with a 36 px title bar (sans 14/500 `--color-ink`, left: the name; right: the window's own verbs as 28 px buttons) and a 13 px `--color-ink-muted` label line under it; then the body. Windows are never draggable or resizable: the grid places them. Only the Terminal window's body carries the dark `--screen-*` chrome (the three `--screen-dot-*` marks, `--screen-chrome` bar, `--screen-bg` body, `--screen-border`), exactly as `src/work.css` draws the app's Terminal page.
* **Dock** (56 px, `role="toolbar"`, `aria-label="Windows"`, solid `--color-surface`, 1 px `--color-border` on top, padding 0 16, pinned under the desk): items are 36 px `ghost` `Button`s with a 16 px lucide icon and the window's name (`SquareTerminal` Terminal, `Folder` Files, `Bookmark` Points, `Monitor` Screen, in that fixed order; Screen exists only when `status.screen`), `aria-pressed` = open, a 44 px hit area (`min-height: 44px` on the button's wrapper), 8 px apart. Pressing one opens or closes that window; the last open window cannot be closed (its button stays pressed and `disabled` with title "One window stays open"). The dock's right end carries the honest line (section 5) in 13 px mono `--color-ink-muted` and the isolation `Badge` (`isolationWords`), plus the `Badge` **No network** when `status.offline`; this end is never hidden on desktop. No verbs live on the dock.

Which windows are open is remembered per browser in `localStorage` under `rooks.room.desk` (`{open: ["terminal","files","points"]}`), a convenience only: the default comes from status (primary window + Files + Points), the browser never records anything the server must know, and a remembered name that status does not offer (Screen on a Room without one) is dropped at render time.

### 2.2 Phone, 390 px

The presence line above (`--presence-h` 44), the app's glass phone dock below (`--dock-h` 64 plus the safe area). One window at a time; the Room's dock becomes the `Tabs` primitive. 16 px gutters.

```
┌──────────────────────────────────────────┐
│ ● On · A private folder and shell   [⋯]  │  Room bar, 44 high, 2 lines max
├──────────────────────────────────────────┤
│ ┌ Terminal ──────────── [Terminal 1 ▾] + ┐│  window title 36; tabs become a Select when > 2
│ │ A shell inside the Room.              ││
│ │ ┌ ○ ○ ○ Terminal 1 ─────────────────┐ ││
│ │ │ $ curl -fsSL … | bash             │ ││  xterm, 13 px, fills to the key row
│ │ │ Installing hermes…                │ ││
│ │ └───────────────────────────────────┘ ││
│ │ [Esc][Tab][Ctrl][↑][↓][←][→]  (44 px) ││  key row: phone keyboards have none of these
│ └────────────────────────────────────────┘│
│ [Terminal] [Files] [Points]               │  Tabs primitive, 44 high, solid
│ Commands run as you, in a folder of its   │  honest line, 12 px mono, 2 lines, always visible
│ own. It is not a locked off computer.     │
├──────────────────────────────────────────┤
│        ( app glass dock )                 │
└──────────────────────────────────────────┘
```

* The Room bar's ⋯ `Menu` on phones carries: Start or Stop, Save a point, Start over (a submenu is not a primitive: it opens the Saved points tab with the list focused), Hand off a file, Close every terminal, Advanced. Watch beside the chat is omitted under 900 px (the Stage stacks under the thread there anyway).
* The Tabs row is `Tabs` (`size="md"`, 44 px, `aria-label="Windows"`), items in the dock's fixed order, Screen first when it exists. The chosen tab is the one open window. The honest line sits under the tabs, 12 px mono, two lines, never hidden, with the isolation words after it in the same line.
* The Terminal tab: with more than two terminals the tab chips become a `Select` in the title bar. Under the xterm a 44 px key row of `Kbd`-styled buttons: Esc, Tab, Ctrl (a latch: the next key is sent with Ctrl), ↑ ↓ ← →; shown only on touch (`pointer: coarse`).
* **A phone that is not this computer** (the page's host is not a loopback name, or the WebSocket closed with 4403): the terminal WebSocket is loopback and same-origin only (terminal_pty's rule, kept), so the Terminal tab shows the **tail view** instead: the same window, the same tabs, the body is a mono box in the `--screen-*` colours showing the last lines from `GET /api/room/terminals/{id}/tail` (asked every 2 s while the tab is visible, at once after a send), and under it a 44 px command row: a mono `Input` (`aria-label="Command for this terminal"`, `autocapitalize="off"`, `autocorrect="off"`, `spellcheck=false`) and a `primary` **Send** button that posts the line to `POST /api/room/terminals/{id}/send`. Its label line: "This phone shows the terminal's last lines and sends what you type. Open the Room on this computer for the full terminal." The tail is real output of a real shell, so the dark box is honest; it is labelled "last lines", never "screen".
* Files on the phone: a full-height `List` of `Row`s (44 px; name, meta, trailing **Hand off**). Saved points: the same, with **Start over from here** and the inline **Yes, start over** / **Keep it** pair.
* With a real screen the Screen tab comes first and Terminal second; Step in works with touch (tap = click, drag = drag, two-finger scroll = scroll, as RoomPicture already maps pointer events) and **Hand back** is a 44 px `primary` button pinned under the picture while stepped in.

### 2.3 Themes, motion, transparency

All colour comes from tokens; `room.css` stays tokens only (tests/wave2 class and token guards apply). Light, dark and high contrast differ only through the tokens:

| Part | Token |
| --- | --- |
| Desk background | `--color-surface-sunken` |
| Window, Room bar, dock surfaces | `--color-surface`; borders `--color-border` (2 px via `--border-w` in high contrast, where `--color-border` is black) |
| Dock pressed item | `--color-bg-active` background, `--color-ink` text, inset 1 px `--color-border-strong` (the same recipe as `.room-modes [aria-pressed=true]` today); never `--color-primary` |
| Title text / labels | `--color-ink` 14/500 / `--color-ink-muted` 13 |
| Live dot, busy dot on a tab | `--color-live` (always paired with a word: "On", "running") |
| Stepped in border on the Screen window | 2 px `--color-accent`, still, never animated |
| Terminal body | `--screen-bg`, `--screen-ink`, `--screen-chrome`, `--screen-border`, `--screen-dot-*`: deliberately dark in every theme, as the app's Terminal page is; in high contrast `--screen-ink` on `--screen-bg` is AA (the existing token test checks ratios from `tokens.css`; a new assertion adds this pair) |
| Danger (Yes, start over) | the `danger` Button variant |
| Focus | the global ring (`--focus-w`, `--color-border-focus`) |

Motion: the only motion on the page is the app's one fade (`ui-fade`, `--dur-fade` 120 ms, opacity only) when a window opens or closes or a panel appears; it is the same keyframe and the same single `prefers-reduced-motion` rule in `src/ui/ui.css` (tests/motion.test.mjs: one rule), so motion off and the OS setting stop it. xterm's cursor blink is turned off when `motionLevel() === "off"`. Nothing slides or pulses. Reduce transparency changes nothing on this page because nothing on it is glass. The xterm theme reads the `--screen-*` tokens at mount, as the Terminal page does today; a live theme switch re-reads them on the next mount (unchanged behaviour, noted in section 10).

## 3. Windows and panels

The set of windows is built at render time from status by a pure function `windowsFor(status)` in `src/room/desk.ts`: `screen` only when `status.screen`; `terminal` only when `status.can.terminal` (else `commands`); `files` only when `status.can.files`; `points` always (when `status.available`). A window that status does not offer does not exist: it has no dock item, no tab, no placeholder. Windows are sections with `aria-labelledby` their title; every window verb is a focusable 44 px target; no action is hover-only.

Common states, by the Room's condition (every window handles each):

| Condition | How it shows |
| --- | --- |
| Checking (`!status.checked`) | Room bar says "Checking the Room…"; the desk shows one `Loading` card; no dock items yet |
| Not installed (`available: false`) | Room bar: **Not installed**, no verbs; the desk shows one `EmptyState` "Not on this computer yet." with the installer note (`status.note`); no dock |
| Helper away (`!status.reachable`) | Room bar keeps the last known word and says "The Room could not be checked. Rooks did not answer; it will be asked again in a moment."; verbs disabled; windows keep their last content with a muted line "Last known." |
| Off | per window below; Files and Saved points keep working (the folder is there) |
| On, no screen | Terminal primary, Files, Points |
| On, real screen | Screen primary, Terminal (if `can.terminal`), Files, Points |
| Helper mode (`TRY_URL`) or Windows (`can.terminal: false`) | Commands window in the Terminal's place (3.5) |

### 3.1 Terminal

**What.** A real login shell inside the Room, drawn by the app's existing xterm.js pane (the `Shell` component lifted out of `pages/TerminalPage.tsx` into `src/terminal/Shell.tsx` with a `url` prop and a `replay` prop), connected to `WS /api/room/terminals/{id}/ws`. The session lives on the server (section 4): leaving the page keeps the shell; the pane stays mounted through the terminal keeper; a reload reattaches and the server replays its scrollback, so the same text is on screen when the person returns. Nothing run here has a time limit.

**Title bar.** "Terminal"; right: **New terminal** (28 px `secondary`, `Plus` icon; `disabled` with title "Four terminals can be open in the Room. Close one to open another." when `terminals.length >= terminal_max`). Label line: "A shell inside the Room. What you install here stays." Under the label a `role="tablist"` of terminal tabs (the existing `TabChip`: click to pick, double-click to rename, × to close with the confirm "Close this terminal? What it is running stops." as a `danger`/`ghost` pair inline, drag to move is dropped for the Room since order is the server's). A tab shows a `--color-live` dot and the word "running" in its `title` while `busy`; the Rooks tab shows elapsed time ("3 min") while its started command runs and "Done (code 0)" for 30 s after it ends, then nothing. Tab names come from the server (`terminals[].name`); renaming calls `PATCH`.

**Body.** The `.terminal-screen` chrome from `work.css`: the three dots and the active tab's name in the `--screen-chrome` bar, the `--screen-bg` box with xterm (13 px mono, scrollback 5000, `screenReaderMode: true`). Before the box, a visible-on-focus skip link **Skip the terminal** (the app's `.skip-link` style) that moves focus to the Files window title (or the dock when Files is closed). Inside the terminal every key goes to the shell, Escape included; F6 is the one key the pane keeps: it moves focus from the terminal to the window's title bar (xterm's `attachCustomKeyEventHandler`), and the title bar's tooltip says "F6 leaves the terminal". The chrome bar carries a `role="status" aria-live="polite"` span for the phase words: "Opening a terminal in the Room…", "Picked up where you left off." (3 s after a reattach that replayed text), "This terminal ended.".

**States.**

| State | On screen |
| --- | --- |
| Room off | `EmptyState` in the body: "The Room is off. Everything in it is kept." line "Start it to open a terminal." with **Start** (the same `act.start`). The tab strip still lists any ended terminals (greyed) so nothing disappears. |
| Opening | chrome bar: "Opening a terminal in the Room…" |
| Open | live shell; cursor blinks (unless motion off) |
| Busy | the tab's dot and "running" |
| Rooks's tab, busy | chrome bar trailing text "Rooks is working here" and a 28 px `ghost` **Take this one**; the terminal does not take keystrokes until taken (xterm `disableStdin` while `owner === "rooks" && busy`); after **Take this one** (POST take) typing works, presence says "You took the terminal; Rooks waits", and the assistant's next tail says so. When not busy the Rooks tab is typable with the one-time line "Rooks started this. You can type here too." |
| Ended (shell exited, closed by Stop, or the app restarted) | the replayed text stays, greyed (`opacity: .6` on the box, `aria-hidden` off), with a line printed into the terminal in `--screen-ink` dim: "This terminal ended. Its files are still in the Room." or, when `ended_reason === "restart"`, "The app restarted, so this terminal ended. Your files and anything you installed are still here."; under the box a 28 px **Open a new terminal** button and **Close** (removes the ended record). |
| Full | New terminal disabled with its title |
| Phone off this computer | the tail view (2.2) in the same window |
| Terminals switched off in Settings | `EmptyState` "Terminals are switched off in Settings." with a link to Settings |

**Verbs and words.** New terminal · Close · Open a new terminal · Rename (double-click; the input's label "Terminal name") · Take this one · Skip the terminal · the phone key row Esc, Tab, Ctrl, arrows · Send (phone). Terminal names: "Terminal 1", "Terminal 2"… for the person; "Rooks" (then "Rooks 2") for the assistant.

**Keyboard and focus.** Tab order: skip link → title bar verbs → tabs (roving, arrow keys) → the terminal box. Focus lands in the terminal after New terminal and after Open a new terminal. F6 leaves to the title. After **Close**, focus goes to the next tab, or to New terminal when none is left.

### 3.2 Files

**What.** What is in the Room's home, from `GET /api/room/files?path=…`: a breadcrumb row (`Home › Desktop`, each crumb a button) and a `List` of `Row`s (leading icon `Folder`/`File`/`Link`; title the name; meta "folder", "2 KB", or "link"; a second meta "today 14:02" or "3 Nov"). Folders first, then files, A to Z, dotfiles last (shown, because the seeded `.profile` must be visible); a trailing **Hand off** button on files (opens the hand off panel with the file prefilled; nothing is copied; the copy waits in Needs you) and **Show in terminal** (sends `cd '<folder of the file>'` to the active terminal through `/send`; disabled when no terminal is open). Reading only; nothing is changed from this window. Up to 500 entries; past that the footer says "Showing the first 500. Use the terminal to see more." (`truncated`).

**Title bar.** "Files"; right: **Up one folder** (28 px `ghost`, disabled at Home), **Refresh** (`IconButton`). Label: "What is in the Room's folder." and, while the Room is off, "The Room is off. Its files are still here." (the key state for the owner's report: the folder exists whether the Room is on or off, so the list shows either way).

**States.** Loading: `Loading` skeleton rows. Empty: `EmptyState` "Nothing here yet." line "What you install or save in the terminal shows up here." Error: `ErrorState` "The folder could not be read." with Try again (a 404: "That folder is gone." with **Back to Home**). Separate computer without a shared folder (`can.files: false`): the window does not exist; the dock has no Files item; the Advanced sheet says "Files live inside the separate computer. Use its screen." A link that points outside the Room is listed as "link" and cannot be opened ("That link points outside the Room.").

**Words.** Files · Home · Up one folder · Refresh · Hand off · Show in terminal · folder · link.

**Keyboard and focus.** Rows are buttons (Enter opens a folder); trailing actions are real buttons in the tab order; after opening a folder focus goes to the breadcrumb's last crumb; after **Hand off** focus goes to the panel's first field.

### 3.3 Saved points

**What.** The checkpoints from `status.checkpoints` as a `List`, newest first, each `Row` with `pointLine(name)` as title and a trailing **Start over from here** (`ghost`, `RotateCcw`), which swaps for the inline pair **Yes, start over** (`danger`) / **Keep it** (`ghost`) plus one line: "This puts the Room's files back as they were then. Anything done since is lost." followed, when terminals are open, by "N terminals will close." (N from `terminals.filter(alive).length`; "1 terminal will close."). The title bar's **Save a point** (28 px `primary`) opens a one-field row at the top of the window: `Input` label "Name this point", placeholder "Before the upgrade", hint "The Room's files are copied as they are now, so you can start over from here later.", **Save a point** / **Cancel**; the row disappears once the service verified the point. The Room bar's Save a point does the same (opens this window if closed, focuses the field); the Room bar's Start over menu picks a point and opens this window on that row's confirm pair.

**Verification and words**, unchanged from `useRoomActions`: "Saved a point: before hermes." only on `verified: true`; "The Room is back at …" only on `verified: true`; otherwise the existing error lines. While saving, the button reads "Saving…" and the row's hint adds "A big folder can take a while."; the copy runs off the event loop (it already does through `asyncio.to_thread`).

**States.** None yet: `EmptyState` "No saved points yet. Save one before trying something you might want to undo." with **Save a point**. Saving: busy. Confirming. Starting over: Yes, start over busy; every open terminal's chrome bar says "The Room is starting over; this terminal closes." and the pane ends; on verified the toast and one new "Terminal 1" opens. Pruned: footer "Older points are removed once there are 20; N removed so far."

**Keyboard and focus.** After a verified Start over, focus returns to the Saved points title (as grafted). After a verified Save a point, focus returns to the Save a point button. Escape in the name row cancels it.

### 3.4 Screen (only when `status.screen`)

The existing `RoomPicture`, unchanged, as the primary window: title "Screen"; the title bar holds **Watch** / **Step in** / **Hand back** (only when `status.pointer`, the existing `.room-modes` group) and the "Waiting for the next frame…" pill when stale. Label: the status label and note ("A private desktop on this computer. A screen of its own on this computer…"). The still 2 px `--color-accent` border while stepped in is on this window, not the page. Escape hands back (as today, inside the picture only). Off: `EmptyState` "The Room is off. Everything in it is kept." line "Start it to see its screen." with **Start**. Not present at all when there is no screen. Hover hint "Step in to use your mouse and keyboard here" (kept, and the same words in the Step in button's title for keyboard users). With a screen the Terminal window moves to the right column above Files (it runs the same login shell into the same home as the xterm on the Room's own display).

### 3.5 Commands (fallback only)

The existing `CommandView`, kept as a window named "Commands" for the two places a Room terminal cannot exist: helper mode (`TRY_URL` set; the helper hosts no terminals yet) and Windows (no pseudo terminal in the app). It is never shown beside a Terminal window. Label: "One command at a time, up to two minutes each." and, in helper mode, "A terminal needs the Room on this computer." Its lines move into the room status store (`src/room/status.ts`, `commandLines`) so leaving and returning keeps them for the session. Its code 124 note becomes "Stopped after 120 seconds. For something long, start it in a Room terminal."

### 3.6 Hand off a file (a panel, not a window)

The existing `HandoffPanel`, drawn under the Room bar on desktop (the `.room-panel` style, 1 px border, fade in) and as a `Sheet` on phones, prefilled with `src` when opened from a Files row. Words unchanged: "A file leaves the Room only after your OK. Asking here puts the copy in Needs you; nothing is copied yet.", **Ask to hand it off**, the `HeldNote` "Waiting for your OK." with **Open Needs you**; after a held answer focus goes to Open Needs you (as grafted). Already asked: the existing note.

### 3.7 Advanced (a sheet)

From the ⋯ menu: a `Sheet` titled "Advanced" with a `dl` in mono: Kind (`driver`), Folder (`home`), Shell (`shell`, and the login shell's path from `terminals[0].shell` when one is open), Profile files read ("~/.profile and, for bash, ~/.bashrc; for zsh ~/.zprofile and ~/.zshrc"), Terminals open (N of 4), What is recorded ("Each terminal opening and closing, every command Rooks starts, and commands sent from a phone are in the run log. What you type in a terminal is not recorded."), and, in helper mode, the helper's address. This is the only place a path, a driver name or a shell path appears.

## 4. Persistence, end to end

Four causes, four fixes. Everything here is in process (the desktop app and the usual install); helper mode keeps the Commands window (section 10).

### 4.1 The terminal session lives on the server

New module `workbench/backend/app/room_terminal.py`. It imports and reuses `terminal_pty`'s pieces: `shell_env()` (the secret scrub plus `TERM=xterm-256color`, `COLORTERM=truecolor`), `_resize`, `_hang_up`, `_reap`, `_is_local`, `_same_origin`, `enabled()`; nothing is copied. A Room terminal is a login shell on a pseudo terminal (`pty.openpty`) started inside the Room with `rooks_try.drivers.shell.login_argv(home, offline)` (4.2), `cwd` the Room's home, `start_new_session=True`, `close_fds=True`. Unlike the app terminal, the session is not owned by the WebSocket: a module registry keeps it.

```python
@dataclass
class RoomTerminal:
    id: str              # 8 hex chars
    name: str            # "Terminal 1", "Rooks"
    owner: str           # "person" | "rooks"
    proc: subprocess.Popen | None
    master: int | None   # the pty's master fd
    cols: int; rows: int
    started: str         # ISO
    ring: bytearray      # the last 256 KiB of raw output, OSC 7777 stripped
    log: Path            # ~/.ai-workspace/try-room/work/terminals/{id}.log (store.work_dir()), capped at 2 MB: when it passes 2 MB it is rewritten keeping the last 1 MB
    meta: Path           # {id}.json: id, name, owner, started, command, ended, exit_code, ended_reason
    attached: WebSocket | None
    command: str | None  # what the assistant typed (owner rooks)
    command_at: float | None
    last_code: int | None   # exit code of the last command the shell reported
    ended: bool; ended_reason: str | None   # "closed" | "stop" | "start over" | "exited" | "restart"
    exit_code: int | None
    input_since_attach: bool
```

The reader is `loop.add_reader(master, …)` as in `terminal_pty.terminal`, but it appends to `ring` and `log` and forwards to `attached` when there is one; it never closes the shell on socket loss. OSC 7777 (4.2) is cut out of the stream before the ring, the log and the socket, and its payload sets `last_code` and, for a `rooks` terminal with a `command`, marks the command done. `busy` is computed on demand: `os.tcgetpgrp(master) != proc.pid` (a foreground job is running), or `False` when the fd is gone.

Attach (`WS /api/room/terminals/{id}/ws`): refusals as `terminal_pty.refusal` (not enabled → 4403 "Terminals are switched off in Settings or not available on this system", not signed in → 4401, wrong origin → 4403, not loopback → 4403 "The terminal only opens on the computer running Rooks"), then 4404 "No such terminal", then 4409 "The Room is off" when the shell has ended (an ended terminal is read through `tail` and the log, not attached). On accept the server sends one text frame `{"type":"scrollback","data":<ring as utf-8, replace>,"cols":N,"rows":N,"alive":true}`, then raw output text frames. If another socket is attached it is closed first with code 1000 reason "This terminal was opened in another window." (one attached socket at a time). Client frames: `{"type":"input","data"}` (refused silently while `owner == "rooks"` and busy and not taken; the chrome bar already says why) and `{"type":"resize","cols","rows"}`. On the first resize after attach the server applies the size and, when it equals the current one, applies rows − 1 then rows so the shell gets SIGWINCH and a full-screen program redraws. Detach (socket closed): `attached = None`, the shell keeps running; if any input was sent during the attachment, one run log row "You used the terminal for N min" (section 4.5).

End of a shell: `close(id, reason)` runs `_hang_up` then `_reap` in a thread, writes `ended`, `ended_reason`, `exit_code` to the meta, closes the fd, keeps the log. The registry keeps the ended record (so the page shows it greyed) until `DELETE` removes it and its files. When the shell exits by itself (EIO on read) the record ends with reason `exited`. `close_all(reason)` is called by `down` (reason `stop`) and before `reset` (reason `start over`); `atexit` hangs every live shell up and writes reason `restart` so a restart is told honestly. On import, `load_ended()` reads every `{id}.json` in the terminals folder whose process is not this process's: those are listed as ended with reason `restart`, their log is their scrollback, and the Terminal window prints the restart line next to the greyed text (3.1). Max 4 Room terminals (live or ended), counted apart from the app terminal's 6.

### 4.2 The shell is a login shell inside the Room: PATH and profile

In `rooks-try/rooks_try/drivers/shell.py`:

* `login_argv(home, offline) -> list[str]`: on Linux with namespaces, `wrapped('exec "${SHELL:-/bin/sh}" -l', home, offline)` = `["unshare", "-Urm[n]", "--", "sh", "-c", _WRAP, "room", str(home), expanduser("~"), 'exec "${SHELL:-/bin/sh}" -l']` (the existing `_WRAP`: `cd` into the Room's home, bind it over the person's home path, move `HOME` to that path when the Room's home is hidden by the bind, `exec sh -c "$3"`); elsewhere `["sh", "-c", 'cd "$1" && exec "${SHELL:-/bin/sh}" -l', "room", str(home)]`. On Windows there is no pseudo terminal in the app, so it is not used there (`can.terminal` is false). `NestedDriver._login_shell` is replaced by this function (so the xterm on the private desktop is a login shell too, reading the same profile).
* `run_argv(command, home, offline) -> list[str] | None`: the same wrapper with the final line `exec "${SHELL:-/bin/sh}" -lc "$3"` (a new `_WRAP_LOGIN` that differs from `_WRAP` only in that last `exec`), and off Linux `["sh", "-c", 'cd "$1" && exec "${SHELL:-/bin/sh}" -lc "$2"', "room", str(home), command]`; on Windows with Git bash `[bash, "-lc", command]`, and Command Prompt as today. `ShellDriver.run` uses it. So the assistant's quick `run` and the terminal's `/room run` see the Room's profile and PATH, and `hermes` installed a turn ago is found a turn later.
* `room_env(home, offline, base=None) -> dict`: the existing `_env` made public and given a base: `base or os.environ`, then `HOME` = the Room's home, `ROOKS_TRY=1`, the secret names dropped (`_SECRET_NAMES` and every `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`), the offline proxies, and `PATH = f"{home}/.local/bin:{home}/bin:{home}/.cargo/bin:" + base PATH`. The Room terminal's env is `room_env(home, offline, base=terminal_pty.shell_env())`, so both scrubs apply (`security.APP_SECRET_ENV` is covered by `shell_env`'s names and regex) and `TERM`/`COLORTERM` are set. The nested driver adds `DISPLAY`.
* `store.seed_home(home)`: called from `ShellDriver.up()` and `NestedDriver.up()` and before the first terminal starts. Writes, only when the file is missing, `~/.profile`:

  ```sh
  # Rooks put this here so tools you install in the Room are found. Edit it as you like.
  PATH="$HOME/.local/bin:$HOME/bin:$HOME/.cargo/bin:$PATH"; export PATH
  if [ -n "$BASH_VERSION" ] && [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi
  if [ -n "$BASH_VERSION" ]; then PROMPT_COMMAND='printf "\033]7777;%s\007" "$?"'"${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; fi
  ```

  and `~/.zprofile`:

  ```sh
  # Rooks put this here so tools you install in the Room are found. Edit it as you like.
  PATH="$HOME/.local/bin:$HOME/bin:$HOME/.cargo/bin:$PATH"; export PATH
  precmd() { printf "\033]7777;%s\007" "$?"; }
  ```

  Because `HOME` is the Room's home (and on Linux the bind makes even a hardcoded home path land there), an installer that appends to `~/.bashrc`, `~/.profile`, `~/.zshrc` or drops a binary in `~/.local/bin` writes into the Room, and the next login shell, or `exec $SHELL -l` in this one, sees it, as on any computer. The OSC 7777 line is how the server learns each command's exit code (4.1) without logging the command; xterm.js ignores unknown OSCs and the server strips them anyway. Saved points copy these files with the home; Start over restores them. The profile is seeded, never overwritten; a `.bash_profile` the person creates wins, as bash's rules say (section 10 lists the shells this does not cover).

### 4.3 Long installs: no cap in a terminal, 120 s kept for the chat tool

A Room terminal has no time limit. `RUN_MAX_S` stays 120 for `POST /api/room/run` (the assistant's and `/room run`'s quick path; a ten-minute block would still be a cut-off and ties up a turn), and its code 124 words become "Stopped after 120 seconds. For something long, start it in a Room terminal." For long work the assistant uses the new `use_room` action `start` (`POST /api/room/terminals {name: "Rooks", command}`): the server opens, or reuses when alive and not busy, the terminal named "Rooks" (else "Rooks 2", up to the cap), types `command + "\n"` into it and returns at once with `{id, name, started: true}`; action `tail` (`GET …/tail`) returns `{text, alive, busy, exit_code, elapsed_s, taken}` so the assistant can say "still installing" honestly; presence says "Installing in the Room's terminal" (`doing` from the run log row's args, as today). The run log records the start (the command, scrubbed) and, when the server sees the command end, one row with the exit code and the last 20 lines. The `use_room` description tells the model: use `start` for installers, builds and anything that may take more than a minute; `run` only for quick checks. Output streams on screen because it is a terminal.

### 4.4 Leaving and returning

The Room's terminal panes stay mounted: `src/terminalHost.tsx` is generalised to keyed keepers (`"app"` and `"room"`), each with its own slot list and parked element; `<TerminalSlot kind="room" />` sits in the Terminal window's body on the Room page and in the Room Stage, and `<RoomTerminalKeeper />` (next to the existing keeper in `App.tsx`) draws the Room's panes over whichever slot is showing. Moving to chat and back does not even reconnect. On a reload or a reopened app window the page lists terminals from status, opens a socket per live terminal, and the server's scrollback is replayed into a reset xterm (`term.reset()` then `term.write(data)`), so the same text is there. The terminal list (ids, names, order, owner, alive, busy) comes from `GET /api/room/status` on every refresh (`status.ts` adds `terminals` and `terminal_max` to the store; `refreshRoomStatus()` after every terminal action), never from browser state. The Commands view's lines (fallback only) live in the status store too.

### 4.5 Stop, Start over, Save a point, the run log

* **Stop** (`POST /api/room/down`): hangs every Room terminal up first (`close_all("stop")`), then the driver's `down`; the answer adds `terminals_closed: N`; the toast and the live region say "The Room is off. Everything in it is kept." The folder is untouched; Files still lists it.
* **Start over** (`POST /api/room/reset`): `close_all("start over")` before the restore (no process may stand in a folder being replaced), the existing verified restore, then, when the Room is on afterwards, one new "Terminal 1" is opened; the answer adds `terminals_closed: N` and `terminal: {id}`. The confirm names N beforehand (3.3).
* **Save a point**: unchanged (`store.checkpoint` copies the home while shells run; the hint says files are copied as they are now); the button says it may take a while.
* **Run log** (channel `room`, tool `use_room`, through `room._audited`/`_record` with `actions.args_preview`): `open terminal` (name), `close terminal` (name, exit code, reason), `start` (the command), `done` (exit code, the last 20 lines, as the end of a start), `send` (each line from the phone command row or `/room`, scrubbed like every args preview), `files` is not logged (a read, like status), `tail` is not logged, keystrokes over the WebSocket are never logged; one coarse row `used terminal` ("You used the terminal for 12 min", name) is written when a socket detaches after any input. Advanced says exactly this (3.7). The honest line never claims "everything you run here is in the log".

## 5. Honesty

Rules from 0003 section 4, applied to the desk:

* **The honest line**, from `commandViewLine(status)` (unchanged words), sits on the dock at all widths: desktop at the dock's right end, phone under the Tabs row; never under Advanced. For a folder and shell: "Commands run as you, in a folder of its own. It is not a locked off computer." (with " Commands run in Windows Command Prompt, not a Unix shell…" appended by the driver on Windows without Git); for a private desktop the driver's note "A screen of its own on this computer. Commands run as you, in a folder of its own."; for a separate computer the driver's note ("A separate computer. Commands run inside it, apart from your files."). Beside it the isolation `Badge` (Not locked off / Your home folder kept apart / A separate computer; ", no network" when namespace and offline) and **No network** when offline. The Terminal window's label adds "A shell inside the Room."; the Room bar always shows the label next to the state word, so "On" is never read without "A private folder and shell".
* **A screen only when `status.screen`**: the Screen window, its dock item and its tab exist only then (`windowsFor`), and the picture is `RoomPicture`, mounted only while `roomScreenLive(status)`; input controls only when `status.pointer`. The desk is a flat sunken surface: no wallpaper, no icons, no drawn windows, no fake dock items. Windows are the app's `Card` chrome with a sans title bar, so nothing reads as a screenshot of an operating system. The only dark surface is the Terminal body (and the phone tail view), which shows a real pty's output or a real shell's last lines, is titled "Terminal", and is never called a screen.
* **On means on**: the Room bar says On only when status says `running` (after `up` returned running); Start is the one primary button while off. A Terminal window on an off Room is an `EmptyState`, never a dark box pretending to be ready.
* **Said done only when verified**: Save a point and Start over, unchanged. Hand off waits in Needs you; the Files row's Hand off opens the same form and copies nothing.
* **Ended is said**: an ended shell stays greyed with its last text and the words "This terminal ended" (or "The app restarted, so this terminal ended…"), never silently replaced by a new one; `restart.py`'s note in the thread gains the sentence "Terminals in the Room ended; their files are still there." when any Room terminal was live at the restart.
* **Advanced holds the technical detail**: driver kind, folder, shell path, profile files, what is logged, the helper's address. No path, id, driver name, "namespace" or "pty" appears elsewhere.

## 6. API contracts

Who may call: every route below requires the signed-in user (`require_user`), except the ones marked **terminal key** which also take the rooks terminal's key through `require_user_or_terminal` (the Terminal access token for writes; a bridge key reads only, with the `X-Workbench-Channel: rooks-code` header, exactly as today); writes need the `X-Workbench` header (`main.guard`). The WebSocket follows `terminal_pty`'s rules: signed in, same origin, loopback peer and loopback page, terminals not switched off in Settings. Errors are one plain line in `detail`.

### `GET /api/room/status` (extended) · terminal key

```json
{ "...": "everything in the contract today",
  "terminals": [{"id": "a1b2c3d4", "name": "Terminal 1", "owner": "person", "alive": true, "busy": false,
                 "started": "2026-11-07T14:02:11Z", "exit_code": null, "ended_reason": null, "command": null, "elapsed_s": 184}],
  "terminal_max": 4,
  "can": {"terminal": true, "files": true} }
```

`can.terminal` is true only in process, on POSIX, with `terminal_pty.enabled()`, when the driver gives a shell (`driver.terminal_argv(home)` is not None: shell and nested do, qemu does not); `can.files` is true when the driver has a folder on this computer (`store.guest_home()` for shell and nested; false for qemu and in helper mode). Both false in helper mode.

### `GET /api/room/terminals` · terminal key

`{"terminals": [as above, plus "cols", "rows", "shell": "/bin/bash"], "max": 4}`.

### `POST /api/room/terminals` · terminal key (write)

In: `{"name": "Rooks", "command": "curl -fsSL … | bash"}` (both optional; `owner` is `rooks` when `command` is given or the caller is the chat tool, else `person`). Out: `{"id", "name", "owner", "alive": true, "started"}`. With `command`, an alive, not busy terminal of that name and owner `rooks` is reused. Errors: 409 "The Room is off. Start it first."; 429 "Four terminals can be open in the Room. Close one to open another."; 501 "This Room has no terminal of its own. Use its screen." (`can.terminal` false); 503 when the Room is not installed. Logged as `open terminal` and, with a command, `start`.

### `WS /api/room/terminals/{id}/ws`

Server first: `{"type":"scrollback","data":"…","cols":80,"rows":24,"alive":true}` as one text frame; then raw output as text frames. Client: `{"type":"input","data":"…"}`, `{"type":"resize","cols":N,"rows":N}`. Close codes: 4401 "Not signed in"; 4403 "Wrong origin" / "The terminal only opens on the computer running Rooks" / "Terminals are switched off in Settings or not available on this system"; 4404 "No such terminal"; 4409 "This terminal has ended"; 1000 "This terminal was opened in another window." / "The shell exited". Detaching never ends the shell.

### `GET /api/room/terminals/{id}/tail?lines=200` · terminal key

`{"text": "last N lines (OSC stripped, ANSI kept)", "alive": true, "busy": true, "exit_code": null, "owner": "rooks", "taken": false, "elapsed_s": 184, "started": "…"}`. `lines` 1 to 2000, default 200. 404 "No such terminal". Not logged.

### `POST /api/room/terminals/{id}/send` · terminal key (write)

In: `{"text": "hermes --version", "enter": true}`. Out: `{"ok": true, "bytes": 17}`. 409 "Rooks is working in that terminal. Take it first, or open your own." when `owner == "rooks"`, busy and not taken; 409 "This terminal has ended."; 404. Logged as `send` (the text through `args_preview`).

### `POST /api/room/terminals/{id}/take`

In: `{"owner": "person"}` (or `"rooks"` to hand it back). Out: `{"id", "owner", "taken": true}`. Presence's `doing` becomes "You took the terminal; Rooks waits" while a turn works in the Room. The assistant's `tail` then returns `taken: true` with `note: "The person took this terminal; what it prints now is theirs."`.

### `PATCH /api/room/terminals/{id}`

In: `{"name": "hermes"}` (1 to 40 characters, trimmed). Out: `{"id", "name"}`. Names live on the server.

### `DELETE /api/room/terminals/{id}` · terminal key (write)

Out: `{"ok": true, "exit_code": 0, "closed": true}`; for an already ended record it removes the record and its log. Logged as `close terminal`.

### `GET /api/room/files?path=Desktop` · terminal key

Out: `{"path": "Desktop", "parent": "", "root_label": "Home", "entries": [{"name": "hermes", "kind": "folder", "size": null, "modified": "2026-11-07T14:02:11Z"}, {"name": "notes.txt", "kind": "file", "size": 2048, "modified": "…"}, {"name": ".profile", "kind": "file", "size": 230, "modified": "…"}], "truncated": false}`. `kind` is `folder`, `file` or `link` (a symlink whose target resolves outside the Room's home, or is broken; listed, never followed). The path is resolved and must stay under `store.guest_home().resolve()`: 400 "That is outside the Room." otherwise; 404 "That folder is gone."; 501 "Files live inside the separate computer." when `can.files` is false. At most 500 entries (`truncated: true` past that). Works while the Room is off. Not logged.

### `POST /api/room/run` (unchanged shape) · terminal key (write)

In `{"command", "timeout" ≤ 120}`; out `{ok, code, stdout, stderr, note, isolation, shell}` as today, now run through `run_argv` (a login shell, the Room's profile and PATH). The 124 note on the page changes (4.3).

### `POST /api/room/down` and `POST /api/room/reset` (unchanged shape) · down: terminal key (write)

`down` adds `terminals_closed: N`; `reset` adds `terminals_closed: N` and `terminal: {"id", "name"}` for the one reopened (or `null` when the Room is off afterwards).

### `POST /api/room/checkpoint {label}`, `POST /api/room/reset {name}`, `POST /api/room/handoff {src, dest}` · terminal key (write)

Moved from `room.router` to `room.terminal` so `/room save`, `/room back` and `/room handoff` work from the rooks terminal with the Terminal access token (a bridge key still only reads). Shapes unchanged. `tests/test_terminal_reach.py::test_nothing_else_widens` is updated on purpose to list these.

### `use_room` tool actions (`assistant.py`)

`start {command, name?}` → `{id, name, started: true, note: "Started in the Room's terminal. Use tail to see how it goes."}`; `tail {id?, lines?}` (no id: the newest `rooks` terminal) → the tail shape; `files {path?}` → the files shape; `run` unchanged (cap 120 s, the new 124 words). The tool description gains: "start runs a long command in a Room terminal with no time limit and returns at once; use it for installers, builds and anything that may take more than a minute, then tail to see how it goes. run is for quick commands (two minutes at most)." Every action still asks first through `_room_confirm`, except `status`, `tail`, `files` and `handoff`.

## 7. Parity

### 7.1 The rooks terminal (`rooks-code/rooks_code/workroom.py`)

Through the same routes with the terminal's key; the words match the page (On, Off, Save a point, Start over, Needs you, Hand off a file).

| Command | Does |
| --- | --- |
| `/room` | status as today, then the open terminals: "Terminal 1 · yours", "Rooks · running, 3 min", "Rooks · ended, code 0"; the honest line |
| `/room start`, `/room stop` | as today; stop prints "The Room is off. Everything in it is kept. 2 terminals closed." |
| `/room run COMMAND` | as today, now through the login shell, so it finds installed tools; 124 says "Stopped after 120 seconds. For something long: /room open COMMAND" |
| `/room open COMMAND` | `POST /api/room/terminals {name: "Rooks", command}`: "Started in the Room's terminal "Rooks". /room tail shows how it goes." |
| `/room tail [NAME]` | `GET …/tail?lines=60`: the lines, then "still running (3 min)" or "ended with code 0" |
| `/room send NAME TEXT` | `POST …/send` |
| `/room close NAME` | `DELETE` after "Close NAME? What it is running stops. (y/N)" |
| `/room files [PATH]` | the listing as rows: name, "folder" or size, when |
| `/room points` | the saved points by `pointLine`'s words (label · day, time) |
| `/room save LABEL` | `POST checkpoint`; prints "Saved a point: LABEL." only when `verified` |
| `/room back NAME` | `POST reset` after "Yes to start over from NAME? Anything done since is lost and open terminals close. (y/N)"; prints "The Room is back at …" only when `verified` |
| `/room handoff FILE DEST` | held in Needs you; "Waiting for your OK in Needs you (/needs)." |
| `/room shell` | when the Room is on this computer and `rooks_try` is importable: runs `login_argv(home, offline)` with `room_env(...)` directly in the person's terminal (`os.execvpe` is wrong here: it is a child, `subprocess.call`, so the TUI returns after `exit`), the same wrapper, home and profile the app's terminal uses; otherwise "The Room's terminal opens in the app on this computer." |

`/help` lists them under "The Room". The TUI's status line shows the Room's live dot while a `/room open` command runs (from `/room`'s status, asked when the person next runs a `/room` verb; no polling).

### 7.2 The Stage (Watch beside the chat)

`RoomStage` keeps the `StageFrame` and shows a compact desk: the goal line, then the primary window only (Screen when real, else the Terminal window body with its tabs, through `<TerminalSlot kind="room" />` so it is the very same panes as the page), and under it a reduced dock of icon-only `IconButton`s (Terminal, Files, Points, Screen when real; `aria-pressed`; title with the name) that swap the one window shown; Files and Points there open as the same windows at the Stage's width. The frame's controls bar keeps Start/Stop, the modes, Save a point, Start over, Hand off a file, **Open the Room page** and Close, as today. The honest line stays in the frame (`.room-honest`). The Stage never shows two windows side by side.

### 7.3 Chat

`use_room` gains `start`, `tail` and `files` (section 6), so chat can do what the page and the terminal do; `rooks-browser` reaches the same through the bridge's tool names, no change beyond that.

## 8. Work packages and file ownership

Three lanes in parallel. Shared contracts (section 6 and the status shape) are fixed by this record and come first in each lane, so no lane waits on another: the frontend builds against the JSON here with the status store's test fixtures; the terminal lane builds against `fake_app` fixtures in `rooks-code/tests/test_workroom.py`. A lane never edits a file another lane owns.

**Lane B, backend.** Owns `workbench/backend/app/room_terminal.py` (new), `room.py`, `room_files.py` (new: the listing, confinement, `can`), `assistant.py` (the `use_room` tool only), `terminal_pty.py` (make `_resize`, `_hang_up`, `_reap`, `_is_local`, `_same_origin`, `refusal` importable; no behaviour change), `restart.py` (the one sentence), `main.py` (include the new router), `rooks-try/rooks_try/drivers/shell.py`, `drivers/base.py` (`terminal_argv` default None), `drivers/nested.py` (`_login_shell` → `login_argv`, `terminal_argv`), `drivers/qemu.py` (`terminal_argv` None), `store.py` (`seed_home`), `rooks-try/rooks_try/server.py` (status gains `can: {terminal: false, files: false}`), `workbench/backend/tests/test_room_terminal.py` (new), `test_room.py`, `test_terminal_reach.py`, `rooks-try/tests/test_room.py`, `BACKLOG.md`, `CHANGELOG.md`. Order: (1) the guard tests of 9.1 to 9.4, failing; (2) `shell.login_argv`, `run_argv`, `room_env`, `store.seed_home`, nested and qemu `terminal_argv`; (3) `room_files.py` and `can` in status; (4) `room_terminal.py` and its routes; (5) `down`/`reset` closing terminals, the run log rows; (6) `use_room` actions and description, `restart.py`; (7) the route moves and the reach test; (8) suites. Must not touch `workbench/frontend/**` or `rooks-code/**`.

**Lane F, frontend.** Owns `workbench/frontend/src/terminal/Shell.tsx` (new, lifted from `pages/TerminalPage.tsx`), `pages/TerminalPage.tsx` (uses it), `terminalHost.tsx` (keyed keepers), `App.tsx` (mount the room keeper), `room/desk.ts` (new, pure: `windowsFor`, `dockItems`, `defaultOpen`, `readDesk`/`writeDesk`), `room/words.ts` (new words), `room/status.ts` (`terminals`, `terminal_max`, `can`, `commandLines`), `room/RoomPage.tsx` (the desk), `room/RoomView.tsx` (keeps `useRoomActions`, `RoomPicture`, `PointPanel`, `ResetPanel`, `HandoffPanel`, `HeldNote`, `CommandView`; drops the side cards), `room/RoomStage.tsx`, `room/TerminalWindow.tsx` (new: tabs, panes, tail view, key row), `room/FilesWindow.tsx` (new), `room/PointsWindow.tsx` (new), `room/room.css`, `Palette.tsx` (commands `room-terminal`, `room-point`, `room-over`, `room-files`), `work.css` (only if a class must be shared), tests `tests/room-desk.test.mjs` (new), `workroom-room.test.mjs`, `plain-screens.test.mjs`, `glass.test.mjs` and `motion.test.mjs` (unchanged, they must keep passing), `tokens`-ratio test (the `--screen` pair). Order: (1) the guard tests of 9.5 to 9.8, failing; (2) `Shell.tsx` and the keyed keeper, TerminalPage unchanged in behaviour; (3) `desk.ts`, `words.ts`, `status.ts`; (4) `TerminalWindow` (live, ended, off, tail view); (5) `FilesWindow`, `PointsWindow`; (6) `RoomPage` desk, Room bar, dock, phone layout; (7) `RoomStage`, Palette; (8) `tsc`, build, `npm test`, screenshots at 1440 and 390 in the three themes. Must not touch `workbench/backend/**`, `rooks-try/**`, `rooks-code/**`, `src/shell/**`, `src/ui/**` (a primitive change is a request to the orchestrator, not a lane edit).

**Lane T, terminal.** Owns `rooks-code/rooks_code/workroom.py`, `tui.py` (the `/help` lines and the status dot), `cli.py` (plain mode `/room` verbs if any), `rooks-code/tests/test_workroom.py`. Order: (1) the guard tests of 9.9, failing against the `fake_app` with the section 6 shapes; (2) `/room` listing terminals, `/room files`, `/room points`; (3) `/room open`, `/room tail`, `/room send`, `/room close`; (4) `/room save`, `/room back`, `/room handoff`; (5) `/room shell`; (6) `/help`, suite. Must not touch the app or `rooks-try`.

The orchestrator: merges the lanes, rebuilds `workbench/frontend/dist`, runs `./scripts/test-all.sh` (must end with "All passed."), captures screenshots, commits this record as `docs/design/0006-room-desktop.md`.

## 9. Tests first

Each test is written before the code and must fail on today's code for the reason given (AGENTS.md: a test that guards a fix fails on the old code first). Backend tests use the existing `client` and `room_home` fixtures of `tests/test_room.py` (in-process Room, a temporary `ROOKS_TRY_HOME`), skip on Windows, and never call a real provider.

### 9.1 `rooks-try/tests/test_room.py` (lane B)

1. `test_login_argv_is_a_login_shell_in_the_rooms_home`: `login_argv(home, False)` ends with `exec "${SHELL:-/bin/sh}" -l` inside the wrapper on Linux with namespaces, and is `["sh","-c",'cd "$1" && exec "${SHELL:-/bin/sh}" -l',"room",home]` without them. Fails today: `login_argv` does not exist (`AttributeError`).
2. `test_run_finds_a_tool_installed_in_the_rooms_local_bin`: write an executable `home/.local/bin/hello` printing `hi`; `ShellDriver().run("hello")` returns `stdout == "hi\n"`, code 0. Fails today: the host PATH has no `.local/bin` of the Room, code 127.
3. `test_run_reads_the_rooms_profile`: append `export GREETING=room` to `home/.profile`; `run('echo "$GREETING"')` prints `room`. Fails today: a non-login `sh -c` reads no profile.
4. `test_up_seeds_a_profile_only_when_missing`: after `up()`, `.profile` and `.zprofile` exist and contain `$HOME/.local/bin`; write `.profile` with `# mine` and call `up()` again: unchanged. Fails today: no file is written.
5. `test_room_env_keeps_the_rooms_bins_first_and_drops_secrets`: `room_env(home, False, base={"PATH": "/usr/bin", "OPENAI_API_KEY": "x", "FOO_TOKEN": "y"})["PATH"]` starts with `home/.local/bin:home/bin:home/.cargo/bin:`, and neither secret is present. Fails today: `room_env` does not exist.
6. `test_nested_terminal_argv_is_the_shared_login_shell`: `NestedDriver().terminal_argv(home) == login_argv(home, False)`; `QemuDriver().terminal_argv(home) is None`. Fails today: no `terminal_argv`.

### 9.2 `workbench/backend/tests/test_room_terminal.py` (lane B, new)

7. `test_a_room_terminal_outlives_its_socket_and_replays_its_text`: up; `POST /api/room/terminals` → id; connect the WS with the loopback headers of `test_app_terminal`; read the scrollback frame; send `echo marker-$((20+22))\n`; wait for `marker-42`; close the socket; connect again: the first frame is `{"type":"scrollback"}` and its `data` contains `marker-42`. Fails today: 404 on `POST /api/room/terminals`.
8. `test_the_shell_keeps_its_folder_and_variables_across_a_reattach`: send `cd Desktop; export K=1\n`, detach, reattach, send `pwd; echo $K\n`: output ends with `/Desktop` and `1`. Fails today: route missing.
9. `test_a_tool_installed_in_one_terminal_is_found_in_the_next_and_by_run`: in terminal 1 `mkdir -p ~/.local/bin && printf '#!/bin/sh\necho hi\n' > ~/.local/bin/hello && chmod +x ~/.local/bin/hello`; open terminal 2 and send `hello\n` → `hi`; `POST /api/room/run {"command":"hello"}` → `stdout == "hi\n"`. Fails today: route missing, and run gives 127.
10. `test_a_long_command_is_not_cut_off_in_a_terminal`: `POST /api/room/terminals {"command": "sleep 3; echo slow-done"}` with `RUN_MAX_S` monkeypatched to 1; `tail` after 4 s shows `slow-done`, `busy` false; `POST /api/room/run {"command":"sleep 3"}` with the same cap returns code 124 and its note. Fails today: route missing.
11. `test_tail_says_busy_and_the_exit_code_honestly`: start `sleep 2; false`; `tail` at once: `busy: true`, `exit_code: null`; after 3 s: `busy: false`, `exit_code: 1`. Fails today: route missing.
12. `test_stop_hangs_every_terminal_up_and_says_so`: two terminals; `POST /api/room/down` → `terminals_closed == 2`; status lists them `alive: false, ended_reason: "stop"`; their processes are gone (`os.kill(pid, 0)` raises). Fails today: `down` has no `terminals_closed`.
13. `test_start_over_closes_terminals_first_and_reopens_one`: save a point; open a terminal; `POST /api/room/reset` → `terminals_closed == 1`, `terminal.id` set, status has one alive terminal; `verified` still true. Fails today: no such keys.
14. `test_the_rooks_terminal_is_not_typed_into_until_taken`: start `sleep 5` as `rooks`; `send` → 409 with the plain line; `take {"owner":"person"}`; `send` → 200; `tail.taken` true. Fails today: routes missing.
15. `test_four_terminals_at_most_counted_apart_from_the_app_terminal`: open four → the fifth is 429 with the plain line; `terminal_pty._open` is untouched. Fails today: route missing.
16. `test_who_may_not_open_a_room_terminal`: not signed in → 4401; wrong origin → 4403; non-loopback peer → 4403; `app_terminal=0` → 4403; unknown id → 4404; the same table as `test_app_terminal::test_who_may_not_open_a_terminal`. Fails today: the WS path does not exist (404 on upgrade).
17. `test_terminal_rows_are_in_the_run_log_and_keystrokes_are_not`: open, send a line over the WS with the word `secret-sauce`, send `/send {"text": "echo api_key=abc"}`, close; run log rows: `open terminal`, `send` with the scrubbed preview (no `abc`), `used terminal`, `close terminal`; no row contains `secret-sauce`. Fails today: no rows at all.
18. `test_an_ended_terminal_is_listed_after_a_restart_with_its_log`: open a terminal, write marker, call `room_terminal.reset_for_tests()` (the module forgets its registry as a restart would), `load_ended()`; status lists it `alive: false, ended_reason: "restart"`; `tail` returns the marker. Fails today: module missing.
19. `test_the_chat_tool_starts_tails_and_lists_files`: `_use_room(action="start", command="echo from-chat")` returns `started: true`; `tail` returns `from-chat`; `files` returns the Desktop folder; the tool description mentions `start` and "more than a minute". Fails today: "The Room cannot do start."

### 9.3 `workbench/backend/tests/test_room.py` (lane B, added)

20. `test_files_lists_the_rooms_folder_on_or_off_and_never_outside`: write `home/Desktop/notes.txt` and a symlink `home/out -> /etc`; off: `GET /api/room/files` lists `Desktop` (folder) and `.profile`; `?path=Desktop` lists `notes.txt` with size 0 and a modified time; `?path=../` → 400; `?path=out` → 400 "That is outside the Room."; the `out` entry has `kind: "link"`. Fails today: 404 on the route.
21. `test_status_says_what_this_room_can_do`: shell driver on POSIX: `can == {"terminal": true, "files": true}`, `terminals == []`, `terminal_max == 4`; with `TRY_URL` (the `remote_room` fixture) `can == {"terminal": false, "files": false}`. Fails today: no `can`.
22. `test_the_120_second_note_points_to_a_terminal`: `room.RUN_MAX_S == 120` still; the 124 result's `note`/`error` says "start it in a Room terminal". Fails today: the words are "Timed out after …".

### 9.4 `workbench/backend/tests/test_terminal_reach.py` (lane B, changed)

23. `test_terminal_key_reaches_the_rooms_terminals_files_and_points`: with the Terminal access token: `GET terminals`, `POST terminals`, `GET tail`, `DELETE`, `GET files`, `POST checkpoint`, `POST reset`, `POST handoff` all answer (not 401); with a bridge key only the GETs do. `test_nothing_else_widens` lists these as the whole set. Fails today: 401 (routes on `room.router`) or 404.

### 9.5 `workbench/frontend/tests/room-desk.test.mjs` (lane F, new; runs the pure modules through esbuild as `workroom-room.test.mjs` does)

24. `windowsFor(status)` builds the window list from status: shell on → `["terminal","files","points"]`; nested on → `["screen","terminal","files","points"]`; `can.terminal` false → `commands` in place of `terminal`; `can.files` false → no `files`; `available: false` → `[]`; and `screen` never appears when `status.screen` is false whatever `localStorage` remembered (`readDesk` drops it). Fails today: `src/room/desk.ts` does not exist.
25. The words: `offLine` now says "The Room is off. Everything in it is kept." for a Room without a screen; `terminalLabel()` is "A shell inside the Room. What you install here stays."; `endedLine("restart")` is "The app restarted, so this terminal ended. Your files and anything you installed are still here."; `closeCount(2)` is "2 terminals will close."; `tailLine()` names "this computer"; the honest line is unchanged. Fails today: the functions do not exist and `offLine` says "Start it to run commands."
26. Source guards: `RoomPage.tsx` renders `TerminalSlot kind="room"`, a `role="toolbar"` dock whose buttons carry `aria-pressed`, and no `.glass`; `room.css` has no `backdrop-filter`, no hex literal, no `--color-primary` on the dock, and at most the `ui-fade` animation; `TerminalWindow.tsx` contains the skip link text "Skip the terminal", `attachCustomKeyEventHandler` handling `F6` only (no `Escape` branch), `screenReaderMode: true`, and the tail view posting to `/room/terminals/` + `/send`; `status.ts` reads `terminals` from the wire and never from `localStorage`. Fails today: files missing.
27. The keeper: `terminalHost.tsx` exports `TerminalSlot({kind})` and `RoomTerminalKeeper`; `App.tsx` mounts both keepers; `pages/TerminalPage.tsx` imports `Shell` from `../terminal/Shell`. Fails today: no `kind`, no `src/terminal/Shell.tsx`.

### 9.6 `workbench/frontend/tests/plain-screens.test.mjs` (lane F, changed)

28. "the Room never shows a fake screen" is kept and extended: the one `<img>` stays inside `RoomPicture`; the Screen window and dock item are gated by `windowsFor`; the only `--screen-*` use outside `TerminalWindow.tsx`'s terminal and tail view is none; the word "screen" does not appear in the Terminal window's labels. Fails today: the files it names do not exist.

### 9.7 Themes (lane F, the existing token ratio test)

29. `--screen-ink` on `--screen-bg` is AA (≥ 4.5) in the one `--screen` block; `room.css` resolves every colour through a token in light, dark and contrast (the class and token guards). Passes today for the ratio (the pair is unchanged) and is listed so it stays guarded; the `room.css` guard fails today because the new classes do not exist yet (it names them).

### 9.8 `workbench/frontend/tests/keyboard.test.mjs` (lane F, changed)

30. The palette lists `room-terminal` ("Open a terminal in the Room"), `room-point`, `room-over`, `room-files` beside `room-start` and `room-stop`. Fails today: the ids are absent.

### 9.9 `rooks-code/tests/test_workroom.py` (lane T)

31. `test_room_lists_terminals_and_the_honest_line`: `fake_app` status with two terminals → `/room` prints "Terminal 1 · yours", "Rooks · running" and the honest line. Fails today: terminals are not printed.
32. `test_room_files_points_and_open_tail_close`: `/room files Desktop` prints rows; `/room points` prints `before hermes · 7 Nov, 14:02`; `/room open echo hi` posts `{"name":"Rooks","command":"echo hi"}` and prints the started line; `/room tail` prints the lines and "ended with code 0"; `/room close Rooks` asks then DELETEs. Fails today: `/room files` prints the usage line.
33. `test_room_save_and_back_say_done_only_when_verified`: `/room save x` with `{verified: false}` prints the honest failure, with `{verified: true}` "Saved a point: x."; `/room back` asks first. Fails today: unknown verb.
34. `test_room_shell_runs_the_same_login_shell_or_says_where_it_is`: with `rooks_try` importable and a local app, `/room shell` calls `subprocess.call` with `login_argv(home, …)`; with a remote helper it prints "The Room's terminal opens in the app on this computer." Fails today: unknown verb.
35. `test_help_lists_the_room_verbs`: `/help` names open, tail, files, points, save, back, handoff, shell. Fails today.

## 10. Out of scope and open questions

Out of scope (follow-ups, each its own record or backlog line):

* The "Since you were here" line (new executables in the Room's bin folders, files changed, points saved, a `seen` marker) and an Activity window: the judges kept it as a later step; the Files window already shows that nothing was wiped.
* A read-only file preview in Files (`GET /api/room/files/read`).
* Helper mode terminals: `rooks-try serve` hosting the terminal registry and the app proxying the WebSocket; until then helper mode shows Commands with "A terminal needs the Room on this computer."
* Windows: a pseudo terminal through ConPTY (`terminal_pty` is POSIX only); Windows keeps the Commands window with a login Git bash.
* A shell inside a QEMU guest (serial or ssh console); until then a separate computer has no Terminal window and the Advanced sheet says so.
* `tmux` wrapping so shells survive an app restart; the greyed ended terminal and the restart note keep it honest without it.
* A live theme switch re-theming an open xterm (the Terminal page has the same gap).
* Relaxing the loopback rule for the WebSocket on a Room with `isolation: vm`.
* Recording click, drag, scroll, type and key steps in the run log (BACKLOG, from 0003 B2).

Open questions for the owner, with the default taken here:

1. Should the Room's terminals share the app terminal's "switched off in Settings" switch? Default: yes (one switch, "Terminals").
2. Should a Rooks-started command that is still running when the person presses Stop be refused with a confirm ("Rooks is still installing. Stop anyway?")? Default: no confirm; Stop closes it and the run log row says so.
3. Dotfiles in Files: shown last, or behind a "Show hidden files" toggle? Default: shown last (the seeded `.profile` must be visible).
4. The exit-code marker through `PROMPT_COMMAND`/`precmd` edits the Room's profile; a person who replaces the profile loses the "Done (code 0)" word and the assistant's `exit_code` (busy still works through the foreground process group). Acceptable, or should the server type a marker line after each started command (visible on screen)? Default: the profile marker.
5. On Linux without user namespaces (hardened distributions, containers) the login shell runs with `isolation: none` and the Room bar says "Not locked off"; should the page add one line explaining why? Default: no, the badge and the honest line already say it.

Risks carried from the designs, with the mitigation this record chooses: job control inside `unshare -Urm` on a pty (the nested xterm already runs it; if `setsid`/controlling tty fails, `login_argv` falls back to the plain argv and status reports `none`); a broken `.bashrc` an installer wrote breaks every new shell (the seed is defensive, Start over is one click away, and the ended state says the shell exited); replaying raw scrollback into a reset xterm when a full-screen program was open (the forced SIGWINCH redraws; a server-side state serializer is a follow-up if it proves ugly); memory (four 256 KiB rings, logs capped at 2 MB, ended panes disposed on Close); profile time and noise added to every assistant `run` (nothing stripped; the receipt shows it); Save a point copying a home while a program writes (the hint says files are copied as they are now).

## 11. After review (2026-11-08)

An adversarial review of the built branch (security, correctness, the screens) found defects; each was fixed with a test that failed first (`workbench/backend/tests/test_room_review.py`, `rooks-try/tests/test_room_safety.py`, `workbench/frontend/tests/room-review.test.mjs`). Where this record said otherwise above, this section wins.

* **PATH (4.2).** The Room's bins are never on the PATH used to start the Room: a tool planted as `~/.local/bin/unshare`, `setsid` or `sh` would have run outside the Room's isolation. The wrappers are absolute host paths (`shell.host_which`), and the Room's bins are put first only inside the wrapped shell, just before it execs.
* **Secrets (4.2).** `room_env` drops every name in `security.APP_SECRET_ENV` and the app terminal's pattern and app-only names (a backend test keeps the two lists in step), for quick runs, the private desktop and `/room shell`, not only the app's Room terminal.
* **Quick run (4.2).** `run` uses POSIX `sh -lc` (it reads `~/.profile`), whatever the person's login shell; the terminal keeps `$SHELL -l`.
* **Exit codes (4.1).** The marker carries a per-terminal nonce, so a command's output cannot fake its end. A command Rooks starts is one line (multi-line is refused in plain words), so its end is the right marker.
* **Logs (4.5, 3.7).** A terminal's text is kept in a private log on this computer (folder 0700, files 0600) until the terminal is closed or the Room starts over; a line sent at a prompt that hides typing is logged by its length only. Advanced says so.
* **The assistant does not read the person's terminal.** `use_room tail` reads only terminals Rooks started or the person handed over.
* **Words.** "Running in the Room's terminal" (not "Installing": not every command installs). Links say why: "link, leads outside the Room" or "link, leads nowhere". Status adds `can.terminal_off_reason` (`switched_off`, `helper`, `windows`) and `terminal_count` (what the cap of four counts, ended ones included).
* **Robustness.** Stop or Start over while a terminal opens leaves no shell; a shell that exits with a job still running ends its terminal; tail is plain text (no escape sequences reach the model or the person's terminal); a slow page gets a fresh scrollback frame instead of an unbounded queue; damaged records are skipped.
* **Screens.** 44 px touch targets for every Room verb; the switched-off state comes from status with a Settings link; the Stage's Start over names the terminals that close; one Save a point and one Start over on the Stage; the ended message once; a keyboard rename (F2 or Enter); Reconnect and "Use it here" after a lost or moved connection.
