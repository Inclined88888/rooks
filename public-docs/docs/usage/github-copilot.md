---
title: GitHub Copilot
sidebar_position: 10
---

Timon can run agents on a **GitHub Copilot** subscription, personal or provided by your company. It drives the official GitHub Copilot CLI, which keeps your GitHub sign-in: Timon never sees or stores your GitHub token.

## Set it up

1. Make sure your GitHub account has a Copilot seat, and that your organisation allows **Copilot CLI** in its Copilot policies.
2. Install the CLI:

   ```bash
   npm install -g @github/copilot
   ```

3. Sign in, under the same OS account that runs Timon:

   ```bash
   copilot login
   ```

4. Restart Timon. **GitHub Copilot** then appears among the LLM backends, with the GitHub logo.

On Windows, `winget install GitHub.Copilot` works too.

To update the CLI, use **Update** on its card in Settings › AI models, or run `copilot update` in a terminal. On every system, the card runs `copilot update` whenever the CLI is already installed, whichever way it was installed (npm, nvm, Volta, Homebrew, WinGet or the install script), on the copy Timon detects. Two exceptions, where the card may update another copy or install a new one: a CLI path pinned in `host.binaries.copilot`, and a CLI installed under an nvm pre-release of Node (such as `v21.0.0-rc.1`). In those cases, run `copilot update` with the CLI's full path in a terminal. If the CLI sits in a folder your account cannot write to (installed with `sudo`, for instance), the update fails with a permission error: update it the way you installed it.

If Copilot does not appear, run `timon doctor`: it tells you whether the `copilot` binary was found. Besides the service's PATH, Timon looks in the global npm folder: on Windows including a custom `npm config set prefix`, plus the WinGet links and packages folders; on macOS and Linux `~/.npm-global`, nvm and Volta, plus Homebrew and `~/.local/bin` (a custom npm prefix there is found only when it is on the service's PATH). If the CLI lives somewhere else, set `host.binaries.copilot` to its absolute path.

## Models

The models offered are the ones **your account may use**: an organisation decides which GPT, Claude or Gemini models its members reach. Timon asks the Copilot CLI for that list and refreshes it regularly. Until the first answer, or when the CLI cannot answer (signed out, no seat), it offers the models GitHub documents for the CLI.

The default model is **auto**, which lets Copilot choose among the models you are allowed. Each prompt Timon sends counts against your Copilot premium requests, like a prompt typed in the CLI. The LLM quotas widget and the strip under the chat composer show the share of your monthly premium requests already used and when the allowance resets, as reported by the Copilot CLI; on a plan without a limit, no gauge is shown.

Timon never switches a mission to Copilot on its own when another backend runs out of quota. It only runs on Copilot when you, or an agent's settings, choose it.

## What agents can do

Copilot fixes an agent's rights when the turn starts, from a list of what the agent may do. There is no Allow / Deny card on Copilot: anything outside that list is refused on the spot. An agent can still ask you a question through the Timon tools.

| Agent permission mode | On Copilot |
|---|---|
| `plan` | Reads files and uses the Timon tools. It can neither write files, run commands nor fetch web pages. |
| `auto`, `default`, `acceptEdits` | Reads and writes files inside the project folder, uses the MCP servers configured for the agent, and runs a fixed list of commands: the `timon` commands a mission needs (tasks, messages, notifications, delegation, memory rules), everyday `git` commands (`status`, `diff`, `log`, `show`, `add`, `commit`, `branch`…) and commands that only read (`ls`, `cat`, `grep`, `head`…). No other command, no generic shell, no web access. |
| `bypassPermissions` | **Not sandboxed.** Every tool and every web address, without asking. Choose it only for an agent you trust with your whole machine. |

In the sandboxed modes, an agent also gets the commands it is explicitly allowed in Timon: the agent's own allowed tools, those of its skills, and those of its task type (a coding task may run `npm run` and `npx tsc`, for instance). Such a command runs your project's scripts, which the agent itself may have edited. A shell, an interpreter (`bash`, `node`, `python`…) or a bare package runner (`npx`, `npm`) is never granted this way, `git` is limited to its usual subcommands, and `timon` to the commands a mission needs: a grant never opens `timon service`, `timon update`, `timon plugin` or the other commands that administer Timon itself.

### When a command is refused

A command outside the list shows in the chat as **Refused: this is outside what the agent may do on Copilot**, followed by the Copilot CLI's own sentence: "Permission denied because no interactive user response was available. Retry in an interactive session…". That interactive session is the Copilot CLI's own terminal, not something Timon offers: nobody is asked, and retrying the same command fails again. When a retry does succeed, the agent simply took another route, one the list allows (reading a file with its file tool instead of `node -e`, for instance). It was never a confirmation you skipped.

Agents on Copilot are told this, and pick an allowed command or report which one was refused. To let an agent run a command it needs, add it under **Allowed tools** in the agent's settings (Permissions), in the form `Bash(<command>:*)`: `Bash(npm test:*)`, `Bash(make test:*)`. The rules above still apply: a shell, an interpreter or a bare package runner is never granted that way. For an agent you trust with your whole machine, `bypassPermissions` lifts the list.

A few commands stay forbidden in every mode, `bypassPermissions` included: `sudo`, `shutdown`, `reboot`, `mkfs`, recursive deletion of `/` or `~`, and stopping, restarting, installing, uninstalling or updating the Timon service (`systemctl`, `timon service`, `timon update`, `timon app restart`, `timon daemon`).

## Limitations

- **Organisation policy on MCP servers.** Some organisations forbid third-party MCP servers in Copilot. Timon's tools (Kanban, questions, missions) then do not reach the agent. It can still use the `timon` command-line tool from its shell.
- **No live model switch.** A model change applies from the next turn.
- **One turn at a time.** Each turn starts the CLI again and resumes the same Copilot session, so the conversation keeps its context.

## When Copilot does not answer

If the agent shows "thinking" and then nothing, Timon now ends the turn with a line in the chat: the backend stopped without answering, its exit code and the end of what it wrote. The usual causes are a Copilot CLI that is not signed in (run `copilot login`, or `/login` inside `copilot`, in a terminal on the machine that runs Timon) and an organisation policy that denies the CLI ("Access denied by policy settings", which an administrator of your GitHub organisation must lift). Switching the agent to another backend in its settings confirms that the rest of Timon is fine.
