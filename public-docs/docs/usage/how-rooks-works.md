---
title: How Rooks works
sidebar_position: 1.5
description: Diagrams of Rooks's building blocks, the life of a mission and the Kanban pipeline from code to review, merge and doc.
---

Three diagrams give the overall picture: what runs where, what happens when an agent works, and how a Kanban task travels from code to documentation. Each one is followed by the same information as text. The terms are defined in [Concepts](concepts.md).

## The building blocks

![The desktop app, the web app and the rooks CLI talk to the Rooks daemon. The daemon runs agents, the Kanban dispatcher, triggers and plugins, serves the rooks and nova_ask MCP servers, and starts the CLI of each agent, which reaches its model provider with your subscription.](/img/diagrams/architecture.svg)

- **Clients.** The [desktop app](../installation/overview.md) (Windows, macOS, Linux) bundles the daemon and the web app. The web app is the same interface in a browser, locally or through [remote access](../installation/remote-access.md); [plugins](plugins-gallery.md) add widgets and pages to it. The [`rooks` CLI](cli.md) gives the same daemon commands in a terminal and in scripts. Every client talks to the daemon over its HTTP API and receives live updates; closing a client does not stop the daemon.
- **The daemon** is the heart of Rooks. It runs in the background under your system's service manager ([Running in the background](../installation/background.md)) and listens on loopback by default. It:
  - starts each agent, follows its missions and keeps their history ([Missions](missions.md));
  - dispatches [Kanban](kanban.md) tasks once their dependencies and schedule allow;
  - fires [triggers](triggers.md): schedules, webhooks, events and routines;
  - runs the host half of each plugin; the browser half runs in the client ([Create a plugin](../plugins/overview.md));
  - serves the two built-in MCP servers, `rooks` and `nova_ask` ([Tools Rooks gives agents](agent-tools.md));
  - keeps its configuration, database, agents, skills and plugins in the Rooks home ([Where Rooks keeps its files](../installation/configuration.md#where-rooks-keeps-its-files)).
- **Agent processes.** For each mission, the daemon starts the agent's CLI (Claude Code, Codex, opencode, Copilot and others) in the agent's working folder and follows its events. The agent acts on Rooks by calling the tools of the built-in MCP servers.
- **Model providers.** Each CLI reaches its own provider with the account you signed it in with ([Subscription accounts](subscription-accounts.md)).

## The life of a mission

![Six steps: a mission starts, Rooks prepares the agent, the CLI of the agent starts, the agent works through a turn, the turn ends, the mission closes. A follow-up message after step 5 starts a new turn at step 4.](/img/diagrams/mission-lifecycle.svg)

1. **A mission starts** from your message in the chat, `rooks spawn`, a Kanban task, a trigger, or another agent that delegates work with `mission_spawn`. The Missions table shows [who started it](missions.md#your-conversations-and-automated-missions).
2. **Rooks prepares the agent**: its instructions, identity docs, skills and memory rules, with the backend and model it runs on ([Agents](agents.md)).
3. **The agent's CLI starts** in the agent's working folder, or in a dedicated Git worktree for a code task, with the `rooks` and `nova_ask` MCP servers.
4. **The agent works through a turn.** Its output and tool activity appear live in the chat. Its questions and permission requests open as cards and wait for your answer.
5. **The turn ends.** The answer is recorded and the agent waits for a next message: the mission stays open (**Turn done** badge). A follow-up message, from the chat or with `rooks send`, starts a new turn at step 4.
6. **The mission closes.** An agent working on a Kanban task closes its task, and the result returns to the orchestrator that created it. Rooks stops an idle agent process; the mission's history stays available. See [What state a mission is in](missions.md#what-state-a-mission-is-in).

## The Kanban pipeline

![Full pipeline: code, then review when the code has a diff, then merge on a pass verdict, then doc when an agent holds the librarian role. Changes requested return to another code round, three rounds at most, then the task is blocked. code-self and code-group have no automatic review.](/img/diagrams/kanban-pipeline.svg)

A `code` task chooses its pipeline when it is created ([Choose the pipeline](kanban.md#choose-the-pipeline)). With the default `full` pipeline, Rooks chains the next stages itself:

1. **code**: the coder works on its own branch, in a dedicated worktree, and closes the task.
2. **review**: when the branch holds changes, a review task goes to the project's reviewer, who reads the diff and gives a verdict.
3. **Changes requested** send the work back to another code round, which is reviewed again: three code rounds at most, the first one included. When the third is still not approved, or when Rooks cannot read the verdict, the task moves to **Blocked** and waits for your decision.
4. **merge**: a **pass** verdict creates a merge task for the project's merger, which integrates the branch.
5. **doc**: once the work is merged, a doc task records the change, if an agent of the project holds the librarian role.

Each stage goes to the agent that holds the role on the project, or to a `<project>.<role>` agent Rooks creates ([Which agent and model run a task](kanban.md#which-agent-and-model-run-a-task)). A project folder that is not a Git repository has no merge stage: the doc task follows the review.

The two other pipelines skip the automatic review:

- **`code-self`**: the coder merges its own branch and closes the task with the full merge SHA. No doc task follows.
- **`code-group`**: several code tasks form a group, and one final merge task integrates them all.
