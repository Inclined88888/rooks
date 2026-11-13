---
title: Pi
sidebar_position: 13
---

Rooks can run agents on **Pi** ([pi.dev](https://pi.dev/)), the token-frugal coding agent. Rooks drives the `pi` command directly; no adapter is needed. Pi keeps its own sign-in and provider keys, and Rooks never sees or stores them.

## Set it up

1. Install Pi, version **1.4.0 or later**, with its installer (`curl -fsSL https://pi.dev/install.sh | sh`, or on Windows `powershell -c "irm https://pi.dev/install.ps1 | iex"`) or with npm (Node.js 22.19 or later):

   ```bash
   npm install -g @earendil-works/pi-coding-agent
   ```

   On Windows, Pi runs its shell commands with **Git Bash**: install [Git for Windows](https://git-scm.com/download/win) if it is not there yet.

2. Sign in, in a terminal, under the OS account that runs Rooks: start `pi`, then type `/login` and choose a provider (a subscription or an API key). You can also configure Pi's providers or keys as Pi's own documentation describes.

3. Restart Rooks. **Pi** then appears among the LLM backends.

If Pi does not appear, run `rooks doctor`: it tells you whether the `pi` command was found. A command installed somewhere the service's PATH does not cover can be pinned: set `host.binaries.pi` to its absolute path. If a mission says Pi is older than 1.4.0, update it (`pi update`, or the npm command above) and send the message again; Rooks does not need a restart.

The `pi-acp` adapter earlier versions of Rooks needed is no longer used; you can uninstall it. Agents, tasks and conversations that ran on Pi keep working, and a conversation started through the adapter reopens with its history.

## Models

Rooks does not pick a model for Pi: the default is Pi's own. Pi routes to several providers, so the model picker lists what your Pi setup offers, read from `pi --list-models` and refreshed at most every 12 hours. You can switch model during a conversation, between two replies. Images you attach are sent when the selected model accepts them; otherwise the agent is told they were left out.

## What agents can do

Replies stream into the chat, with Pi's reasoning in its own block, and tool calls appear with their results. **Stop** in a chat ends the current turn and keeps the conversation; after a restart, the mission reopens its Pi session.

**Rooks's own tools reach Pi**: the Kanban, questions, missions, memory and the other `rooks` tools, plus the MCP servers configured for the agent (local commands and HTTP servers). Your own Pi extensions, skills and settings still apply in missions.

### Permissions

Every tool call Pi makes goes through Rooks first, and follows the agent's **permission mode**:

| Mode | What passes on its own | What asks you |
|---|---|---|
| `plan` | Reads, Rooks's own tools and `rooks` commands | Nothing: any edit or other command is refused |
| `acceptEdits`, `auto` | The same, plus edits inside the working folder | Every other command or edit, as an **Allow / Deny** card |
| `bypassPermissions` | Everything | Nothing |

Tools you allowed or disallowed for the agent are respected in every mode, and a few commands are always refused (`sudo`, shutting the machine down, restarting Rooks). A refused call does not run: the agent is told why. A tool from an MCP server you added does not skip the card by describing itself as read-only.

## Limitations

- **Not yet tried with a tester's own provider.** Rooks was checked against a real Pi with a scripted stand-in for the model provider, not with a real subscription or API key, so a first mission may still fail. Report what you see.
- **Conversation titles come from another backend.** With Pi as the only backend, conversations keep their default title.
- **No web tools in background jobs.** When Rooks summarizes a conversation or runs Dreaming on Pi, Pi gets no tool at all: it answers from the text alone.
- **No quota gauge.** Rooks does not display your remaining usage.
- **`auto` and `acceptEdits` behave the same** on Pi: both let edits inside the working folder through and ask about the rest.
