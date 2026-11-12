---
title: Running in the background
sidebar_position: 6
---

Rooks's daemon runs under your operating system's supervisor, not inside the desktop window. Closing the window does not stop it, and on every supported system it can keep working after you sign out: scheduled Kanban tasks, overnight series and running missions carry on without an open session. On macOS this needs one extra step, a long-lived Claude token.

What each system needs is described on its own page:

| System | What keeps Rooks running without a session | Details |
| --- | --- | --- |
| Linux | A systemd user service with user lingering: it starts at boot and survives logout. | [Linux](linux.md) |
| macOS | A launchd daemon, once a long-lived Claude token is set: it starts at boot and survives logout. Without a token, the service is a launchd agent that stops when you log out. | [macOS](macos.md#keep-rooks-running-when-you-are-logged-out) |
| Windows | The `NovaOrchestrator` scheduled task: it starts at boot and survives sign-out. After a restart, Rooks waits for your first sign-in. | [Windows](windows.md) |

Check the service at any time with:

```bash
rooks service status
```

## Stopping and starting the service

Quitting the app leaves the service running on purpose. To stop everything, choose **Quit and stop the background service** in the tray or menu bar icon menu: the daemon and the programs it started (web server, mission programs, built-in terminal) end, and the app quits. The service stays installed and starts again the next time you open Rooks.

From a terminal:

```bash
rooks service stop
rooks service start
```

| System | What the stop does | What starts the service again |
| --- | --- | --- |
| Linux | Stops the systemd user unit; it stays enabled. | Opening Rooks, `rooks service start`, or the next boot. |
| macOS | Unloads the launchd agent; a launchd daemon asks for an administrator password. | Opening Rooks (the daemon asks for the password again), `rooks service start`, or the next login (agent) or boot (daemon). |
| Windows | Disables the `NovaOrchestrator` task and ends the daemon; Windows asks for permission. | Opening Rooks or `rooks service start`, with one more permission prompt. A disabled task does not start at boot. |

Stopping the service also ends the programs of the missions that were still running. If the daemon ever stops without ending them (a crash, a forced stop), its next start does.

## If another Rooks owns the service

On macOS and Windows the service has a single name per account, and so has the service of a Rooks run from source on Linux. Before it installs, removes, stops or starts it, `rooks service` checks that the service in place belongs to the same data folder and the same Rooks installation. If it does not, the command changes nothing, exits with an error and shows what it found:

```text
refused: the service com.rooks.daemon belongs to another data directory.
  service:    com.rooks.daemon (/Users/you/Library/LaunchAgents/com.rooks.daemon.plist)
  data:       /Users/you/.rooks
  install:    /Users/you/.rooks/desktop-runtime/releases/…/Resources/orchestrator
  executable: /Users/you/.rooks/desktop-runtime/releases/…/MacOS/Rooks
  this command: data /tmp/try, install /Users/you/src/rooks/orchestrator
Nothing was changed. To replace it anyway: rooks service install --force
```

The usual way out is to run the command from that installation, or with its `ROOKS_HOME`. Reinstalling over your own service, which is how you repair or update it, needs no flag.

A service that cannot be identified is refused too: `install` and `uninstall` also stop if its definition cannot be read, or names your data folder but not the installation it runs from. Check it, then use `--force`. `stop` and `start` still work on such a service.

The Rooks app checks too. Opened on another data folder, it does not offer **Quit and stop the background service**, never stops or restarts that service, and runs its own built-in daemon.

To take the service over on purpose, use `rooks service install --force`. The other installation's daemon stops, and its data folder is left as it is. `rooks service uninstall --force` removes the service in the same way. `stop` and `start` have no `--force`.

On Linux, a package and a source checkout use different service names, so both could end up running on the same data folder. `rooks service install` and `start` refuse that too, and `rooks service status` shows the other service. `rooks service install --force` stops and removes it before starting its own. If both already exist, `rooks service uninstall` from either one removes only that one's service.

The check reads what systemd actually runs, including drop-ins. If systemd cannot confirm a Rooks unit, for instance because it was edited and not reloaded, `install` and `start` refuse, and `--force` does not remove it. Run `systemctl --user daemon-reload`, or repair or remove that unit, then try again.

`--dry-run` reports this refusal too, with `--force` it shows what would be replaced. The install button in the app gives the same refusal, and only the command can force it.

## Sign out, do not just lock

Locking the screen keeps your session open, so Rooks keeps running whatever the installation. Signing out is the case covered above; on macOS without a Claude token, it stops Rooks. Portable mode (Linux without systemd, or a daemon started by hand) is the exception: that daemon stops with the application, together with the programs of its running missions.

## Sleep stops everything

**No system runs Rooks while the computer is asleep.** Missions pause, and a task scheduled during sleep only starts once the computer wakes up. Rooks does not wake the computer.

If you schedule tasks for the night, turn off automatic sleep on that computer, or at least while it is plugged in:

- **Linux:** in your desktop's power settings, set automatic suspend to off. On a machine without a desktop, `sudo systemctl mask sleep.target suspend.target` disables suspend.
- **macOS:** System Settings → Energy (or Battery → Options on a laptop): prevent automatic sleeping while the display is off.
- **Windows:** Settings → System → Power → Screen and sleep: set "When plugged in, put my device to sleep after" to **Never**.

Turning off only the display is fine: it does not stop Rooks.

## After a restart

On Linux, Rooks starts at boot, before anyone signs in.

On Windows, Rooks waits for your **first sign-in** after each restart, including restarts made by Windows Update during the night. After that sign-in you can sign out again and Rooks keeps running. To keep a machine working through unattended restarts, enable automatic sign-in on it, or sign in after each restart.

On macOS with a Claude token, Rooks starts at boot, before anyone logs in. If FileVault is turned on, nothing starts until someone unlocks the disk at the login screen. Without a token, Rooks waits for you to log in.

## Limits while no session is open

A background daemon runs as you, but without the resources that only exist in an open session.

- **Tools that use the system credential store.** A CLI tool that keeps its sign-in in the operating system's credential store may not be signed in for a mission that runs while you are signed out. On macOS, this is the case of Git over HTTPS and `gh`. Git over SSH with a key file works in every case.
- **Windows: network shares.** While you are signed out, missions may not be able to reach mapped network drives (`Z:\…`) or shared folders that require your credentials. Keeping agent working directories on a local disk avoids the question.
- **No windows.** Nothing a mission launches can show a window or a prompt on your screen. A tool that needs an interactive sign-in must be signed in beforehand, from a terminal under the same account.

If a mission fails only while you are signed out, check `rooks service status` and the daemon log first; see [Troubleshooting](troubleshooting.md).
