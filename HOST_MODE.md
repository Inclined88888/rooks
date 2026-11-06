# Host mode

The Timon daemon runs as an ordinary process on your machine, supervised by the
operating system — never inside a container. Docker is optional, and covers only
the web app.

## Why

Agents spawned by the daemon inherit your real environment: `$PATH`, `$HOME`,
your dotfiles, your credentials, every CLI you have installed. A new tool is
available to them the moment you install it, with nothing to rebuild into an
image. That is also what makes the agent CLIs (`claude`, `codex`) usable at
all — they authenticate as *you*, under your account.

## Installing the service

The CLI writes the service definition for the supervisor of your OS — a systemd
user unit on Linux, a launchd agent on macOS, a scheduled task at logon on
Windows:

```bash
timon service install --dry-run   # prints what it would write
timon service install
timon service status
```

`daemon.installDir` in `~/.timon/timon.config.json` must point at the directory
the daemon is run from. The desktop package sets it for you; from a source
checkout it is the absolute path of `orchestrator/`.

Never assume where the home is — read it from the installed service:

```bash
systemctl --user cat timon-orchestrator     # Linux
```

### From the onboarding

A fresh install does not ask for this command: the onboarding installs the
service in the background from the AI step on (the first step that stays on
the onboarding page: the account step still opens the sign-in screen), through the
same `install-service` action the former `/setup` button used
(`orchestrator/src/onboarding.ts`, `serviceOptsFromEnvironment`). A card in the
corner ("Preparing Timon") shows its progress while the AI and the profile are
set up; a refusal — a dismissed UAC prompt on Windows, the
administrator password declined on macOS, polkit on Linux — is shown there with
the tool's reason, the command to paste when the daemon knows one, **Try
again**, and the repair screen (`/setup`).

Only the agent and chat steps wait for the service. When the reader reaches
them, the onboarding writes `timon.config.json` (after the service: writing it
ends the first run and closes `/api/onboarding`) and the desktop hands its
embedded daemon over to the service (`handOverToService`) before the agent is
created on it. A machine without a supervisor (Linux without systemd, or a
Windows task registered but never started for this account) goes on in
portable mode. Details: `docs/ONBOARDING-PREPARATION.md`.

Between the install and the handover — the whole AI and profile steps,
a few minutes rather than seconds — the registered service cannot bind: the
desktop's embedded daemon holds the port and the data directory. Each attempt
of its supervisor stops at the data-directory lock (see "One daemon per data directory") and costs one log line; the packaged systemd unit backs off up to
5 minutes and never gives up (`PACKAGED_RESTART_BACKOFF`), so the handover's
own restart still starts it.

### Updating a packaged service

On Linux and macOS a packaged service does not run from the package: it runs
from a staged copy, `~/.timon/desktop-runtime/releases/<release>`. Installing a
newer .deb or .pkg replaces `/opt/Timon` (or the app bundle) and leaves that
copy alone, so the previous daemon keeps running. Something has to move the
service onto the new release:

- the desktop app, at its next launch (`desktop/src/upgrade.ts` →
  `packaged-upgrade-runner.ts` → `upgradeDesktopService`);
- without the app, `timon update apply` from the installed package's CLI
  (`host/packaged-apply.ts`): same runner — stage, rewrite the unit or plist,
  restart, health check, rollback — logged to
  `desktop-runtime/update-apply.log`. `timon service install` from a newer
  package takes the same path.

Then the data migration still waits for `timon update approve <version>`.
`timon update status` and `timon doctor` report a service that lags behind the
installed CLI. Windows is not concerned: its scheduled task runs from the
installation folder, which the installer replaces.

## Running it in the foreground instead

For development, when you want the daemon attached to a terminal:

```bash
cd orchestrator
npm run dev:host     # tsx watch, reloads on save
npm run start:host   # plain node dist/index.js
```

One daemon at a time per data directory: stop the service first. A second daemon
on the same `TIMON_HOME` now stops on its own — see below.

## One daemon per data directory

The first thing a daemon does after opening its log is take an exclusive lock on
`<home>/daemon.lock` (`orchestrator/src/home-lock.ts`, imported second by
`boot.ts`). If another daemon holds it, the newcomer waits up to 5 s (a daemon
being restarted or upgraded is still exiting), then writes one line —
`another Timon daemon already serves <home> (pid …, port …, since …)` — and exits
with code **76**. It has restored nothing, migrated nothing, swept no mission and
armed no loop: the live daemon's missions keep running. Its supervisor relaunches
it for as long as the other one lives; each attempt costs one log line.

The lock is SQLite's exclusive lock (`LockFileEx` on Windows, `fcntl` on macOS
and Linux), the same mechanism as the data-open lock. The OS releases it when the
process ends, crash included, so there is never a stale lock to clear and no pid
to check for liveness or recycling. `<home>/daemon.lock.json` (pid, start time,
port once listening) only feeds the refusal message; the holder removes it on a
normal exit. Different homes never collide: the `~/.timon-dev` sandbox and a test
home each have their own lock.

Why: before, a second daemon booted in full before failing on `EADDRINUSE`. On the
way it marked the live daemon's `running` missions failed, which revoked their MCP
tokens (401). A service installed from the first-run assistant did exactly that to
the setup mission of the desktop's embedded daemon, every time its supervisor
relaunched it.

## Mission programs the daemon leaves behind

Whatever runs the daemon — systemd, launchd, a Windows task, the desktop app in
portable mode, or a terminal — the CLI of each mission is recorded in
`~/.timon/run/missions/<pid>.json` with its start identity and the daemon's
(`orchestrator/src/host/mission-processes.ts`). Three readers end what a dead
daemon left: the next daemon at boot, `timon service stop` (and the desktop's
« Quit and stop the background service »), and the desktop after its embedded
daemon exits (`dist/host/mission-process-sweep-runner.js`). A process is only
signalled while it still answers with the identity it was recorded with, and
never while the daemon that recorded it is alive.

On Windows, the first line of defence is the OS: libuv keeps every direct child
of the daemon in a kill-on-close job, so it dies with the daemon however the
daemon dies. A grandchild escapes that job, which is why an npm CLI is not
started through `cmd.exe`: the adapter reads the `.cmd` shim and starts the
`node` script, or the `.exe`, in its place (`orchestrator/src/host/windows-shell.ts`).
The CLI is then the direct child, recorded under its own pid. A shim it does not
recognise line for line still runs through `cmd.exe`: a pnpm shim that sets
`NODE_PATH`, a yarn global shim calling another `.cmd`, flags for the runtime, a
target outside the shim's folder. In that case the registry holds the pid of
`cmd.exe`, which dies with the daemon, so neither the job nor the three readers
above reach the CLI: it stays until it exits on its own.

## The web app

The daemon listens on `127.0.0.1:3001`. The app is served either by the daemon
itself as a supervised child process (`app.enabled: true`), or by the `app`
container of `docker-compose.yml` — one or the other, never both, since they
bind the same port. See [GETTING-STARTED.md](GETTING-STARTED.md) §3.

The container reaches the host daemon through `host.docker.internal:3001`, wired
by the `extra_hosts: host-gateway` shim.

## OAuth callbacks

A provider that must call back into the daemon needs a URL that reaches it from
outside the loopback. Set `TIMON_PUBLIC_API_URL` to that externally reachable
URL; the daemon uses it when it builds redirect URIs, instead of guessing from
its own bind address.
