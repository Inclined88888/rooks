---
title: Windows
sidebar_position: 5
---

## One command

In PowerShell (Windows PowerShell or PowerShell 7):

```powershell
irm https://rooks.local/install.ps1 | iex
```

It downloads the Rooks installer, checks it, and opens it: the installer then runs as described below. Run it in your desktop session, not over SSH: the installer window would open where nobody can see it, so the command refuses unless you add `-Silent`. Options and checks: [Install with one command](overview.md#install-with-one-command).

## Desktop installer

Run the supplied Rooks NSIS installer, choose its installation directory and open Rooks. If Node.js or Git is missing, the installer installs Node.js (LTS) and Git for Windows with `winget`, after one Windows permission prompt; this can take a few minutes. If that fails or you decline, the setup screen offers them again.

At first run it registers the daemon as the **`RooksOrchestrator` scheduled task**, which asks for the Windows permission prompt once. The task starts at boot and keeps Rooks running after you sign out, using your own account without storing its password. It runs with your standard privileges, not as administrator. This is not a Windows NT service and does not require an administrator service wrapper. Rooks uses a scheduled task rather than a service on purpose: a service runs under a system account, or needs your password stored to run as you, and would not find the sign-ins of your AI tools (`claude`, `codex`…) kept in your user folder; the task runs as you, with your folder and your sign-ins, without storing a password.

If the task is missing at launch, for example after Rooks was uninstalled and reinstalled, or after you deleted it from Task Scheduler or PowerShell, Rooks offers to reinstall it, with one Windows permission prompt. Until you accept, Rooks runs only while its window is open. If you choose **Not now**, Rooks asks again after the next update.

On some work or school accounts — typically a PC joined to Microsoft Entra ID — Windows registers the task but never starts it while you are signed out. Rooks checks that the task really started; when it did not, it removes it (or, at a later launch, leaves it unused), tells you, and runs its built-in daemon instead. Rooks then works while its window is open and stops when you close it or sign out. To remove an unused task yourself, run `rooks service uninstall` and allow the permission prompt.

After Windows restarts, Rooks waits for you to sign in once before it starts: your CLI backends need the credentials that Windows only unlocks at sign-in. After that first sign-in, you can sign out and Rooks keeps running. If the machine must run agents overnight, enable automatic sign-in or sign in after each restart, and turn off sleep: no scheduled task runs while Windows sleeps. See [Running in the background](background.md) for what missions cannot reach while you are signed out.

The daemon writes its log to `%USERPROFILE%\.rooks\tmp\daemon-<date>.log`, one file per day; the background task's own messages, and anything printed before the daemon starts, go to `daemon.log` in the same folder (at each start, a `daemon.log` larger than 10 MB is moved to `daemon.log.1`). `%USERPROFILE%` is your user folder, `C:\Users\<user>`; [Where Rooks keeps its files](configuration.md#where-rooks-keeps-its-files) lists the other locations, and [Troubleshooting](troubleshooting.md#diagnostic-report-and-logs) explains how to send them.

When Rooks is already installed, the installer asks for the Windows permission prompt as it opens: it pauses the background task while it replaces the files, and starts it again when the installer closes. The first launch after an update may ask once more, to update the task. Then approve the update in Rooks's window; see [Upgrading](upgrading.md).

Follow [First run](first-run.md). Install and sign in to your CLI backend under the same Windows account. Keep agent working directories as existing absolute Windows paths; a Linux or container path is not interchangeable with one.

Setup detects npm-installed backends without restarting Rooks, including installations with a custom global npm directory. If you explicitly configured a backend path in `host.binaries`, that path takes precedence; `rooks doctor` reports it when the file is missing. Correct or remove the outdated path in **Settings → AI models → Providers → CLI binaries**; it applies without restarting Rooks.

## Quitting and stopping

**Quit** in the notification-area icon menu closes the app only. The daemon run by the `RooksOrchestrator` task keeps working (your missions continue), and the task starts it again within five minutes if it stops, so ending the task from Task Scheduler is not a stop.

**Quit and stop the background service**, in the same menu, ends the daemon and every program it started (web server, mission programs, built-in terminal), disables the task and quits. Windows asks for permission once. The next time you open Rooks, it asks once more and starts the service again. From a terminal, `rooks service stop` and `rooks service start` do the same; `rooks service status` says when the service was stopped this way.

In portable mode (no task), the daemon is started by the app and stops with it, together with its web server, the programs of the running missions and the built-in terminal.

To remove the service for good, run `rooks service uninstall` and allow the Windows permission prompt: it removes the task, ends the daemon and the terminal host, and keeps your data. Rooks offers to install the task again at the next launch. If the permission prompt is refused, the command says so and the task stays.

## Uninstalling

Uninstall Rooks from Windows Settings or Control Panel. Allow the Windows permission prompt to remove the `RooksOrchestrator` scheduled task. Your Rooks data directory, including missions, agents and the database, is kept.

For unattended removal, run the installed uninstaller with `/S` from an administrator terminal. Silent removal does not ask for elevation. If permission is denied, removal of the application continues; remove any remaining `RooksOrchestrator` task from Task Scheduler with administrator rights.

## Source installation

For a source checkout, install Node 22+, Git and the native build prerequisites. In PowerShell, from the checkout root:

```powershell
cd orchestrator
npm ci
npm run build
cd ../app
npm ci
npm run build
cd ..
node orchestrator/bin/rooks service install --dry-run
```

Before installing, set `profile` to `windows`, `daemon.supervisor` to `windows`, `daemon.installDir` to the absolute orchestrator directory and `app.enabled` to `true` in the [configuration file](configuration.md). Escape backslashes in JSON or use forward slashes.

```powershell
node orchestrator/bin/rooks service install
node orchestrator/bin/rooks service status
```

The task starts at boot and every five minutes if the daemon stopped. If it is registered but not running, start it from Windows Task Scheduler before completing setup. Removing the supervisor does not remove Rooks's data directory.
