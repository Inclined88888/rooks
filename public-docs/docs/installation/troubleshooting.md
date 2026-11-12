---
title: Troubleshooting
sidebar_position: 10
---

| Symptom | Check | Next action |
| --- | --- | --- |
| Mission fails with a missing executable | CLI location and service PATH | Pin its path in **Settings → AI models → Providers → CLI binaries** (applies without a restart), or click **Check again** after installing it (during setup: **Re-detect** in the Prerequisites panel) |
| CLI launches but authentication fails | Sign-in under the daemon's OS account | Authenticate the CLI directly, then retry a small mission |
| Mission fails before producing output | Agent's working directory | Use an existing absolute host path accessible to the daemon |
| UI cannot reach the daemon | Address, port and authentication | Compare the app's daemon URL with the actual listener |
| Web interface does not open from another computer or phone | It listens on the loopback by default | See [Remote access to the web interface](remote-access.md) |
| Address already in use | Host app and Compose app both enabled | Keep one web-app serving mode |
| Configuration rejected | Error names a key | Correct that key or restore the last working file |
| Plugin visible but refused | Reason on its gallery card | Check API version, licence and signature; repeatedly toggling cannot fix admission |
| Feature or model missing | Host capabilities, enabled plugins and backend catalogue | Inspect `rooks doctor`, `rooks module list` and `rooks backends` |
| Scheduled task did not run overnight | Whether the computer slept, and `rooks service status` | Turn off automatic sleep; see [Running in the background](background.md) |
| Rooks takes a minute to open on a work PC, or shows "Checking the installation…" | Antivirus scanning every file Rooks reads | Exclude the Rooks folders from real-time scanning; see [Slow start behind an antivirus](#slow-start-behind-an-antivirus) |
| Windows installer says Rooks cannot be closed | Whether you allowed the permission prompt when the installer opened | Choose **Quit and stop the background service** in the tray icon menu before installing; or, in an administrator PowerShell, run `schtasks /End /TN RooksOrchestrator; Stop-Process -Name Rooks -Force`, then choose Retry |
| Quota state unavailable | Whether the backend has a working usage probe | Treat unknown as unknown, not as zero usage |
| Anything else, or you need help | The diagnostic report | **Copy diagnostic** and paste it in your support request; see below |

## Diagnostic report and logs

When something goes wrong, send the **diagnostic report** with your support request rather than describing your setup: it holds what support asks for first.

**Where to get it**

- **Error boxes of the desktop app** (an update that fails, "The Rooks daemon does not answer", a daemon that keeps crashing…): **Copy diagnostic**, **Save report** and **Open logs folder**. The box stays open until you click **OK**, so you can paste first. On Linux, paste before clicking OK: the clipboard empties when Rooks quits. **Save report** always works and shows where the file was written.
- **Settings › System › Installation** (superadmin): **Support diagnostic**, with the same buttons and **Show report**.
- **The tray or menu bar icon**: **Support diagnostic…**.
- **A terminal**: `rooks doctor --report` prints it, `rooks doctor --report --save report.txt` writes it to a file. It works while the daemon is stopped.

**What it contains**: the versions of the app, the daemon and your data; the operating system and, on Windows, whether the computer is joined to a work domain or Microsoft Entra ID; how the daemon runs (background service or inside the app), what answers on its port; the state of the background service and its last run; the problems Rooks recognises (a service installed without the app's marker, a Windows task that never ran, data last opened by an older version, a port held by another program, a Rooks background service left behind for a data directory that no longer exists, with the commands that remove it); and the last 100 lines of each log, **newest first**. Tokens, keys, passwords and e-mail addresses are masked; read it before posting it publicly if you want to. Licence: only its edition and status.

**Logs**: one file per day in the `tmp` folder of the Rooks data directory (`~/.rooks/tmp/` on Linux and macOS, `%USERPROFILE%\.rooks\tmp\` on Windows): `daemon-<date>.log` for the daemon, `desktop-<date>.log` for the desktop app. Every line starts with the local date and time. Inside a file, lines are in the order they were written, newest at the end; the report, the settings and `rooks logs` show them newest first. Files older than 14 days are deleted, and the oldest go first past 200 MB in total: change it with the **Log retention** and **Log size ceiling** settings (type *log* in the settings search), or `ROOKS_LOG_RETENTION_DAYS` and `ROOKS_LOG_MAX_MB`. `rooks logs` shows the last 100 daemon lines (`--desktop` for the app, `-n 300` for more).

## Reading a 403 refusal

When the CLI or an MCP agent is refused with HTTP 403, the response explains
itself instead of a bare `forbidden`. The body carries:

- `code` — a stable, machine-readable code (`operator_only`, `account_lacks_permission`, `not_in_mission_cap`, `mission_without_owner`, `override_denied`, `out_of_scope`, `explicitly_denied`, `account_required`).
- `permission` — the permission that was missing, or `null` when the route is operator-only.
- `reason` — a short sentence for a human.
- `hint` — the concrete next step (ask an administrator, run it from the UI, …).
- `caller` — what was refused: `mission`, `session` or `operator`. It never names an account.

`not_in_mission_cap` means a mission token can never carry that permission: do
the action from the UI, or ask the account owner to run it with the CLI outside
a mission. `account_lacks_permission` means an administrator can grant the
missing permission to your role. `mission_without_owner` means the mission is
not attached to any account: relaunch it from your account. `operator_only` is reserved to the operator and
is not reachable from a mission. `out_of_scope` means the request names something
your mission or session does not cover (another mission, another person's
account): act on your own, or ask the operator. `explicitly_denied` means your
role denies that permission on purpose (agent-to-agent messages, for one): only
an administrator can lift it. A message between two agents of different teams
is refused with `out_of_scope` and names both agents.

## Windows blocks the installer (Smart App Control)

The installer is not signed yet, so Windows **Smart App Control** can block it. Workaround: turn Smart App Control off in **Windows Security**, then run the installer. (TIM-0034)

## Notification area icon could not be loaded

If Rooks reports that its notification area icon could not be loaded, reinstall
Rooks to restore it. The window remains usable without the tray icon; closing
it quits the desktop app. A daemon running as a service stays running, while
a daemon running in portable mode stops with the app.

## Forgot your password

**Forgot password** on the sign-in screen sends a 6-digit code to the e-mail address of your account. Type the code, then your new password twice. Resetting a password signs that account out everywhere. It needs an internet connection, and works only if your address was confirmed when the account was created; if no code arrives within a few minutes, use one of the ways below.

Codes are limited to a few per address and per network in a quarter of an hour. If Rooks answers that too many codes were requested, wait the time it shows before asking again.

When e-mail cannot help, the password is reset by someone who controls the installation:

- **You are not the administrator.** Ask an administrator to reset your password from the **Team** page of the Multi-user plugin. They hand you a temporary password; sign in with it and change it from your account.
- **You are the administrator.** Open a terminal on the computer where Rooks runs and use your own e-mail address:

  ```bash
  rooks user reset-password you@example.com
  ```

  The command prints a temporary password once. Resetting a password signs that account out everywhere.

## Collect a useful diagnostic

```bash
rooks doctor --json
rooks service status
rooks app status
rooks plugin list
```

For a failed mission, retain its ID and error message. Remove tokens, secret values and personal paths before sharing logs. Never post `daemon-token`, a backend authentication file or the entire Rooks data directory.

A container reaching `host.docker.internal` is using the bridge address; it cannot assume access to a listener bound only to host loopback. Check the [Docker setup](docker.md) before changing authentication settings.

## An agent shows "thinking" and never answers (TIM-0049)

When a backend CLI ends a turn without answering, the chat shows a notice with its exit code, the end of what it wrote on stderr, and the mission and session ids. An access refusal, an expired sign-in or an organisation policy usually appears there in clear text.

- **GitHub Copilot:** run `copilot` in a terminal and sign in again if asked; an *Access denied by policy settings* message comes from your organisation, not from Rooks (see [GitHub Copilot](../usage/github-copilot.md)).
- **Another backend:** run its CLI by hand in a terminal to see the same message, or switch the agent to another backend to confirm the problem is the provider's.
- **Reporting it:** give the mission id from the notice. The session id, when shown, is the one to look for in the provider's own logs. Remove tokens and personal paths first.

## "Unable to find the main agent" (TIM-0079)

The chat opens your main agent when no agent is named in the address. When it cannot, the screen says why:

- **The agent list could not be read:** the daemon is not reachable, or refused the request (the HTTP code is shown). Check that Rooks is running, then **Retry**.
- **No agent is designated as the main agent:** each orchestrator without a project is listed with a **Make … the main agent** button. Pick the one you talk to; the chat opens it. Designating needs the right to manage agents. The same choice is in the right-click menu of an agent's avatar (**Set as main orchestrator**).
- **No cross-project orchestrator:** create one from **Open agents**, or give the orchestrator role to an agent without a project.

`rooks doctor` prints a `main orchestrator` line: the agent that holds the seat, or `NONE` with the eligible orchestrators. While the seat is empty, recaps and notifications addressed to the main orchestrator have no recipient, and the notification centre shows **No main orchestrator** once.

When reporting it, include the line the screen shows.

## Unexpected end of input on macOS (TIM-0011)

This report remains under investigation. A successful HTTP status alone does
not prove that a script or JSON response is complete. Empty or malformed
sign-in state responses now report `[TIM-0011]`, the endpoint and HTTP status
in the renderer console.

For the packaged desktop app, quit Rooks completely, then launch a build
containing the renderer diagnostic from Terminal:

```bash
ROOKS_RENDERER_DIAGNOSTICS=1 /Applications/Rooks.app/Contents/MacOS/Rooks > "$TMPDIR/rooks-renderer.log" 2>&1
```

Leave developer tools closed during capture: opening them can detach the
diagnostic session. Wait for the page to load, reload once with **Cmd+R**, then
visit a failing page. Quit Rooks and extract the diagnostic records:

```bash
grep '"diagnostic":"TIM-0011"' "$TMPDIR/rooks-renderer.log" > "$TMPDIR/rooks-renderer-diagnostic.jsonl"
```

Send the extracted file, installed version/build SHA, page name and reproduction
steps to support. Look for `ready` before the reload; `attach-failed`,
`enable-failed` or `detached` means collection was unavailable or interrupted.
The record limit is 5,000 per window (1,000 successful script records and up to
30 failed-source fingerprints). Relaunch for another capture.

The trace records script IDs, lengths, SHA-256 fingerprints of failed sources,
stack locations, isolated execution contexts, HTTP statuses, MIME types and
transferred sizes. It does not record source text, response bodies, cookies,
headers, exception descriptions, URL query strings or local file paths.
Non-bundle URL paths are redacted. Script IDs connect parser failures to stack
locations; line and column numbers are zero-based. A `script-failed` record
identifies a parser failure, while a runtime `exception` can identify a JSON
parse caller. No source contents are saved, so a fingerprint may still need
comparison with the exact installed build. Worker targets are not collected.

Nothing is uploaded automatically. Normal launches without
`ROOKS_RENDERER_DIAGNOSTICS=1` disable this capture. Delete the temporary logs
when finished; the unfiltered log can contain unrelated application output.

## Agent editor does not accept typing (TIM-0021)

This Windows report is fixed. If the Name field ever stops accepting typing
again and support asks for a focus trace, close the agent editor, open the desktop developer tools
(`Ctrl+Shift+I` on Windows), select **Console**, and run:

```js
sessionStorage.setItem('rooks:diagnostic:agent-editor', '1')
```

Open **Agents → New agent**, click **Name**, type a short test name, then try
Tab and the other fields. Filter the console by `[TIM-0021]` and copy those
lines for support. If the shortcut does not open developer tools, report that
to support. Note the installed version, Windows display scaling, and whether
the issue also happens with the browser panel closed. The trace records element
types, focus, hit testing and the name's length, never field contents or typed
characters. Nothing is sent automatically. Collection stops after 150 records
per editor opening; reopen it for another attempt.

To disable collection, close the editor and run:

```js
sessionStorage.removeItem('rooks:diagnostic:agent-editor')
```

The flag belongs to the current window session. No diagnostic is collected
unless explicitly enabled.

## Codex is not connected

Run `codex login` under the same OS account that runs Rooks, then retry your
message. Setup displays a sign-in warning and lets you check again after login.
`rooks doctor` shows the credentials path checked by the daemon:
`CODEX_AUTH_DIR/auth.json` when configured, otherwise `.codex/auth.json` in
that account's home. If you signed in under a different home, configure
`CODEX_AUTH_DIR` for the daemon to point to the directory containing that file.

Rooks needs a readable authentication file for subscription login. If your CLI
stores credentials only in the OS keyring, sign in with file storage (the same
command works in Bash, zsh, PowerShell and the Command Prompt):

```bash
codex -c cli_auth_credentials_store=file login
```

An existing `CODEX_API_KEY` or `OPENAI_API_KEY` also allows launch when stored
in Rooks's secrets vault in inject mode and granted to the agent (or its project).
A daemon environment key is available to missions only with the explicit
`secrets.inheritEnv` setting enabled; this setting inherits the entire daemon
environment. A variable set only in your terminal may not reach a service or
desktop application. Setup and the diagnostic check the main agent's access. The diagnostic checks local credential availability; it
does not contact the provider or verify whether a session has expired.

## Codex fails with "env: node: No such file or directory"

Codex installed with npm runs on Node.js. Rooks launches it with the folder it
was found in and with the Node.js it finds on the machine (nvm, Volta,
nvm-windows, Homebrew, `~/.local/bin`, the PATH). When none is found,
`rooks doctor` and the diagnostic report name the CLI: install Node.js.

The same Node.js runs Rooks's own tools inside a Claude session: without it,
Claude reports that `mcp__rooks_ask__request` was not found.

## Codex on Windows: commands "blocked by policy" (TIM-0062)

On Windows, a Codex agent in read-only (plan) or workspace-write mode runs its
shell commands inside Codex's own Windows sandbox. Rooks starts every Codex
mission with the **unelevated** sandbox, whatever `[windows] sandbox` says in
your own `~/.codex/config.toml`: it needs no administrator rights, shows no
UAC prompt, and leaves the sandbox accounts of your own Codex untouched.

If a mission still reports `blocked by policy` or a `CreateProcess` error,
update Codex (`npm install -g @openai/codex`) and collect a diagnostic (see
above). Do not switch the agent to full access to work around it: that removes
the sandbox instead of fixing it.

## Codex on Windows: a Kanban task cannot commit (TIM-0121)

In auto or acceptEdits mode, a Codex agent works in Codex's workspace-write
sandbox. On Windows that sandbox keeps the repository's `.git` folder read-only:
the agent edits the files of its task, then `git commit` is refused. A `code` or
`merge` task needs to commit, so on Windows give those tasks to Codex in
**bypassPermissions** mode (full access: no sandbox), or run them on another
backend, for example with `rooks series role set --scope code --backend claude`.

Review and merge do not follow the coder: a series role or a task override
changes one task type only. When you move the coder off Codex, move `review`
and `merge` too (`--scope review`, `--scope merge`). If a review or a merge
then blocks on a sandbox failure while its code ran on another backend, the
"Task blocked" notification says so and gives these two commands.

## Windows: Rooks does not start after a password change (TIM-0107)

Rooks's background task waits for a small file in `%USERPROFILE%\.rooks\run` that only your Windows account can open. Resetting the account password, or rebuilding the profile, can make it unreadable: the task shows **Running**, but Rooks never answers and `daemon.log` keeps saying `waiting for the first logon since boot`.

Opening the Rooks app repairs it by itself. Without the app, run `rooks service repair` in a normal (not administrator) terminal, signed in as the same user. `rooks service status` says whether the file opens (`session witness: opens`) and, when it does not, why (`cause: …`); a service installed by this version also writes that cause once to `daemon.log`, before `waiting for the first logon since boot`.

## The daemon keeps restarting with "disk I/O error" (TIM-0109)

Rooks could not read or write its database: the disk is full, read-only or returning errors. The daemon log (`~/.rooks/tmp/daemon-<date>.log`) has a `[storage]` line with the database path and the free space left; the daemon then waits a minute and its supervisor starts it again. This holds whether the disk fails at startup or while Rooks is already running.

Free some space on the disk that holds `~/.rooks` (`rooks doctor` shows `free disk space`), and check the system log for disk errors. Rooks starts again by itself once the disk works. On Linux, the restarts are spaced out up to 5 minutes; `systemctl --user restart rooks-desktop-…` (the unit `rooks service status` names) retries at once.

## Docker: "network … not found" when starting a project's containers (TIM-0104)

The containers were created on a Docker network that no longer exists. **Start** recreates them with `docker compose up -d` on the networks of the project's current Compose file. If the error persists, the Compose file still refers to the missing network: correct it, then click **Rebuild** in the Docker widget. When the Compose file has moved or been deleted, run `docker compose up -d` yourself in the project directory.

## Web app stops during startup

When the web app port is occupied, Rooks waits for it to be released: it
checks again after a few seconds, then every 30 seconds for as long as it
takes, and starts the web app as soon as the port is free. After about a
minute it raises one alert, "The web app stopped starting"; it does not repeat
it. The daemon log includes the address and, when the operating system tools
are available, the listener PID. Rooks does not terminate or adopt an
unidentified listener. Close a previous Rooks instance or the conflicting
application, or change `app.listen.port` (then relaunch Rooks).

A clean exit (code 0 without a signal) receives up to two automatic retries
with backoff during a supervision session. A third clean exit stops automatic
restarts and produces an alert. A crash still receives bounded retries. Include the exit code,
signal and preceding startup logs when reporting either problem. A rebuild
is only suggested when the app build is missing or incomplete; packaged
users should reinstall a complete package in that case.

Once the cause is fixed, the web app starts again without restarting the
daemon, so running missions keep going: reopen the desktop app (it does this
by itself when the interface does not answer), or run `rooks app restart`
in a terminal on the machine that runs Rooks.

## The desktop says the daemon does not answer, yet it is starting

A packaged daemon verifies its installation, loads its plugins and checks each provider before it listens. On a managed work PC (antivirus scanning every file, a Microsoft Entra profile), that can take two or three minutes. Since the version that follows 0.1.5, the desktop waits up to three minutes for the background service, five minutes after an update, and says "still starting" rather than reporting a failed update.

If the window stays empty after that: run the support diagnostic (tray icon). Its **Daemon** block says whether nothing listens on the port (the daemon is down: read the end of `daemon.log`), or whether a Rooks process holds the port without replying (it is still starting, or busy: wait, then open the window again from the tray). Adding the Rooks folders to the antivirus exclusions shortens the start: see [Slow start behind an antivirus](#slow-start-behind-an-antivirus).

## Slow start behind an antivirus

At every launch, the desktop app checks that the files of its installation are intact before it starts anything, and the background service does the same when it starts. Each file is read in full: an antivirus that scans every read can stretch this to a minute on a managed work PC. Since the version that follows 0.1.5, a small **Checking the installation…** window shows while it runs, instead of an app that seems frozen.

Excluding the Rooks folders from real-time scanning shortens the start. The check itself still runs on every launch.

| Folder | What it holds |
| --- | --- |
| The installation folder: `%LOCALAPPDATA%\Programs\Rooks` by default, `C:\Program Files\Rooks` for an installation for all users, or the folder you chose in the installer | The app and its daemon |
| `%USERPROFILE%\.rooks` | Your data, and the copy of the daemon the background service runs |

With Microsoft Defender: **Windows Security › Virus & threat protection › Manage settings › Exclusions › Add or remove exclusions › Add an exclusion › Folder**, once per folder. On a PC managed by your organisation, exclusions are usually set by the IT department: send them these two folders. On macOS and Linux, the same applies to a third-party antivirus: exclude `Rooks.app` (or `/opt/Rooks`) and `~/.rooks`.

## Windows: updating while the background service runs

The installer pauses the `RooksOrchestrator` task and ends its daemon before replacing the files, with the Windows permission prompt when it is granted and without it otherwise. If an older installer left Rooks failing at launch (for example "ffmpeg.dll was not found"), close every `Rooks.exe` from Task Manager, run the installer again, then start the task from Task Scheduler or reopen Rooks.

## The LLM quotas widget says Codex is not signed in

The Codex gauge reads the sign-in the Codex CLI saved on this machine (`~/.codex/auth.json`, or the folder `CODEX_AUTH_DIR` names) and never renews it itself. When that sign-in is missing, unreadable, expired or refused by OpenAI, the widget shows Codex as not signed in instead of an error.

- Run `codex login` in a terminal, as the user that runs Rooks, then press ↻ on the widget. A Codex mission also renews an expired session on its own.
- If your Codex configuration keeps the sign-in in the system keyring (`cli_auth_credentials_store = "keyring"` or `"auto"`), Rooks cannot use it, for missions or for the gauge: sign in with `codex -c cli_auth_credentials_store=file login` instead.
