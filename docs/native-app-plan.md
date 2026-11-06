# Rooks native app — plan

Status: draft for the owner. Nothing in this document is built. The app that ships today stays as it is until you accept a milestone.

This replaces the idea of restyling the current desktop window. That window is a website drawn inside a system web view. The rebuild is a new window, with its own UI, and no web view under it.

## Why the app that ships today feels like Chrome

The published Mac app (`AI Workspace`, built with Tauri, shipped as a `.dmg`) does **not** launch Google Chrome when you double-click it.

What it does:

1. Opens its own window.
2. Shows a splash that says **Desktop edition** and **AI Workspace**.
3. Starts the local Python server on `127.0.0.1`.
4. Points the window at that server and draws the same React site the browser uses.

On a Mac that drawing surface is WebKit (the same engine as Safari), not Google Chrome. On Windows it is WebView2, which is Microsoft's Chromium component. The pixels are still the website. The window title is still AI Workspace. That is why it feels like a Chrome app even when Chrome is not running.

There is a second path. The `ai-workspace` command, when the desktop app is missing or older than the install, opens **Google Chrome or Edge in app mode** on that same site. The one-command install uses this path. So some people really are in Chrome.

Odyssey (the live repo is [pewdiepie-archdaemon/odysseus](https://github.com/pewdiepie-archdaemon/odysseus); `PewDiePie/Odyssey` returns 404) is a useful product reference and a poor toolkit reference. It is a local Python server plus an HTML interface. "Native" there means "runs on this computer, not in Docker", so a Mac GPU can be used. The Mac app proposals around it are a Swift window around that same website, or around Docker. The soul to copy is local-first, on your own machine, no hosted Rooks. The UI to avoid is a browser page with a new frame.

## 1. Stack

**Choice: [iced](https://github.com/iced-rs/iced) (Rust).** One window, one UI codebase, Mac, Windows and Linux. The window is drawn by iced's own renderer (wgpu or tiny-skia). There is no Chrome, no WebKit web view, and no bundled Chromium in the app window.

The local Python server stays. It is already the brain: models, mail, memory, tasks, approvals, the terminal session, the browser agent, and the code agent. The new app is the face. It talks to that server on this computer only.

### Comparison

| Option | What the window actually is | Chrome or a web view in the app window | Mac, Windows and Linux from one UI | Fits a proprietary app | Fit for a workplace, not a chat site |
| --- | --- | --- | --- | --- | --- |
| **iced (chosen)** | Rust window, its own renderer | No | Yes | Yes. MIT or Apache-2.0 | Enough for real screens. We build lists, forms and the workplace ourselves. It will not look like AppKit. |
| Slint | Rust window, its own renderer (a Qt backend also exists; that backend is Qt, not a browser) | No, if we use the winit renderer | Yes | Only if you accept Slint's separate royalty-free desktop licence. The open-source build is GPL-3.0, which fights this repo's proprietary licence | Better forms and layout than iced. Stronger toolkit, blocked on the licence. |
| SwiftUI or AppKit | Real Mac controls | No | No. Windows would be a second UI (WinUI). Linux would be a third (GTK or another toolkit) | Yes | Best Mac feel. Three apps to keep in step for mail, tasks, terminal, browser and code. |
| egui | Rust window, immediate-mode renderer | No | Yes | Yes. MIT | Looks like a developer tool. Wrong feel for a personal assistant. |
| GPUI (Zed's toolkit) | Rust window, Zed's renderer | No | In principle | Unclear. It is part of Zed, not a supported toolkit, and Zed's licence would need its own reading | We would be maintaining a fork of Zed's internals. |
| Tauri (what ships now) | System web view: WebKit on Mac, WebView2 (Chromium) on Windows | Yes. Web view | Yes | Yes | The current site, in a frame. This is the thing you rejected. |
| Electron | Bundled Chromium | Yes. Chrome's engine is the app | Yes | Yes | A Chrome app by construction. |

### What "no Chrome" means here

The Rooks window does not load HTML, and it does not need Google Chrome installed.

Two honest limits:

- **The browser agent is a surface, not the foundation.** When you ask it to open a site and click, it still drives a real browser on the machine (today: Chrome, Edge, or a bundled Chromium through Playwright). A person cannot click a site without a browser. That browser is a tool the app starts. It is not the app's window. Milestone 1 makes that split visible: the workplace is iced; a browser job is a job with steps, a picture of the page, and a checkpoint.
- **Cloud models send the prompt you chose to send.** Files, keys and memory stay on this computer. A reply from OpenAI, Anthropic, Google or similar has left the machine because that is where that model runs. A model running on this computer (Ollama) does not. "Data never leaves" and "use any API key" cannot both be absolute. See the open questions.

### Cross-platform cost

iced is one UI for three operating systems. The cost is polish and a few Mac-only connectors, not a second rewrite.

- The window, menus, welcome, workplace, mail list, task list, and job panels are written once.
- The menu-bar icon and "always on" behaviour differ. macOS has a real status item. Windows has a tray. Linux depends on the desktop (some have no tray). The app still runs if the tray is missing.
- Apple Health can exist only on a Mac (HealthKit). The connector menu shows it on a Mac and says so on Windows and Linux. It is not a reason to make the whole app SwiftUI.
- Signing and installers stay a per-system job, as they are for the Tauri `.dmg`, `.msi` and AppImage today. iced does not remove that.
- A SwiftUI app would feel more at home on a Mac and would cost a second and third UI before Windows and Linux match. That cost is the whole product, repeated.

### Why not Slint, if the widgets are nicer

They are. Switch to Slint only after you accept their royalty-free desktop licence in writing. Until then, GPL-3.0 would pull the proprietary app with it. iced lets us start without that decision. If you accept the Slint licence before milestone 1 has much UI, we should switch then, not after the screens exist. The screens below do not depend on iced-specific tricks, so a switch at that point is a rewrite of layout code, not of the product.

### What happens to Tauri

It keeps shipping until a milestone replaces it. This plan does not delete it, and it does not restyle it. The React site stays for the phone and for anyone who already opens Rooks in a browser, until you decide otherwise (question 6).

## 2. UI structure

The window is a workplace. Chat is one way to give a task, not the home, and not the layout of Claude or ChatGPT (a transcript down the middle and a history rail).

On every launch the welcome screen is the first thing in the window. It says what this version is. It does not say "Desktop edition" or "AI Workspace". Proposed copy, until you change it:

> **Rooks**
> The new version we are building.
> A personal assistant on this computer. It takes a task, reads how a service works, and does the work. Mail, tasks, the terminal, the browser and code open inside this window.

Pressing Continue lands on the workplace. Closing the app and opening it again shows the welcome again.

### Menus that are always on screen

A left rail, present on every screen after welcome:

| Menu | What it is |
| --- | --- |
| **Workplace** | Home. What it noticed, what is open, what it will do next. |
| **Customize** | Name, voice, look, standing instructions, what it is allowed to do without asking. |
| **Skills** | Tricks it knows, the store, and ones you add. Same idea as today's Skills page, as a real screen. |
| **Connectors** | Every outside service and every MCP server. Pluggable. This is a primary menu, not a row inside Settings. |

Under those, quieter links, still in the same rail, not hidden in a "more" drawer:

| Group | Screens |
| --- | --- |
| Work | Mail, Calendar, Tasks, Files, Notes |
| Surfaces | Terminal, Browser, Code |
| Quiet | Memory, Approvals, Settings |

The terminal, the browser and code are things the workplace can open. They are not how the app is drawn.

### Screens and how they connect

```
Welcome (every launch)
  └─ Workplace
       ├─ a Task          the unit of work (see below)
       ├─ Customize       how Rooks behaves for you
       ├─ Skills          installed, store, add
       ├─ Connectors      API, MCP, or "open the site and click"
       ├─ Mail            inbox and drafts, from the mail already connected
       ├─ Calendar
       ├─ Tasks           your task list (a task you wrote, not only an agent job)
       ├─ Files           including PDFs
       ├─ Notes
       ├─ Terminal        a session on this computer
       ├─ Browser         a job on a site, with checkpoints
       ├─ Code            a job in a folder
       ├─ Memory          what it has learned, growing over time
       ├─ Approvals       every stop where it is waiting for you
       └─ Settings        account on this computer, folders, logs. Not the front door.
```

**Workplace.** The first screen after welcome. It shows three things, in this order:

1. The three core menus, as large entries (Customize, Skills, Connectors), not as icons buried in settings.
2. What it noticed since last time (new mail that needs a reply, something due, a connector that failed, a memory it now trusts). This is the initiative. It speaks before you ask.
3. Open work: tasks in progress, a browser job waiting at a checkpoint, a code job, a terminal still running.

From a notice you open the task it already drafted, or the mail, or the connector. You do not start in an empty chat box.

**A task.** This is the work surface, on purpose not a chat clone. A task has:

- What you asked, in one line.
- The services it decided to use (a connector, an MCP server, the browser, the terminal, or code).
- What it read (the docs, the endpoint, the page).
- The steps, in order, with a result on each.
- A stop wherever a checkpoint applies (below).
- The outcome, filed into memory when it is worth keeping.

A conversation can hang off a task when you need to correct it. The transcript is not the screen.

**Customize.** Look, voice, the assistant's name, standing instructions ("About you"), and the rules for when it may act. Changes apply in this window, and the terminal, browser and code agents read the same settings from the local server, as they do now.

**Skills.** Installed skills, the store, and add-from-a-project. A skill is a reusable way of doing a kind of task (inbox check, meeting prep, careful coding). The store can recommend from connectors you already turned on. Adding a skill still goes through the check that exists today (what it can touch, before it runs).

**Connectors.** One catalogue. Each connector declares how it talks:

| Kind | Examples | How the task uses it |
| --- | --- | --- |
| API | Google Workspace (mail, files, PDFs), any service with a key and docs | The task reads the docs, finds the endpoints, wires them, runs them. The key stays in the keychain on this computer. |
| MCP | Any MCP server you add | Shows up in this list once it is connected. Tools from that server are available to a task. Same permission check as today. |
| Site, no API | ServiceMate, and later others like it | The browser surface opens the site and clicks, the way you would. Checkpoints apply. There is no special-cased screen per site. |
| This Mac | Apple Health | HealthKit on a Mac only. Same menu. Other systems show that it is Mac-only. |

"Pluggable" means a connector is a record (name, kind, credentials, the docs or the site, the checkpoints), not a new page we write by hand for each company. The first ones we already have (mail, calendar, models, extra tools) become records in this list. Apple Health and ServiceMate are the proof that a new one does not need a new menu.

**Mail, Calendar, Tasks, Files, Notes.** Real screens on the local data you already have. Mail can draft; sending waits for you, as it does now. Files include PDFs you added. These are the work, not settings.

**Terminal.** A surface. Milestone 1 shows the live session from the terminal that already runs on this computer (the existing local terminal API), as text in the native window. A full terminal emulator (colours, full keyboard, scrollback like a dedicated app) is later, because it is its own product. The `rooks` command in a terminal you already have keeps working either way.

**Browser.** A surface. A job has a goal, the site, the steps, and a picture of where it is. It is not a web view of Rooks, and it is not a Chrome window pretending to be Rooks. Checkpoints are part of the job, not a preference buried in settings.

**Code.** A surface. A job in a folder, using Rooks or the code tools you already connected (Claude Code, Codex). The native window shows the job, the files it wants to change, and the approval. The code agent is not the shell of the app.

**Memory.** A screen of what it has learned, where it learned it, and what it used that for. It gets longer as you work. A task can file a fact here. Customize can forget one. This is the compounding memory, not a hidden prompt prefix.

**Approvals.** One inbox for every stop: send this mail, run this command, pass this checkpoint on a site, install this skill. If it is waiting, it is here, and on the workplace home.

**Settings.** The quiet screen: this computer's lock, data folder, logs, advanced tools. Connectors do not live only here.

### Browser agent: checkpoints and rules

The browser agent may do what you could do by hand on a site you are allowed to use. The design has these stops, and they are not optional:

1. **Before a sign-in.** It opens the site's own sign-in and waits. You sign in. It does not type a password it invented, and it does not create a pile of accounts.
2. **Before it sends, posts, pays, deletes, or downloads.** It stops, shows the site and the exact step, and waits for Continue or Stop.
3. **Before it leaves the path you named.** If the goal was "check my ServiceMate jobs" and the next click is a different site or a settings change, it stops.
4. **When a site refuses.** A block, a captcha, or a rate limit is a stop, shown to you. The agent does not try to dodge it.

Out of scope, and not a feature we will add: mass account creation, bulk sign-ups, and bypassing a site's account or anti-abuse rules. A task that asks for that is refused in plain language, with no workaround steps.

Legal use only. The agent works in accounts and sites you are allowed to use.

ServiceMate is the model for "no API". You connect it once (the site, and that you will sign in yourself). A task then uses the browser surface. The same checkpoints apply. We do not pretend ServiceMate has an API.

### Initiative and memory, in the product

Initiative is the workplace home, not a notification spam setting. On launch, after welcome, Rooks shows what changed. You did not have to ask "anything new?".

Memory is the Memory screen plus a line on the finished task: "Filed: …". The next task can use it. Nothing is filed to a server of ours. There is no hosted Rooks.

### Always on

The app starts the local server when it opens, and can keep that server running when the window is closed (menu bar or tray where the system has one). Quit from the menu stops the server. Data stays in the same folder the app uses now (`com.inclined88888.aiworkspace`), so an old install is not stranded. The visible name becomes Rooks. The folder id stays, unless you want a clean break (question 8).

### Limits

The soul you described has no artificial caps and no paywall. The licence file and the current Plan screen still describe Free, Pro, Team and Business. This plan does not rip those out in secret. Question 2 decides which one is true before we build the workplace, because a paywall screen would change the home.

## 3. First milestone

A shippable window you can install beside the current app, not a sketch and not the full workplace.

### In scope

- A new Rust app, `desktop/rooks-native`, using iced. Its dependencies do not include Tauri, Wry, WebKit, or Electron.
- Its own window. Title **Rooks**. No splash that says Desktop edition or AI Workspace.
- Welcome on every launch, with the copy in section 2 (or the copy you pick in question 1).
- The rail: Workplace, Customize, Skills, Connectors, then Mail, Tasks, Terminal, Browser, Code.
- Workplace home: the three core menus, a short "noticed" list from data the server already has (due tasks, and mail if mail is connected), and open jobs if the server reports any.
- Customize, Skills and Connectors as real screens. They read and write the APIs that exist today (appearance and assistant settings, the skills store, connectors, MCP servers). They are usable, not links that pop the old website.
- Thin doors to the five surfaces, all inside this window:
  - **Mail** — list and open a message the server already stores. Sending still asks you.
  - **Tasks** — list, add, complete.
  - **Terminal** — attach to the existing local terminal session and show its text. Start one if none is running.
  - **Browser** — list browser jobs and show a waiting checkpoint with Continue and Stop. Starting a job uses the existing browser agent. The window does not become a browser.
  - **Code** — list code jobs and open one, including the approval if the server is waiting.
- The app starts the existing local server if it is not already running, and talks only to `127.0.0.1`.
- Tests:
  - Welcome and window title do not contain "Desktop edition" or "AI Workspace".
  - The rail lists Customize, Skills and Connectors.
  - The crate does not depend on a web view.
  - Mail list, task list, and a checkpoint button behave against a fake local server (no live provider, no real site).

### Out of scope for this milestone

- Apple Health, ServiceMate, and a general "read any API's docs and wire it" runner. The task screen and the connector record are designed above so those have a place. They are the next milestone, not this one.
- Rebuilding every current page (team, meetings, fine-tune, phone pairing, and the rest). They stay in the current server and the current site until each one is moved.
- A full terminal emulator.
- Replacing the Tauri `.dmg` on the release line. This milestone produces a build you can run. It does not retire the old app.
- Deleting the React UI, the phone app, or the `rooks` / `rooks-browser` / `rooks-desk` commands.
- New paywall behaviour. Left alone until question 2.

### How today's features carry over

| Feature | This milestone | Later |
| --- | --- | --- |
| Mail | Native list and reader on the current mail API | Drafting polish, every provider, Apple Mail prompts under the Rooks name |
| Tasks | Native list on the current tasks API | Tasks that the agent files from a job, on the workplace |
| Terminal | Live text from the current local terminal | Full emulator, if you still want one inside the window |
| Browser | Jobs and checkpoints in the native window. The agent is still the existing browser agent | ServiceMate and other no-API sites as connector records |
| Code | Jobs and approvals in the native window. The agent is still `rooks` and the code tools you connected | The task screen drives code without a separate "code product" look |
| Skills, customize, connectors | Native screens on the current APIs | New connector kinds (Health, site-only) as data, not new menus |
| The old desktop app | Still shipped | Removed only when you say this window replaces it |

The other surfaces become ways into this app: a terminal, a browser job, and a code job show up on the workplace, and the commands you already run keep talking to the same local server.

### Effort

This is a new crate and a new window, beside `desktop/src-tauri`, not a patch on it.

- The window, welcome, rail and five thin screens are the milestone. Each thin screen is a list plus one action, on an API that already exists.
- The server, database, keychain, mail sync, browser agent and code agent stay. We do not rewrite them to get the window.
- The risky pieces inside the milestone are the terminal text attach (a websocket, not a web view) and the browser checkpoint buttons (they must call the same approval the agent already waits on, or they are fake).
- The full rebuild after this is one screen at a time from section 2. The large pieces after the milestone are the task runner ("read the docs, find the endpoints, wire them"), the site-only connector, and Apple Health on Mac.

No calendar estimate. The milestone is small enough to install and click. The rest of section 2 is the product, and it is a rebuild of the current frontend's surface area (on the order of the pages under `workbench/frontend/src/pages`).

### How you will know it is real

You open Rooks. You see the new welcome, then the workplace, with Customize, Skills and Connectors in the rail. You open mail, tasks, a terminal session, a browser job and a code job without a Chrome window and without the old site. A test fails if a web view crate is added, or if the old welcome words come back.

## 4. Open questions

1. **Welcome words.** Is the copy in section 2 the one you want on every launch, or do you want different lines?
2. **Paywalls.** The soul says no caps and no paywall. The licence and the Plan screen still have Free, Pro, Team and Business. Which one should the new app follow?
3. **Data never leaves, and API keys.** Keys and files stay here. A cloud model still receives the prompt. Should the new app allow cloud models, local models only, or both, with the workplace saying which it is using?
4. **Slint.** If you accept Slint's royalty-free desktop licence, we should switch before the screens pile up. If you do not, we stay on iced. Do you want that licence read before milestone 1 starts?
5. **Mac-only look.** iced will not feel like a SwiftUI app. If Mac feel matters more than Windows and Linux shipping from the same UI, say so. That choice is SwiftUI, and Windows and Linux wait.
6. **The current website and the phone.** Should the React site and the phone app keep working against the same server while the native window is built? This plan assumes yes.
7. **The browser tool.** Confirm the browser agent may keep driving Chrome, Edge, or Chromium as a tool, while the Rooks window itself never is a browser.
8. **App name and old data.** The window and the menu should say Rooks. Keeping the current data folder id preserves existing mail and settings. Do you want that, or a new folder and a one-time import?
9. **ServiceMate.** Whose account, which site address, and which actions are in the first site-only connector (read jobs only, or also update a job)? Updating a job would stop at a checkpoint either way.
10. **Apple Health.** Which facts should a task be allowed to read (steps, sleep, workouts)? Writing back to Health is a separate, stricter permission. Confirm Mac-only is acceptable.
11. **Always on.** When you close the window, should the local server keep running (menu bar), or should quit mean everything stops?
12. **The old `.dmg`.** Leave it on the release page until this window replaces it? This plan assumes yes. No new `.dmg` is part of this draft.
