# Slash commands in the chat (`/skill`)

Lets a person invoke a skill **explicitly** from the chat, instead of relying
on the passive injection (`# Skills you MUST apply` in the system prompt) that
an agent often ignores.

## Approach: rewriting the message

When a chat message starts with `/<id> [request]`, the daemon **rewrites it
before sending it to the agent**: the body of the skill (front matter removed)
is injected as an imperative instruction that wraps the request.

`orchestrator/src/slash.ts` → `expandSlashCommand(message, { cwd })`. The id is
resolved against the skill registry (`skill-registry.ts`): Timon skills, global
Claude skills and commands, the skills and commands of the mission's project
(from its `cwd`) and those of plugins. It is wired into the two entry points of
a message written by a PERSON:

- `handleSpawn` (`POST /api/missions`, `POST /api/agents/spawn`): a new mission.
- `POST /api/agents/:id/send`: a follow-up turn.

Task missions (the Kanban dispatcher) call `spawnAgent()` internally without
going through these HTTP routes, so they are **not affected**: the slash is a
chat tool for people, not a pipeline mechanism.

### Rules

| Input | Result |
|--------|----------|
| `/timon-task create a doc task` | rewritten: skill `timon-task` + "My request: create a doc task" |
| `/timon-task` (alone) | rewritten: skill + "apply this skill to the current context of the conversation" |
| `/unknown ...` | **unchanged** (a warning is logged with the known ids) |
| a normal message | unchanged |
| `//text` | escaped → `/text` (a literal slash, no command) |

Shape of the rewritten message:

```
[Skill invoked explicitly: `timon-task`] Apply the skill procedure below to my
request, STRICTLY. This is not optional — it is the priority instruction of
this turn.

<skill id="timon-task">
…body of the SKILL.md (front matter removed)…
</skill>

---

My request: create a doc task
```

The procedure goes into a collapsed section of the person's bubble: only the
request stays visible.

A Claude **command** (`claude-cmd` format) follows the semantics of Claude Code
commands instead: `$ARGUMENTS` and `$1`…`$9` are substituted, the `` !`cmd` ``
blocks run (only when the command's `allowed-tools` front matter allows them,
with a timeout) and the `@file` references are inlined. The expansion, and so
any command it runs, happens when the message is **sent**, never while typing.

## Autocomplete

Typing `/` in the chat composer opens a popup that lists the skills
(`GET /api/skills`) and inserts the chosen id. It is purely client-side: the
rewrite above works the same whether the id was typed or picked.
