# Timon orchestrator

The headless daemon of Timon. It launches the agents' CLIs (Claude Code, Codex
and the other providers) as missions, captures their `stream-json` events,
persists them to SQLite and broadcasts them over SSE to the web app, the
desktop app and the CLI.

## Run from the sources

```bash
cd orchestrator
npm install
npm run dev   # or: npm run build && npm start
```

Use a temporary home while you experiment (`TIMON_HOME` set to a fresh
folder): the daemon reads and writes everything under it.

## Agent layout (`~/.timon/agents/<name>/`)

```
system-prompt.md
config.json          # { cwd, model, permission_mode, allowed_tools }
memory/
  learnings.jsonl
  log.jsonl
```

`config.json` example:

```json
{
  "cwd": "/home/me/code/project-x",
  "model": "sonnet",
  "permission_mode": "auto",
  "allowed_tools": ["Bash", "Read", "Edit"]
}
```

## API

| Method | Path                          | Body / Notes |
| ------ | ----------------------------- | ------------ |
| POST   | `/api/agents/spawn`           | `{ agent_name, mission }` → `{ mission_id }` |
| GET    | `/api/missions/:id`           | mission state + all events |
| POST   | `/api/agents/:id/send`        | `{ input }`: a follow-up turn (`:id` = mission id) |
| GET    | `/api/missions/:id/stream`    | SSE stream filtered for one mission |
| GET    | `/api/stream`                 | SSE stream for all missions |

SSE event shapes:

```
event: event
data: { kind:"event", missionId, type, timestamp, payload }

event: mission_complete
data: { kind:"mission_complete", missionId, status, exitCode }
```

## Resource guard (day/night profile)

On Linux with systemd, the daemon keeps missions from freezing the machine: an
`ffmpeg` started by a task once reached 35 GB of RSS, and with no limit on the
service the out-of-memory was global. Timon does not limit its own service
(`timon service install` writes no limit); it confines the missions instead.
The code is `src/resources.ts`, every setting is in the **Resources** group of
the Settings page.

### Mission confinement

Each mission turn runs in a **transient systemd scope**
(`timon-<id>-mission-<mission>-<n>.scope`, where `<id>` is 8 hex characters of
the sha256 of `TIMON_HOME`), placed in the slice `timon-<id>-missions.slice`.
The command is wrapped this way:

```
systemd-run --user --scope --collect --unit=… --slice=timon-<id>-missions.slice \
  --property=MemoryMax=<per mission> --property=CPUWeight=20 \
  -- nice -n <profile> ionice -c <profile> <backend CLI> …
```

- **A memory ceiling per mission** (`TIMON_MISSION_MEM_MAX_GB`, a default that
  follows the RAM): the OOM killer is confined to the faulty scope, so a
  runaway allocator is killed in seconds while the desktop stays usable.
- **No `MemoryHigh` on the scope**: measured, it prevents the kill instead of
  anticipating it (the process stays stuck in reclaim, with no alert).
- **No `MemoryHigh` on the slice either**: see the systemd-oomd pitfall below.
  The slice carries `MemoryHigh=infinity`, `MemoryMax`, `MemorySwapMax=2G` and
  `ManagedOOMMemoryPressure=kill` (40% limit).
- **`nice` and `ionice`** are inherited by ALL the descendants: that is what
  catches the `ffmpeg` an agent starts three levels down. Disk priority goes
  through `ionice` rather than `IOWeight`, because the `io` controller is often
  not delegated to the user systemd manager.
- The slice carries the **collective** ceiling: N missions cannot add up their
  individual ceilings.

### Day/night profile

The profile is computed again at each tick (`TIMON_RESOURCE_WATCH_MS`, 30 s by
default) and applied **live** (`systemctl --user set-property --runtime`): no
restart, no mission killed.

| | day (08:00–20:00) | night |
| --- | --- | --- |
| slice CPU | 400% (4 cores) | 1600% (16 cores) |
| slice memory ceiling | RAM preset below | RAM preset below |
| `nice` / `ionice` class | 15 / 3 (idle) | 5 / 2 (best-effort) |
| live missions | 4 | `TIMON_MAX_LIVE_MISSIONS` |
| dispatched tasks | 2 | `TIMON_MAX_PARALLEL` |

Nothing is hard-coded: the hours (`TIMON_DAY_START_HOUR`,
`TIMON_DAY_END_HOUR`) and every value of the table are settings.
`TIMON_DAY_MEM_HIGH_GB` and `TIMON_NIGHT_MEM_HIGH_GB` are retired: still set
(environment, config file, settings table), they are ignored and the daemon
says so in its log at startup. The day caps are clamped to the global caps: a
day setting looser than the night one is neutralised, not applied.

### Automatic memory defaults

Memory settings remain in GB (1024³ bytes); CPU settings are unchanged.
Timon reads usable RAM using the portable `os.totalmem()` and selects the
highest class whose nominal capacity is at most the detected RAM divided by
0.9. This 10% tolerance accounts for RAM reserved by the kernel and firmware:
15.4 GB uses 16, 31 GB uses 32, and 62.5 GB uses 64. The threshold is inclusive:
57.6 GB uses 64, but 57 GB uses 32. The minimum class remains 8 GB, including
machines with less than 8 GB; 12 GB uses 8 and 28 GB uses 16.

| RAM class | Per mission | All missions, day | All missions, night |
| --- | --- | --- | --- |
| 8 GB | 2 GB | 3 GB | 4 GB |
| 16 GB | 4 GB | 6 GB | 8 GB |
| 32 GB | 8 GB | 10 GB | 16 GB |
| 64 GB | 12 GB | 16 GB | 24 GB |

These defaults apply independently to `TIMON_MISSION_MEM_MAX_GB`,
`TIMON_DAY_MEM_MAX_GB` and `TIMON_NIGHT_MEM_MAX_GB`. Environment variables,
configuration-file values and saved settings retain priority, in that order.
Existing explicit values are not migrated. Resetting a saved value restores
this automatic default unless the environment or configuration overrides it.
Applying a preset saves all three limits together; each remains individually
editable. The guard picks up changes on its next tick without a restart,
including the active slice ceiling. Lowering a limit below current usage can
terminate a mission process. Enforcement depends on the host's existing
resource confinement support; RAM detection itself works on all three OSes.

### Visibility and alerts

```bash
timon health          # profile, cgroup memory/CPU, live missions, OOM kills
timon health --json   # the same, raw (API: GET /api/health/resources)
```

The watch loop reads `memory.events` (recursive: an OOM in a scope shows at the
slice level) and alerts on the **difference** between two ticks: an OOM kill
and a `MemoryMax` crossing are urgent. It also reads the slice's
`memory.pressure`: above 25% (`some avg10`), an urgent alert goes out **before**
systemd-oomd acts at 40%; it re-arms below 10%. A silent OOM is a task that
fails with no readable reason.

### Pitfall: `MemoryHigh` on the slice, PSI, and systemd-oomd killing the session

A slice that carried a finite `MemoryHigh` once brought the whole graphical
session down. Beyond `MemoryHigh`, the kernel kills nothing: it **throttles**
and forces memory reclaim, which creates pressure (PSI) with no real shortage.
PSI is hierarchical and goes up to `user@<UID>.service`, which Ubuntu and its
derivatives watch by default (`user@.service.d/10-oomd-user-service-defaults.conf`:
`ManagedOOMMemoryPressure=kill`, 50%, 20 s). systemd-oomd then picks its victim
among **all** the cgroups of the session, the user manager's `init.scope`
included.

The fix: no soft ceiling at all, `MemoryHigh=infinity` set explicitly each time
the profile is applied (otherwise the old runtime drop-in keeps its value), and
`ManagedOOMMemoryPressure=kill` on the slice at 40%, below the parent's
threshold, so that the slice crosses first and oomd kills a mission.

That is not enough alone: the parent stays watched and oomd can still pick
outside the slice. **Installation recommendation** (root, so outside Timon):
turn off the watching of the session's user manager.

```ini
# /etc/systemd/system/user@<UID>.service.d/90-no-oomd-session.conf
[Service]
ManagedOOMMemoryPressure=auto
```

Check:

```bash
systemctl --user show 'timon-*-missions.slice' \
  -p MemoryHigh -p MemoryMax -p ManagedOOMMemoryPressure -p ManagedOOMMemoryPressureLimit
# expected: MemoryHigh=infinity, ManagedOOMMemoryPressure=kill
oomctl   # the slice must be listed under "Memory Pressure Monitored CGroups"
```

If `oomctl` does not list the slice, oomd does not honour the property on this
user manager: the safeguards are then `MemoryMax` (a confined kernel OOM) and
the system drop-in above.

### Pitfall: mission scopes outlive the service

The scopes are **not** in the service's cgroup: restarting the daemon no
longer kills the agents' processes. `stopMissionScopes()` sweeps them at boot
and on `SIGTERM`/`SIGINT`, otherwise orphaned agent CLIs pile up.

## Storage

SQLite at `~/.timon/timon.db` (WAL), with `missions` and their `events` among
its tables. Per-agent append-only mirror at
`~/.timon/agents/<name>/memory/log.jsonl`.
