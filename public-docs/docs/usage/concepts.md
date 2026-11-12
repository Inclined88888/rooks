---
title: Concepts
sidebar_position: 1
---

Rooks keeps the worker, the conversation and the planned work separate. This lets you reuse an agent, inspect an individual run and follow a longer project without losing the relationship between them.

| Concept | Meaning |
| --- | --- |
| Agent | Reusable instructions, working directory, backend, model and tool configuration |
| Mission | One running or completed conversation with an agent, with an event history |
| Kanban task | A durable work item: brief, status, assignee, dependencies and result |
| Project | A named working directory with associated agents and role defaults |
| Trigger | A source (schedule, webhook or internal event) that runs actions on its own: a TO DO idea, a task, a notification or a workflow. Routines are schedule triggers. See [Triggers](./triggers.md) |
| Worktree | An isolated Git working directory for a coding task; services and databases outside Git remain shared |
| Pipeline | Rules that connect work stages, such as code, review and merge |
| Backend / model | The execution provider/profile and the specific model selected within its catalogue |
| Plugin | An installable extension that adds behaviour, UI surfaces or both |

[How Rooks works](how-rooks-works.md) shows how these pieces fit together, in three diagrams.

A conversation can exist without a Kanban task. Use a mission for an immediate request; create a task when the work needs dependencies, scheduling or a durable completion record.

Rooks runs your authenticated CLI tools. Its standard agent workflow uses your CLI subscriptions rather than token-billed APIs. Plugins can provide additional backend profiles; choose only providers you have configured and intend to use.
