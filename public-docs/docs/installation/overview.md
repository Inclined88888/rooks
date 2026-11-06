---
title: Overview
sidebar_position: 1
---

Timon runs a local daemon that manages agents and stores mission history. A desktop client or web interface connects to that daemon. Closing a client does not stop a daemon running under an operating-system supervisor, and that daemon can keep working after you sign out; see [Running in the background](background.md), including why sleep must be turned off for overnight tasks.

For a diagram of what runs where, see [How Timon works](../usage/how-timon-works.md).

Start with [Requirements](requirements.md), then choose [Linux](linux.md), [macOS](macos.md) or [Windows](windows.md). Finish with [First run](first-run.md).

## Choose an installation mode

| Mode | What runs where | Best suited to |
| --- | --- | --- |
| Desktop package | Desktop client, bundled daemon and web app on your computer | Interactive use |
| Host installation | Node daemon and web app on your computer | Operators with source access |
| Docker web app | Daemon on the host; app and optional workers in containers | Existing Docker installations |

Docker is optional. The current Compose file does **not** contain an orchestrator service. See [Docker](docker.md) before using it.

:::note Distribution
These instructions describe the implementation in the supplied Timon source and desktop packages. No public repository or public release download is linked here. Use the package or source checkout provided with your installation; there is no public clone command to copy.
:::
