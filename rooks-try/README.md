# Rooks Try Room

A disposable computer that lives on **this** machine. The agent can install packages,
open apps, click and type inside it. Your real desktop, mouse and clipboard stay alone.

Same idea as a rented cloud box, but local-first: Mac, Windows or Linux host, one API.

## What you get

| Command | What it does |
|---|---|
| `rooks-try up` | Start (or resume) the Try Room |
| `rooks-try status` | Which driver is running, size, last checkpoint |
| `rooks-try screenshot` | Save a PNG of the guest screen |
| `rooks-try reset` | Roll back to the last checkpoint |
| `rooks-try checkpoint` | Save a restore point |
| `rooks-try down` | Stop the guest |
| `rooks-try mcp` | MCP server for Rooks Code, Cursor, Claude Code, … |
| `rooks-try serve` | Local HTTP API for the Rooks app |

## Drivers (picked automatically)

1. **qemu** — a real Linux guest VM (best isolation). Needs `qemu-system-*` on the PATH.
2. **nested** — a private X11 desktop on this computer (fast). Needs Xvfb on Linux.
3. **shell** — a private home folder and shell only (always available). Good for “try this install”.

On every host the guest OS is Linux, so skills and scripts transfer. Mac and Windows are
hosts; they are not required as guest images.

## MCP tools

`status`, `up`, `down`, `checkpoint`, `reset`, `screenshot`, `click`, `drag`, `scroll`,
`type`, `key`, `run` (shell inside the room), `handoff` (copy a file out, asks first).

```sh
# Rooks Code picks it up when installed; or:
claude mcp add rooks-try -- rooks-try mcp
```

## Safety

- Host pointer and clipboard are never driven by Try Room actions.
- The room has its own home folder under `~/.ai-workspace/try-room/`.
- `handoff` is the only way files leave the room, and it waits for a yes.
- Default networking follows the driver (qemu can start offline with `--offline`).

## Install

Shipped with the one-command Rooks installer. Or:

```sh
uv tool install --python 3.12 ./rooks-try
```
