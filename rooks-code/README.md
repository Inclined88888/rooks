# Rooks Code: the terminal coding agent

`rooks` is AI Workspace's own coding agent for the terminal, in the spirit of Claude Code and Codex CLI, but it works
with **any model**: OpenAI, Anthropic, OpenRouter, any OpenAI-compatible server (Groq, Together, vLLM, llama.cpp, ...)
and local **Ollama** or **LM Studio**, fully offline. It does not need Workbench or Docker.

It reads and searches your code, edits files (showing a diff first), runs commands (tests, builds, git), and loops until
the job is done. Everything it does is asked about first, can be undone, stays inside a hard budget, and is written to a
receipt in Workbench's run-log format.

## Install

Rooks needs Python 3.11 or newer. The interactive terminal (command menu, history, status bar, formatted answers)
uses prompt_toolkit and rich; one-shot prompts, pipes and scripts use the plain line mode, which is standard library
only (ROOKS_PLAIN=1 forces it).

| | Recommended | Alternatives |
|---|---|---|
| macOS | `brew install uv` then `uv tool install "git+https://github.com/Inclined88888/rooks#subdirectory=rooks-code"` | `pipx install ...` (same URL) |
| Windows | `winget install astral-sh.uv` then the same `uv tool install` line (PowerShell) | `py -m pip install --user ...` |
| Linux | `curl -LsSf https://astral.sh/uv/install.sh \| sh` then the same `uv tool install` line | `pipx install ...` |

From a clone: `uv tool install ./rooks-code` (or `pip install ./rooks-code`). Single file: `python rooks-code/scripts/build_pyz.py`
makes `dist/rooks.pyz`, which runs anywhere with `python rooks.pyz`.

**Why this packaging.** The rest of this repo's terminal tooling (`cli/ws`) is dependency-free Python, so the agent is
too: nothing to audit, no supply chain, nothing that phones home. `uv tool install` is a single static binary on all three
systems, installs a private Python 3.11+ automatically when the machine has none (stock macOS ships 3.9), puts `rooks`
on the PATH and upgrades/uninstalls cleanly (`uv tool upgrade rooks-code`, `uv tool uninstall rooks-code`). We chose this
over a Node/npm package (would add a runtime the core does not use) and over PyInstaller binaries (unsigned executables
trigger Gatekeeper/SmartScreen warnings until code-signing exists; the desktop app track handles signing). The `.pyz`
is the no-installer fallback. CI tests and installs it on macOS, Windows and Linux.

## Use

```sh
cd your-project
rooks                                  # interactive session
rooks "make the failing test pass"     # one prompt, prints the answer, then exits (codes below)
rooks -P ollama -m qwen2.5:7b    # local and offline (ollama pull qwen2.5:7b first)
rooks -P anthropic -m claude-sonnet-5-5   # needs ANTHROPIC_API_KEY
rooks -P openai -m gpt-4.1-mini        # needs OPENAI_API_KEY
rooks -P openrouter -m deepseek/deepseek-chat   # needs OPENROUTER_API_KEY
rooks -P openai-compatible --base-url http://localhost:8000/v1 -m my-model
rooks --dry-run "rename foo to bar everywhere"  # show every diff and command, change nothing
rooks -P claude-code "fix the build"   # delegate to your own signed-in Claude Code (your Claude plan)
rooks -P codex "fix the build"         # delegate to your own signed-in Codex (your ChatGPT plan)
```

`-P claude-code` and `-P codex` run the official CLI you installed and signed in to yourself, in this folder, and print
what it does. Edits and commands are still asked about first (`--yes` = accept edits, `--dry-run` = show what would
change and change nothing); Rooks never handles a key or token for them. See [../docs/CLAUDE-CODE.md](../docs/CLAUDE-CODE.md).

A one-shot run (`rooks "task"`, also with piped input) and a headless run (`rooks -p`, below) end with an exit code a
script can check:

| Code | Means |
| --- | --- |
| `0` | finished |
| `1` | did not finish: the model could not answer, the step limit or a cap was reached, or a checked change failed |
| `2` | cannot start: no key for the provider, no task given, or bad arguments |
| `3` | a change or command was denied: you typed `n`, there was no input to answer with (in a headless run, nobody can answer), a permission rule never allows it, or a project hook stopped it |

### Headless: scripts and CI

```sh
rooks -p "make the failing test pass"                       # prints the answer; exit code as above
echo "make the failing test pass" | rooks -p                # the task piped in (read until the pipe closes)
rooks -p --output-format json "what does calc.py do?"       # one JSON object at the end
rooks -p --output-format stream-json "fix the build"        # one JSON object per line, per event
```

`rooks -p` runs one task and never waits for input. A step that would need your OK (an edit, a command, an MCP tool, an
MCP server's question to you) is denied at once and reported, and the run exits with code `3`. Only what you set up
beforehand lets a step run: a permission rule (`[permissions] allow` in `rooks.toml`, or a trusted folder's
`.rooks/settings.json`), a trusted folder, or `--yes` (approves the agent's own steps; an MCP server's question to you
is still denied). Deny rules refuse in every mode. A headless run never asks whether to trust a folder, and is not
linked to a chat in the app, so nothing waits in Needs you. With `-p`, a task given on the command line is used and
standard input is not read; `-` or no task reads it from the pipe.

* `--output-format text` (the default): the answer alone on standard output; each step and each denial, briefly, on
  standard error.
* `--output-format json`: one object: `result` (the answer), `session_id` (the receipt in `.rooks/runs`, and
  `rooks --resume ID` continues it), `turns` (model calls), `tokens` (`input`, `output`, and `cache_read` and
  `cache_write`, the input read from and written to the prompt cache), `cost_usd` (`null` when the price is unknown),
  `denied` (each step not done: `tool`, `summary`, `by` = `headless`, `rule` or `hook`), `exit_code`, `error`,
  `outcome` and `duration_ms`.
* `--output-format stream-json`: one object per line: `start`, `assistant` (text), `tool_call`, `tool_result` (paired
  by `id`), `approval_asked`, `approval_denied`, `notice`, and last `end`, which carries the same fields as the json
  result. A helper's steps (the task tool) have `"helper": true`.

Both are described by a JSON Schema in the package, [rooks_code/schema/headless.schema.json](rooks_code/schema/headless.schema.json)
(`#/$defs/result` and `#/$defs/event`); the tests validate every line against it. Keys, tokens, emails and phone
numbers are hidden in headless output, as in the receipts. `json` and `stream-json` imply `-p`.

From Python, the same run in-process, with the same result object:

```python
from rooks_code import sdk

res = sdk.run("make the failing test pass", cwd="path/to/project", on_event=print)  # also provider=, model=, yes=, ...
print(res.exit_code, res.result, res.denied, res.to_dict())
```

`rooks_code.sdk.run` never reads standard input or prints; each event reaches `on_event` as a dict, and a bad setup
comes back as `exit_code` 2 with `error` in plain words instead of an exception. `rooks -P claude-code` and `-P codex`
are not headless here: use their own (`claude -p`, `codex exec`).

Inside a session type `/` for the command menu (every command with what it does) and `@` to pick a file:

* `/model` opens a menu: Auto or an AI, then a short list of its newest chat models (older ones behind "More"),
  then, for a Claude, ChatGPT or Copilot plan, how hard it thinks. `/effort low|medium|high|auto` changes only that.
  The choice shows in the status bar and is kept for the next start.
* Two separate settings, never called by the same name. `/mode chat|plan|build` says what Rooks may do at all (chat
  talks, plan reads, build can change files); it shows as "build mode" in the line under each answer. Shift+Tab says
  how changes are approved: asks first, auto-accept or dry run (`/auto` and `/dry-run` switch the same thing); it shows
  in the status bar. A checklist the agent keeps shows there as "checklist 2/5".
* `/permissions` shows what runs without asking and what never runs, in plain words, and whether this folder's own
  rules apply; `/permissions trust` or `untrust` changes that (see Trust controls).
* `/init` writes AGENTS.md and the session follows it from the next request on, no restart needed.
* `/doctor` checks the provider at the address this session uses (`--base-url` or the app's), with one real call, and
  prints the full detail of any error. On the normal screen a model error is said in plain words, with no address.
* `/new`, `/sessions`, `/resume ID`, `/compact`, `/copy`, `/undo`, `/cost`, `/auto`, `/dry-run`, `/login`, `/provider`,
  `/receipt`, `/exit`.
* `/memory` and `/skills` show what Rooks has learned (below).

## It learns

Rooks gets better the more you use it, the same way the AI Workspace app does, and shares what it learns with it:

* Tell it something lasting ("I use pnpm", "my name is Azad") and it saves it with its `remember` tool.
* Through the app, every finished request is kept in the app's chat history as a terminal chat and learned from in the
  background: facts about you, and after a task of several steps a reusable skill (procedure). Before each request
  the facts that fit and the skills index go into its instructions; `load_skill` reads a skill's steps.
* Requests that read web pages never become skills (injected text must not become a standing instruction).
* Without the app, remembered facts live in `memory.json` next to `rooks.toml` and come back in every session.
* `learn = false` in `rooks.toml` turns it off. The app's "Learn about me" switch also applies.

Other commands: `rooks undo`, `rooks receipts [list|show|import --db workbench.db]`, `rooks doctor` (checks the provider,
key and MCP servers with one real call), `rooks mcp` (lists MCP tools), `rooks init` (writes an example config).

A real, unedited session with a local 7B model (bug fixed, test run, receipts, dry run, undo, import into Workbench) is
in [docs/demo-session.txt](docs/demo-session.txt), including the model's mistakes.

## Trust controls

* **Approval by default.** Reading and searching run freely. Every edit is shown as a diff and every command in full,
  then you answer `y`, `n`, `a` (or `h`, below). `a` approves only that exact command, changes to that one file, or that one tool
  of one MCP server, for the rest of the session; the question says which ("Approve this exact command for this
  session"). Any other command, file or tool is still asked about. A denied action is reported to the model, which is
  told not to retry it, and its reply ends the turn: Rooks never nudges it to carry on after a no. With no terminal
  input the answer is "no", and a one-shot run exits with code 3.
* **Only you answer, here or in the app.** Linked to the app, each question also waits in Needs you. An answer typed
  here is recorded in the app only with your Terminal access token (`rooks login`); the open app's own key never
  records one, because any program on this computer can read it, a command the agent ran included. Without the token
  your answer here still stands and the app's card closes. A question from a coding job the app started is answered in
  the app only.
* **Trusted folders.** `trusted_folders = ["~/code/my-app"]` in the config lets edits and commands in those folders (and
  below) run without asking. `--yes` does the same for one run.
* **Permission rules.** Allow or never allow by tool and pattern, in `rooks.toml`:

  ```toml
  [permissions]
  allow = ["bash(pytest *)", "bash(npm test)", "edit(src/**)", "mcp(notes/search)"]
  deny = ["bash(rm *)", "edit(.env)"]
  ```

  `bash(pytest *)` is `pytest` and anything after it (not `pytesting`), `bash(npm test)` exactly that command,
  `edit(src/**)` changes to files under `src`, `mcp(notes/search)` one extra tool (`mcp(notes/*)` all of its tools); a
  bare `bash`, `edit` or `mcp` means every one. Claude Code's `Bash(...)`, `Edit(...)` and `mcp__server__tool` read
  the same. **Deny wins** over allow and applies in every mode: asks first, auto-accept (`--yes`, `/auto`), trusted
  folders and dry run; a refused step counts as a denial (exit code 3). Commands are read the way the shell reads them:
  `pytest; rm -rf x`, `pytest && curl ...`, `$(...)`, backticks, pipes, `VAR=value pytest` and a redirect to a file
  never match an allow rule unless every part does (only `2>&1` and `> /dev/null` are fine); when in doubt Rooks asks.
  A deny rule sees through `sudo`, `env`, `xargs`, `find -exec`, `bash -c '...'`, full paths (`/bin/rm`), quotes and
  backslashes. A command too hard to read (the program's name in a variable, `eval`) is asked about even in
  auto-accept while any command deny rule exists. A rule matches the command line: a script or program that a command
  starts can still do anything, so deny rules are a guard, not a sandbox (`sandbox = "project"` is the one that keeps
  writes in the folder). `/permissions` shows the rules in plain words; `/permissions help` how to write one.
* **A folder's own rules need your trust.** A project can keep rules in `.rooks/settings.json`
  (`{"permissions": {"allow": [...], "deny": [...]}}`). Its deny rules always apply. Its allow rules apply only after
  you say you trust the folder: a one-time question when `rooks` starts there, kept by the folder's real path in
  `rooks-trust.json` next to `rooks.toml`. Until then they are ignored and Rooks says so; `/permissions trust` and
  `/permissions untrust` change it. A copied repository cannot grant itself anything. Rooks' own rule files are never
  changed by the agent unasked: the file tools cannot write `.rooks`, and a command naming `.rooks/settings`,
  `rooks.toml` or the trust file is asked about in every mode.
* **Always allow here.** For a command, the question also offers `h`, "Always allow this command in this folder": it
  writes one exact allow rule per part of the command (`bash(npm test)`; a `*` in it stays a literal star) to the
  folder's `.rooks/settings.json`. It is offered when you trust the folder, or nobody was asked yet and the folder has
  no allow rules of its own (then choosing it also records that you trust it, and says so); never for a command that
  cannot be pinned down exactly. The app's Needs you card answers yes or no only.
* **Dry run.** `--dry-run` (or `/dry-run`) shows everything that would change and applies nothing.
* **Undo.** Every file written during one prompt is snapshotted first; `/undo` or `rooks undo` restores them all and
  deletes files the agent created. Commands cannot be undone (their receipts list what ran).
* **Hard budget.** `max_tokens` (default 200,000) and `max_usd` (default $1.00) per session. Before each model call Rooks
  estimates its input and stops rather than cross either cap. Local models cost $0. If a model's price is unknown the
  dollar cap cannot be enforced; Rooks says so at start and the token cap still applies (add the price under `[prices]`).
* **Prompt caching, charged honestly.** With Anthropic, every request marks the system prompt, the tool list and the
  conversation so far for caching, so the next step rereads them at the cache price. OpenAI and DeepSeek cache by
  themselves. Input read from the cache, and (Anthropic) input written to it, are counted apart and charged at the
  cached price in `/cost`, the receipts (`cache_read_tokens`, `cache_write_tokens` on each model call), the headless
  result (`tokens.cache_read`, `tokens.cache_write`) and the dollar cap. A cache write costs more than plain input
  (1.25x on Anthropic), so the cap's estimate for the next call uses that price. Cached prices come from the built-in
  table; for a model priced under `[prices]`, add them as `[input, output, cache read, cache write]`. If a call used
  the cache and its cached price is unknown, its cost is unknown, never guessed: Rooks says so once, and the dollar
  cap cannot be enforced while the token cap still applies.
* **Project boundary.** File tools cannot read or write outside the project folder, nor write into `.git` or `.rooks`.
* **Small-model help.** Tool calls a local model prints as text (`<tool_call>` tags or a JSON block) are recovered with
  Workbench's rule (only well-formed calls to offered tools; receipt column `from_text`), and a reply that announces a
  step without calling a tool gets up to two nudges (`nudge = false` turns this off). A reply that declines ("OK, I will
  not change it.", "I'll leave it as is.") is not a step, and nothing is nudged after you deny a change.
* **Receipts.** Each session writes `.rooks/runs/<session>.jsonl` (git-ignored automatically): one row per prompt, model
  call, tool call, approval decision and outbound connection, using the columns and outcome words of Workbench's `actions`
  table (`turn`, `model_call`, `tool_call`, `decision`, `egress`; `verified`, `denied`, `budget_paused`, ...). File edits
  are read back after writing and marked `verified` with a sha256. Text is redacted with Workbench's own patterns.
  `rooks receipts import --db /path/to/workbench.db` adds them to Workbench's run log (channel `rooks-code`), idempotently.
  `dry_run` is the one outcome Workbench does not produce itself.

## Configuration

`rooks init` writes `~/.config/ai-workspace/rooks.toml` (Windows: `%APPDATA%\ai-workspace\rooks.toml`; override with
`ROOKS_CONFIG`). Precedence: flags > `ROOKS_PROVIDER` / `ROOKS_MODEL` / `ROOKS_BASE_URL` > config file > defaults.
Keys are never stored: each provider names the environment variable that holds its key.

```toml
provider = "anthropic"
model = "claude-sonnet-5-5"
max_usd = 2.0
trusted_folders = ["~/code/sandbox"]

[providers.groq]                 # any OpenAI-compatible endpoint
kind = "openai"
base_url = "https://api.groq.com/openai/v1"
key_env = "GROQ_API_KEY"
model = "llama-3.3-70b-versatile"

[mcp.servers.github]             # stdio MCP servers; tools appear as mcp__github__<tool>
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = { GITHUB_PERSONAL_ACCESS_TOKEN = "..." }   # or set it in your shell
trusted = false                  # true: its tools run without asking
```

A project's `.mcp.json` (`{"mcpServers": {...}}`, the format Claude Code and Cursor use) is picked up too. MCP tool
calls are asked about like commands. Only stdio servers are supported so far; HTTP/SSE servers are skipped with a notice.
When a server asks you something itself while a tool runs (MCP elicitation: the Room asks before a file leaves it,
Rooks Desk before a sensitive step), the question is put to you, never to the model, and is mirrored to Needs you when
the app is linked. `--yes`, trusted folders and `a` do not answer it; with no keyboard and no answer in the app it is a
no. Only yes or no questions are answered; a server asking for anything else is declined.

## Limits (honest)

* Small local models follow tool instructions unreliably. On a CPU-only test machine `qwen2.5:7b` (Q4_K_M) fixed a bug,
  ran the test and stopped correctly; `qwen2.5:3b` and `qwen2.5-coder:7b` described steps without calling tools, even
  with Rooks' recovery of tool calls printed as text and its "you announced a step, call the tool" nudge. Use a 7B+
  general instruct model, or a hosted model, for real work.
* In the interactive terminal, answers stream in as they are written, formatted as they arrive (a "Working" line with
  a timer shows progress until the first words); plain mode (`ROOKS_PLAIN=1`) streams token by token in a terminal;
  piped output arrives whole.
* Commands are kept inside the project folder by default (`sandbox = "project"`): on macOS with the built in
  `sandbox-exec`, on Linux with bubblewrap (`bwrap`, for example `sudo apt install bubblewrap`). They can still read
  the whole computer and use the network; only writes are limited, to the project and the temp folder. On Linux
  without a working `bwrap` a command is refused with a note before you are asked about it, never run uncontained.
  Windows has no containment yet: commands run with your user's permissions and the approval line says so.
  `sandbox = "full"` runs them with your user's permissions everywhere; then approval, dry run and trusted folders
  are the controls.
* MCP over HTTP/SSE and prompt caching are not implemented yet.
* Skills are learned only through the AI Workspace app; on its own Rooks learns facts, not procedures.

## Development

```sh
cd rooks-code && python -m pip install pytest && python -m pytest -q
```

The end-to-end tests run the real `rooks` process against a scripted fake model served over HTTP (both the OpenAI and
Anthropic protocols) and a fake stdio MCP server, and import the receipts into a database built from Workbench's schema.
