---
title: Configuration
sidebar_position: 7
---

Rooks reads `rooks.config.json` from its data directory, normally `~/.rooks`. Set `ROOKS_HOME` to select a different instance directory. This is a process environment variable, not a JSON configuration key.

For a source installation, create the directory and write the following JSON, replacing the example paths with existing absolute paths on your machine:

```json
{
  "version": 1,
  "profile": "linux-desktop",
  "edition": "expert",
  "daemon": {
    "installDir": "/path/to/rooks/orchestrator",
    "listen": {"host": "127.0.0.1", "port": 3000},
    "supervisor": "systemd-user"
  },
  "host": {"docker": "disabled", "traefik": false},
  "app": {
    "enabled": true,
    "listen": {"host": "127.0.0.1", "port": 3100},
    "publicUrl": "http://127.0.0.1:3100"
  }
}
```

Use `profile: "macos"` and `supervisor: "launchd"` on macOS, or `"windows"` for both on Windows. Use `linux-server` for a Linux server. For Docker features, change `host.docker` as needed; do not enable both app serving modes.

## Where Rooks keeps its files

Rooks keeps everything in one data directory, the *Rooks home*. In these docs `~` means your user folder: `/home/<user>` on Linux, `/Users/<user>` on macOS and `C:\Users\<user>` on Windows, which Windows also names `%USERPROFILE%`. Set `ROOKS_HOME` to use another directory.

| What | Linux | macOS | Windows |
|---|---|---|---|
| Rooks home | `~/.rooks` | `~/.rooks` | `%USERPROFILE%\.rooks` |
| Configuration file | `~/.rooks/rooks.config.json` | `~/.rooks/rooks.config.json` | `%USERPROFILE%\.rooks\rooks.config.json` |
| Agents (`config.json`, `system-prompt.md`, `memory/`) | `~/.rooks/agents/<name>/` | `~/.rooks/agents/<name>/` | `%USERPROFILE%\.rooks\agents\<name>\` |
| Project settings and memory (not your source code) | `~/.rooks/projects/<slug>/` | `~/.rooks/projects/<slug>/` | `%USERPROFILE%\.rooks\projects\<slug>\` |
| Default working folder of the agents created during setup | `~/.rooks/workspace/` | `~/.rooks/workspace/` | `%USERPROFILE%\.rooks\workspace\` |
| Installed plugins | `~/.rooks/plugins/` | `~/.rooks/plugins/` | `%USERPROFILE%\.rooks\plugins\` |
| Custom LLM backends | `~/.rooks/backends/<id>.json` | `~/.rooks/backends/<id>.json` | `%USERPROFILE%\.rooks\backends\<id>.json` |
| Logs (one file per day: `daemon-<date>.log`, `desktop-<date>.log`) | `~/.rooks/tmp/` | `~/.rooks/tmp/` | `%USERPROFILE%\.rooks\tmp\` |
| Service output before the daemon starts | systemd journal: `journalctl --user -u rooks-orchestrator` | `~/.rooks/tmp/daemon.log` | `%USERPROFILE%\.rooks\tmp\daemon.log` |
| Backups | `~/.rooks/backups/` | `~/.rooks/backups/` | `%USERPROFILE%\.rooks\backups\` |

Your projects' source code stays where you keep it; an agent's `cwd` is an absolute path to that folder, for example `/home/<user>/projects/<slug>` on Linux or `C:\Users\<user>\projects\<slug>` on Windows. Archives in `backups/` are written every night by the backup, on by default (see [Backups and the agent trash](../usage/settings.md#backups-and-the-agent-trash-system)). Deleted agents wait in `trash/agents/` until restored or purged.

Setup does not ask for a working folder. The main orchestrator and the agents created with it start in the `workspace` folder of the Rooks home, which Rooks creates when needed. A configuration you write yourself, as in the source installation above, can point them to another existing absolute folder with the optional `workspacesRoot` key. An agent that already has a working directory keeps it.

## Resolution order

The loader merges the edition preset with your file, then applies schema defaults and supported environment overrides. Your file wins over the preset. Arrays are replaced, not concatenated.

Registry settings resolve in this order: **environment → `settings` in the file → saved UI setting → default**. The UI shows the source, so a value controlled by the environment or file cannot be changed by saving another UI value.

`modules` controls bundled modules; `plugins` controls third-party plugins by manifest ID. Values can be `true`, `false`, `"auto"` or an options object with `enabled`. Plugin toggles recompose the loader without a daemon restart. Changes to daemon addresses, host configuration or process environment require an operator-managed restart.

:::warning Paths and credentials
Set `daemon.installDir` explicitly for source installations. Keep API credentials out of this file; use plugin secret settings or the secrets vault. Never disable authentication on a non-loopback listener.
:::

See the generated [configuration reference](config-reference.md) for every field, default and direct environment override.
