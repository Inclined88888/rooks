---
title: opencode
sidebar_position: 11
---

Timon can run agents on **opencode**, the open-source coding agent, including its free **Muse Spark 1.3** model, which needs no account. It drives the opencode CLI over the Agent Client Protocol; opencode keeps its own sign-in and provider keys, and Timon never sees or stores them.

## Set it up

1. Install the CLI:

   ```bash
   npm install -g opencode-ai
   ```

2. Optional: to use your own providers instead of the free model, sign in in a terminal, under the same OS account that runs Timon:

   ```bash
   opencode auth login
   ```

3. Restart Timon. **opencode** then appears among the LLM backends.

Timon looks for `opencode` on the service's PATH, in the npm and Homebrew folders, and in `~/.opencode/bin`, where opencode's own install script puts it; on Windows it also looks in the Scoop (`%USERPROFILE%\scoop\shims`) and Chocolatey (`%ProgramData%\chocolatey\bin`) folders.

If opencode does not appear, run `timon doctor`: it tells you whether the `opencode` binary was found. A CLI installed anywhere else may be missing from the service's PATH; set `host.binaries.opencode` to its absolute path in that case. If a mission stops with a sign-in message, run the command it names in a terminal on the machine that runs Timon, then retry.

## Models

The default model is **Muse Spark 1.3 (free)**, which opencode offers without an account. The list shown in the model picker comes from opencode itself, so it follows the providers you signed in to, and it is refreshed at most every 12 hours. Until the first answer, only the free model is listed.

Opening that list starts opencode briefly, which leaves one empty session in opencode's own history. A model change applies from the next mission or conversation, not in the middle of one.

## What agents can do

**opencode decides its own tool permissions.** Timon shows no Allow / Deny card for it and cannot restrict what it does inside your project. opencode refuses, for example, a write outside the project folder on its own, without asking. The agent editor flags this with a "manages its own permissions" badge and greys out the permission mode, which opencode ignores. To change what opencode may do, edit the `permission` key of its `opencode.json` configuration file (see opencode's documentation on permissions). Choose opencode for an agent you are comfortable letting work with opencode's own rules.

Replies stream into the chat, tool calls appear with their results, and the model's reasoning shows as a collapsed **Reasoning** block. **Stop** in a chat ends the current turn and keeps the conversation; the next message continues in the same opencode session, including after Timon restarts. Timon's own tools (Kanban, questions, missions, memory) and the stdio MCP servers configured for the agent reach opencode.

**Compacting a conversation** and its summary when you switch it to another model run on the agent's own model, as does Dreaming for an opencode agent: Timon starts opencode for a short session with none of Timon's tools, then stops it. Each run leaves one session in opencode's own history. opencode decides its own tool permissions there too, as in a mission. Conversation titles are not generated with opencode: Timon uses another of your backends, or keeps the first message as the title.

These short sessions do not trust the project's `opencode.json`, which an agent could have written: a provider declared there only keeps its model names, an address on this machine and a key written out in full. A local model keeps working. A provider on another machine, or one whose key is written `{env:…}` or `{file:…}`, belongs in your global `~/.config/opencode/opencode.json`: if the project's file points a provider elsewhere, the compaction fails in seconds and the daemon log names the provider, rather than sending the conversation to another one.

## Limitations

- **Permissions are opencode's.** No Allow / Deny cards, and the agent's permission mode does not narrow what opencode may do: set them in the `permission` key of `opencode.json`.
- **HTTP MCP servers are not passed on.** MCP servers you added over HTTP do not reach opencode agents.
- **No live model switch.** A model change applies from the next session.
- **No quota gauge.** Timon does not display your remaining usage with opencode's providers.
- **Not yet tried on every setup.** Windows and macOS installs in particular have had little testing; report what you see.
