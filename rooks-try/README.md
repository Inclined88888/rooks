# Rooks Try Room: the Room

A computer of its own for the assistant, living on **this** machine. The agent can install packages,
open programs, click and type in a private desktop or a Linux guest. Your real mouse, keyboard
and clipboard stay alone.

The private-folder driver runs commands as you, in a folder of its own. On Linux each command gets
a private mount namespace when `unshare` works (and no network when the room is offline). Those
commands can still read what you can read. It is not a locked-off computer, and status says so.

Same idea as a rented cloud box, but local-first: Mac, Windows or Linux host, one API.

## What you get

| Command | What it does |
|---|---|
| `rooks-try up` | Start (or resume) the Room |
| `rooks-try status` | Which driver is running, what it really is, last checkpoint |
| `rooks-try screenshot` | Save a PNG of the room's screen (when it has one) |
| `rooks-try reset` | Roll back to the last checkpoint |
| `rooks-try checkpoint` | Save a restore point (the 20 newest are kept) |
| `rooks-try down` | Stop the room |
| `rooks-try run "cmd"` | Run a command inside the Room |
| `rooks-try drivers` | List the drivers this computer can run |
| `rooks-try prepare` | Explain how to attach a Linux guest image for QEMU |
| `rooks-try mcp` | MCP server for Rooks Code, Cursor, Claude Code, … |
| `rooks-try serve` | Local HTTP API for the Rooks app |

## Drivers (picked automatically, strongest first)

1. **qemu** — a real Linux guest VM (best isolation, `isolation: vm`). Needs `qemu-system-*` on the PATH and a guest
   image (`ROOKS_TRY_IMAGE`; `rooks-try prepare` explains); its screen and pointer need `vncdotool`.
2. **nested** — a private X11 desktop on this computer with a real terminal in it (fast). Needs Xvfb on Linux.
3. **shell** — a private home folder and shell only. No screen, no pointer.

There is also **display**, a drawing of a terminal painted by the package. It is a picture, not a
screen: it has no pointer, it is never picked automatically, and it is only reachable by name
(`ROOKS_TRY_DRIVER=display`) for tests.

## What status tells you

Every driver reports `screen` (a real picture exists), `pointer` (clicks reach something real),
`isolation` (`none`, `namespace` or `vm`), a plain `label` and a `note`. Anything that shows the
room should show a picture only when `screen` is true and input controls only when `pointer` is true.

## MCP tools

`status`, `up`, `down`, `checkpoint`, `reset`, `screenshot`, `click`, `drag`, `scroll`,
`type`, `key`, `run` (shell inside the room), `handoff` (copy a file out; see Safety).

```sh
# Rooks Code picks it up when installed (the MCP server "room"); or:
claude mcp add rooks-try -- rooks-try mcp
```

## Safety

- Host pointer and clipboard are never driven by Room actions.
- The room has its own home folder under `~/.ai-workspace/try-room/`.
- A saved point copies that folder. Names never collide; the 20 newest are kept and status names the ones removed.
  When a QEMU disk is present, the same point is also saved on the disk.
- `handoff` is the only supported way to copy a file out. In the Rooks app it waits for your yes in Needs you.
  Through `rooks-try mcp` the package cannot ask you itself: the copy runs only when the calling agent passes
  `approve: true`. Rooks Code treats the server as untrusted and shows its own approval prompt first; another MCP
  client must gate it the same way.
- `rooks-try serve` listens on this computer only, refuses to start until `ROOKS_TRY_API_KEY` (or `TOOLS_API_KEY`)
  is set, and compares the key in constant time. Its screenshot route serves the last picture without waiting behind a command.
- Networking follows the driver (qemu and the namespaced shell can start offline with `--offline`).

## Install

Shipped with the one-command Rooks installer. Or:

```sh
uv tool install --python 3.12 ./rooks-try
```
