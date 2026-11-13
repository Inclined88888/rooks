---
title: CLI reference
sidebar_position: 9
---

<!-- Generated file. Do not edit by hand. Run npm run gen:cli. -->

Root help is captured from `orchestrator/bin/rooks --help` with a disposable `ROOKS_HOME`, an unreachable API target and a 20-second process limit. No daemon or subcommand is started. Additional usage blocks are read from literal source strings because subcommand help is not universally safe to execute. Legacy French prose is translated and command syntax is retained; descriptions then go through the publication policy in `scripts/doc-policy.json`.

This is a reference snapshot, not a shell script to execute in full. Replace placeholders with real values. Installation, task creation, deletion and service commands change the target instance.

## Root help

```text
rooks — Rooks control plane CLI

Getting started:
  rooks                                   where this installation stands, and the next command
  rooks init [--email A] [--name N]       finish the setup from the terminal: background service,
             [--password-stdin] [--yes]   first account, AI tools (the password is typed hidden)

Updates (run on the daemon host):
  rooks update check [--json]            ask rooks.local whether a newer Rooks is published
  rooks update status                    inspect a pending packaged update
  rooks update apply                     move the service onto the installed package
  rooks update approve <daemon-version>   approve backup and data migration

Agents & missions:
  rooks list                              list agents (json)
  rooks spawn <agent> <input...>          start a mission, returns {mission_id}
             [--extra-skills s1,s2]       inject skills for this spawn only
             [--extra-mcp mcp1,mcp2]      inject MCP servers for this spawn only
             [--allow "Bash(rooks:*)"]     pre-allow tool patterns for this spawn
             [--title "Short name"]        name the mission in the missions list
  rooks send <mission_id> <input...>      send a follow-up to a running mission, without stopping its turn
  rooks steer <mission_id> <input...> [--json]
                                         redirect the turn running now: the agent changes course
                                         without waiting for its end
  rooks wait <mission_id> [--timeout=120] block until the turn ends, print assistant text
  rooks status <mission_id>               full mission detail
  rooks kill <mission_id>                 terminate a running mission
  rooks stop agent <name> | project <slug> [--json]
                                         technical stop of a scope: kills its running missions,
                                         empties its inbox, settles its open requests without a reply,
                                         blocks its PENDING/IN_PROGRESS tasks, switches off its triggers,
                                         cancels the workflow runs it takes part in and switches off
                                         the workflows that would start new ones
  rooks trace <traceId|missionId> [--json]
  rooks trace backfill [--days N]         explicitly replay cold events into spans

  rooks agent create <name> [flags]       new agent (prompt via --prompt-file or stdin)
  rooks agent update <name> [flags]       partial update (omit prompt to leave unchanged)
    flags: --backend NAME          --model SLUG   --permission-mode MODE
           --cwd PATH               --project SLUG
           --skills a,b,c           --mcp-servers a,b   (repeatable or comma-sep)
           --allowed-tools …        --disallowed-tools …   --excluded-mcp-servers …
           --look '{"shape":"round","color":"#d4a373","eyes":"happy","acc":"coffee"}'
                                    (mascot look; --look null clears it)
           --avatar emoji|image|mascot   (head shown; --avatar null = picture, logo, emoji, initial)
    (--skills is the whole checked set, stored as the agent's skill attachments:
     unlisted ones are detached; import mode / exclusion: rooks skill attach)
    (deletion: the app or the agent_delete tool; the agent waits in the trash)
  rooks agent trash list [--json]         deleted agents, newest first, with their trash id
  rooks agent trash restore <id>          puts one back under its name (refused if the name is taken)
  rooks agent trash purge <id>            deletes one for good (a person's gesture, refused to a mission)
  rooks agent set-scope <name> <scope>   set memory scope (NONE|SESSION|AGENT|GLOBAL)
  rooks agent set-avatar <name> <image>  set the profile picture (png/jpg/webp/gif, ≤ 2 MB, inside the cwd)
  rooks agent set-avatar <name> --clear  remove it
  rooks agent rename <old> <new>          rename an agent and its references (refused if <new>
                                         exists or a mission of <old> is running)
  rooks agent doc list <agent>            list the identity docs (*.md at ~/.rooks/agents/<agent>/)
  rooks agent doc get <agent> <file>      print one (SOUL.md, system-prompt.md…)
  rooks agent doc put <agent> <file> [--file PATH]
                                         write one; content from --file or stdin (≤ 2 MB). From a
                                         mission: its own agent, or one it orchestrates
  rooks agent doc rm <agent> <file>       delete one (system-prompt.md cannot be deleted)
  rooks agent export <name…> | --all [--out FILE] [--force]
                                         chosen agents (or all) to a zip another Rooks imports:
                                         prompt, identity docs, rules, skills, MCP servers, routines,
                                         picture, team; secrets by NAME only
  rooks agent import <FILE> [--yes] [--accept-cwd] [--prefix P] [--json]
                                         shows what would be created, asks, then imports
                                         (--accept-cwd takes the proposed working directories)
  rooks agent import --hermes [PROFILE…] [--yes] [--accept-cwd] [--prefix P] [--json]
                                         the same, read from Hermes on the machine running
                                         Rooks (all its profiles, or those named); no zip
  rooks agent export-skill [--out FILE] [--force]
                                         prints the rooks-export skill: give it to Hermes, Grok Bot
                                         or another agent, which then writes a zip to import

  rooks mission summarize <id> [--force]  compress the mission transcript for cross-LLM continuation
  rooks mission fork <id> --to <agent> [--message "..."]
                                         spawn a continuation on another agent, seeded with summary
  rooks mission search <text…>           full-text search in mission history
             [--agent NAME] [--project SLUG] [--since 7d|ISO] [--until …] [--limit N] [--json]
  rooks mission reindex [--batch N]       rebuild the mission search index
  rooks mission permission-mode get <id>  permission level of a mission, its source and the levels you may pick
  rooks mission permission-mode set <id> <mode>
                                         change it from the next message (plan, default, acceptEdits, auto…;
                                         never above your own level, others need agents:privileged-config)
  rooks mission egress <id> [--limit N] [--before ID]
                                         outbound connections the mission made through the egress proxy (off by default)

Skills (~/.rooks/skills/<id>/SKILL.md):
  rooks skill list                        list installed skills
  rooks skill get <id> [--file PATH]      print the SKILL.md body, or a file next to it
  rooks skill put <id> [--file PATH]      upsert; content from --file or stdin
         [--create-only]                  never replace: 409 when <id> already exists
  rooks skill rm <id>                     delete
  rooks skill attach <id> --scope global|project|role|agent [--target T]
         [--mode include|import] [--exclude]
                                          attach a skill: include = one catalogue line (body read
                                          with skill get), import = whole body in the prompt;
                                          --exclude removes a skill inherited from a wider scope
  rooks skill detach <attachment-id>      remove an attachment
  rooks skill attachments [--scope S] [--target T] [--skill ID]
                                          list attachments (json)
  rooks skill resolve <agent>             skills the agent spawns with, mode and origin (json)
  rooks skill reads <agent> [--json]      skill_get reads by the agent's missions over 30 days
                                          (a skill never read is absent: compare with resolve)

MCP servers (~/.rooks/mcp/<id>.json):
  rooks mcp list                          list installed MCP servers
  rooks mcp get <id>                      print the full config (json)
  rooks mcp put <id> [--file PATH]        upsert; JSON from --file or stdin
                                         (shape: {name?, description?, transport})
  rooks mcp rm <id>                       delete

Tasks (Kanban backlog):
  rooks task list [--status PENDING|IN_PROGRESS|DONE|BLOCKED]   (TODO = deprecated alias of PENDING)
  rooks task get <id>
  rooks task create --title TEXT --agent NAME [--type code|review|merge|research|doc|chore] [--project SLUG] [--description D] [--priority 1-5]
                   [--base BRANCH] [--todo TODO_ID] [--plan-group NAME]
                   [--model SLUG] [--permission-mode default|acceptEdits|bypassPermissions]
                   [--fallback-backend NAME|none] [--fallback-model SLUG]
                   [--deps id1,id2] [--scheduled ISO8601]
                   [--extra-skills s1,s2] [--extra-mcp mcp1,mcp2]
                   [--allow "Bash(rooks:*),Read(/tmp/*)"]
  rooks task done <id> [--comment TEXT | --comment-file PATH | --comment-stdin] [--merged-sha SHA] [--summary TEXT]
  rooks task block <id> --reason TEXT
  rooks task mark-as-done [id] --comment TEXT|--comment-file PATH|--comment-stdin [--verdict pass|changes_requested] [--merged-sha SHA] [--summary TEXT]
                                               closes THE current mission's task (no id to copy)
  rooks task mark-merged <id> --sha SHA [--comment TEXT]
                                               branch merged outside Rooks: records its merge commit
  rooks task mark-as-failed [id] --reason TEXT closes it as BLOCKED
  rooks task update <id> [--status ...] [--priority N] [--title ...] [--agent ...] [--type ...]
  rooks task delete <id> [--chain]           --chain: also the verification chain it heads

  rooks backends [--json]                      backends and models actually available

Series fallback plan (quota exhausted during a project):
  rooks series fallback list [--series ID]     rules in effect (default: THIS mission's series)
  rooks series fallback set --scope orchestrator|code|review|merge|doc|chore|*
                           --backend NAME [--model SLUG] [--group NAME] [--series ID] [--no-apply]
                           --backend none    → this scope does not fall back
                           --group NAME      → for ONE group of volets of the plan (read before
                                               the series rule; never with orchestrator)
                           applied at once to the pending tasks of that scope;
                           --no-apply records the rule without moving anything
  rooks series fallback clear --scope SCOPE [--group NAME] [--series ID]

Series role choices (who runs, for THIS series only — roles.json untouched):
  rooks series role list [--series ID]         choices in effect for the series
  rooks series role set --scope code|review|merge|research|doc|chore
                        [--backend NAME] [--model SLUG] [--group NAME] [--series ID]
                        task override > group choice > series role > project role > agent config
                        --group NAME → for ONE group of volets of the plan (tasks created
                                       with --plan-group NAME, and their chain)
  rooks series role clear --scope SCOPE [--group NAME] [--series ID]

Worktrees (git isolation per code task):
  rooks worktree info <task-id>                show path/branch/base/merged-sha
  rooks worktree create <task-id> [--base B]   force-create (dispatcher does it automatically for type=code)
  rooks worktree dispose <task-id> [--force]   unmounts worktree + local branch (post-merge)

Projects (agent roles per project):
  rooks project list                           lists configured projects
  rooks project roles <slug>                   shows the role→agent mapping
  rooks project set-role <slug> <role> <agent> [--model SLUG] [--permission-mode MODE]
                                             sets the agent + model/permission for a role
  rooks project create <slug> [--name TEXT] [--cwd PATH] [--workspace NAME] [--create-workspace]
                       [--color #RRGGBB] [--icon TEXT] [--speech TEXT] [--kind TEXT] [--status TEXT]
                                             registers a project; the cwd must already exist on the host
  rooks project update <slug> [--name TEXT] [--cwd PATH] [--workspace NAME] [--create-workspace]
                       [--color #RRGGBB] [--icon TEXT] [--speech TEXT] [--kind TEXT] [--status TEXT]
                                             edits what you pass; an empty value clears workspace, speech, icon, kind
  rooks workspace list [--json]                workspaces (poles) with their lead agent and projects
  rooks project demo                           creates the demo project (a small sample repository)

Routines (cron → creates a Kanban task on each due tick):
  rooks routine list
  rooks routine create --name TEXT --agent NAME --cron EXPR --prompt TEXT [--type ...] [--project SLUG]
  rooks routine update <id> [--cron ...] [--enabled true|false] ...
  rooks routine delete <id>

Workflows (graphs of nodes — agents, conditions, waits — run from a published version):
  rooks workflow list                          workflows you can see (json)
  rooks workflow get <slug>                    one workflow, with its draft
  rooks workflow create --file FILE            creates a workflow from a JSON definition
  rooks workflow publish <slug>                publishes the draft as the next version
  rooks workflow run <slug> [--input JSON]     starts a run of the published version
  rooks workflow runs <slug>                   the runs of a workflow
  rooks workflow status <run_id>               a run with its nodes, definition and spans
  rooks workflow cancel <run_id>               stops a run
  rooks workflow import pipeline|agent|routine <id>
                                             turns a pipeline, an agent or a routine into a workflow
  rooks workflow node done --output JSON [--route PORT]
                                             closes the current node of a run from inside its mission
                                             (reads ROOKS_WORKFLOW_RUN_ID and ROOKS_WORKFLOW_NODE_ID)

Triggers (source → filter → actions, run unattended):
  rooks trigger list [--source schedule|webhook|event]
  rooks trigger create --source schedule --name TEXT --cron EXPR [--tz ZONE] --action JSON ...
  rooks trigger create --source webhook --name TEXT --slug NAME --auth github|gitlab|standard|generic
                       [--filter JSON] --action JSON ...   prints the secret ONCE
  rooks trigger create --source event --name TEXT --event KIND [--filter JSON] --action JSON ...
                       shortcuts instead of --action: --todo TEXT [--project SLUG] | --notify TITLE
                       | --task-agent NAME --prompt TEXT
                       | --script BIN [--arg A ...] --cwd DIR [--env SECRET ...] [--timeout SECONDS]
                         [--allow-overlap] [--no-failure-alert]   runs a program, no agent (scripts:run);
                         from an agent's mission it becomes a proposal the user approves
  rooks trigger proposals [--status pending|applied|dismissed]
                                             scripts agents asked for, waiting for you
  rooks trigger approve|reject <proposal-id> creates the trigger as yours, or drops it (never from a mission)
  rooks trigger test <id|slug> [--payload JSON] [--header Name:Value ...] [--execute]
                                             dry run unless --execute
  rooks trigger remove <id|slug>

Pipelines (multi-agent workflow templates → Kanban tasks):
  rooks pipeline list
  rooks pipeline get <id>
  rooks pipeline create --name TEXT --file pipeline.json [--description D]
  rooks pipeline run <id> [--input JSON | --input-file PATH]
  rooks pipeline run-status <run_id>
  rooks pipeline delete <id>

Agent messages (async inbox — doesn't block the parent's tokens):
  rooks msg send <to_agent> <payload...>     fire-and-forget to an agent's inbox
                                            [--kind msg|request|response]
                                            [--in-reply-to <msg_id>]
                                            [--to-mission <mid>]
  rooks msg recv [--to <agent>] [--from <agent>] [--status pending|picked] [--limit N]
  rooks msg pick <message_id>                marks picked + returns the payload (atomic)
  rooks msg reply <message_id> <payload...>  sends a response to the message's from_agent

Notifications (human center — sidebar canvas):
  rooks notify report  <title…> [--body TEXT] [--task-id ID]    end-of-task report, result
  rooks notify alert   <title…> [--body TEXT] [--urgent] [--task-id ID]   blocking alert
  rooks notify action_required <title…> [--body TEXT] [--urgent] [--dismiss-on reply,task_done] [--ttl MIN]
                       closes by itself on the human's reply in the mission (default), the task's DONE, or after --ttl (default 24 h with no trigger, 7 days with one)
    --mission-id is auto-injected from ROOKS_MISSION_ID if not provided.

PROJECT TO DO (a project's idea notebook — nothing here is ever dispatched):
  rooks project-todo list [--status open|done|promoted|all] [--project SLUG] [--json]
  rooks project-todo add <text...> [--project SLUG] [--notes TEXT]
  rooks project-todo update <id> [<text...>] [--project SLUG] [--notes TEXT] [--status open|done]
  rooks project-todo done <id> [--undo]        checks / unchecks the idea
  rooks project-todo promote <id> --agent NAME [--type TYPE] [--priority N] [--base REF] [--pipeline P]
                                               the idea becomes a PENDING task, and keeps the link to it
  rooks project-todo rm <id>

Users (daemon-token — the operator's account recovery; administering accounts is the Multi-user
plugin's, from its page in the app):
  rooks setup-token                          one-time token the first-run form asks for on an exposed install
  rooks user list                            accounts (json)
  rooks user reset-password <email-or-id>    temporary password, printed once

Paired devices (another Rooks that drives this machine — a headless server has no screen to click):
  rooks device pair [--user EMAIL-OR-ID] [--json]
                                             one-time pairing code (5 min) + this daemon's tailnet
                                             address; --user: a superadmin issues it for that account
  rooks device list [--json]                 devices, their state and last connection
  rooks device rename <id> <name>
  rooks device revoke <id>                   cut off at once; pair again with a new code

Subscription accounts (superadmin / daemon-token — who may use which account):
  rooks backend-account list [--json]        accounts, their state and who they are assigned to
  rooks backend-account grant <id> --user EMAIL-OR-ID[,…]
                                             lets these users use the account (adds to the list)
  rooks backend-account revoke <id> --user EMAIL-OR-ID[,…]
                                             takes it back from them
      <id> is the account id or its instance (claude@<id>); signing in stays in the app.

Backends you add yourself (a person's gesture: a mission's token is refused with operator_only):
  rooks backend add <name> --base-url URL --protocol anthropic|openai-responses
                    [--key-from-stdin | --no-key] [--id ID] [--models A,B]
                    [--default-model SLUG] [--brand KEY] [--icon VALUE] [--json]
      the key is NEVER an argument: a terminal asks for it (input hidden), or pipe it:
        printf %s "$KEY" | rooks backend add DeepSeek --base-url https://api.deepseek.com/anthropic \
          --protocol anthropic --key-from-stdin
      it goes to the vault, reserved to this backend, and is never shown again.
  rooks backend list [--json]                the backends you added, their state, never a key
  rooks backend test <id> [--json]           one call to its model listing, with its saved key;
                                             exit code 0 only if the endpoint accepts the key
  rooks backend test --base-url URL --protocol anthropic|openai-responses
                    [--key-from-stdin | --no-key] [--json]
                                             the same, before saving anything
  rooks backend rm <id> [--json]             removes it; a key added with it leaves the vault

Secrets vault (write-only: no command ever prints a stored value):
  rooks secret list [--project SLUG] [--agent NAME] [--json]
  rooks secret set <NAME> [--scope global|project:<slug>|agent:<name>]
                          [--mode inject|broker] [--note TEXT] --stdin
      the value is ALWAYS piped on stdin, never an argument:
        printf %s "$TOKEN" | rooks secret set GITHUB_TOKEN --scope global --stdin
      no --scope at all = the daemon alone, which no agent ever receives.
  rooks secret grant <NAME> --scope …        opens it to one more scope
      backend:<id> is a reservation, not an audience: the entry then reaches
      only that backend's own process, for the missions its other grants admit.
  rooks secret revoke <NAME> --scope …       closes that scope again
  rooks secret rm <NAME>
  rooks secret rekey                         new master key, staged then promoted
  rooks secret import-env [--delete-source]  imports ~/.rooks/secrets.env, no grant

Backend sign-in (write-only: the stored token is never printed):
  rooks auth claude-token set      reads the token printed by 'claude setup-token'
                                   from stdin, or asks for it (hidden) in a terminal:
        claude setup-token          # then paste the token when asked
        printf %s "$TOKEN" | rooks auth claude-token set
      every claude mission receives it; needed on macOS for Rooks to run with
      no session open. Then run 'rooks service install' to switch the service.
  rooks auth claude-token status   configured or not, never the value
  rooks auth claude-token clear

Memory (rules injected into agents — DIRECT write to the database):
  rooks memory rule add <text…> [--scope agent|project|role|global] [--agent NAME]
                               [--project SLUG] [--role ROLE]
                               [--kind pitfall|decision|preference] [--tier normal|core]
                               [--text-file PATH] [--json]
      defaults: --scope agent, --kind pitfall, agent = $ROOKS_AGENT, project = $ROOKS_PROJECT.
      An exact duplicate on the same scope is refused (exit 3).
  rooks memory rule list [--scope …] [--agent NAME] [--project SLUG] [--json]
  rooks memory rule rm <id>
  rooks memory search <query…>                 cross-cutting search (rules + facts)
  rooks memory overview                        counters + pending proposals
  rooks memory show <project|agent> <id> [file]  reads the reference .md files

Project's embedded browser:
  rooks browser status [<slug>] [--json]     does the project have a browser up?
  rooks browser start  [<slug>]              starts it (persistent profile, sessions kept)
  rooks browser stop   [<slug>]              stops it (the profile itself survives)
  rooks browser list   [--json]              all known sessions
  rooks browser recording get <id>           the recording your conversion mission learns (that mission only)
  rooks browser annotations get [<id>] [--batch <bab-…>] [--status pending|resolved|dismissed] [--json]
                                             annotations the user sent this mission (or its agent)
  rooks browser annotations resolve <id> --summary "<what you changed>"
  rooks browser annotations dismiss <id> --reason "<why not>"
    default slug: $ROOKS_PROJECT, otherwise derived from cwd.

Widget arrangement of the user's screen (an agent's mission owner):
  rooks widgets get [--view PATH] [--project SLUG]
                                             zones, cards, catalog, chat columns
  rooks widgets propose [--view PATH] [--project SLUG] [--note TEXT] [--file F]
                                             a card the user applies (JSON on stdin)
  rooks widgets preset-save <name> [--view PATH] [--project SLUG] [--replace]
                                             current arrangement → Layouts menu

Island workspace of the user's screen (an agent's mission owner):
  rooks islands get [--view PATH] [--project SLUG]
                                             islands, tabs, focus, content types, limits
  rooks islands propose [--view PATH] [--project SLUG] [--note TEXT] [--file F]
                                             a card the user applies (JSON on stdin:
                                             {open: {...}} or {layout: {...}})
  rooks islands propose --arrangement ID [--view PATH] [--project SLUG] [--note TEXT]
                                             a card recalling a named arrangement on the view
  rooks setup avatar|soul|team|finish        the main agent's own setup conversation (refused elsewhere)
  rooks navigate routes                      pages of the app an agent can send the user to
  rooks navigate go <path> [--param k=v]... [--note TEXT]
                                             ask the user to go there (a card they follow)
  rooks ui-doc render <file.html> [--title TEXT] [--reply]
  rooks ui-doc get <id>
                                             shows an HTML document as a card in this mission's chat
  rooks nav get                              pages hidden from the side menu, and its layout
  rooks nav propose [--hide <path>]... [--order <p,p,---,p>] [--footer <p,p>] [--note TEXT]
                                             proposes the complete list of hidden pages (no flag = show all),
                                             the main list and the bottom of the menu (--- = a separator)
  rooks onboarding profile [set <developer|automation|beginner>]
                                             the onboarding profile of the account
  rooks islands preset-save <name> [--view PATH] [--project SLUG] [--replace]
                                             current view (islands included) → Layouts menu
  rooks islands arrangements [--full]        the account's named island arrangements
  rooks islands arrangement-save <name> [--view PATH] [--project SLUG] [--file LAYOUT.json] [--replace]
                                             current islands of a view, or a layout ({root, focus?}),
                                             → Island arrangements menu (never the main menu)

Rooks documentation (the pages of the installed version, read offline, no daemon needed):
  rooks docs search <words…> [--limit N] [--json]
                                             pages that match, with an excerpt (same as docs_search)
  rooks docs read [<route>] [--heading TEXT]  a page as Markdown, or one section of it; without a
                                             route, the list of every page (same as docs_read)

Resources (anti-saturation guard for the machine):
  rooks export [--out F] [--with-archive]    portable archive of ~/.rooks (secrets excluded)
  rooks import F [--to DIR] [--force] [--no-projects]
                                             restores an archive on this machine
  rooks backup enable                        nightly routine 03:30, on by default (re-arms it if turned off)
  rooks backup status [--json]               state, next run, archives under backups/
  rooks doctor [--json]                      binaries, host capabilities, config
  rooks doctor --report [--save F]           diagnostic report to paste in a support request
  rooks logs [--desktop|--prompts|--supervisor] [-n N]
                                             newest log lines first (default: daemon, 100)

Third-party plugins (hot-loaded, no daemon restart):
  rooks plugin list [--json]                 installed, version, enabled, refused
  rooks plugin add <spec> [--yes]            npm install (name, .tgz, .zip or dir)
  rooks plugin remove <id>                   npm uninstall (data kept)
  rooks plugin enable <id> | disable <id>    toggles in rooks.config.json
  rooks plugin check <dir> [--json] [--strict] [--deny <word>]…
                                             pre-ship check of a plugin folder: manifest, engines.node,
                                             signature, shipped files, author and machine data; never runs it
  rooks plugin sign <dir>                    signs with ~/.rooks-signing/plugins.key
  rooks plugin verify <id>                   verifies without loading the plugin

Web app served by the daemon (NEVER an orchestrator restart):
  rooks app status [--json]                  module active? app built? child alive?
  rooks app restart                          signals the web-app child (or rearms a supervisor that gave up)

Daemon service (systemd user unit on Linux, launchd agent on macOS — a launchd
                daemon once a claude token is set —, scheduled task at boot on Windows):
  rooks service install [--dry-run] [--allow-temp-home] [--force]
                                             writes the unit/plist and starts it; refuses a ROOKS_HOME
                                             under the system temporary folder without the flag, and a
                                             service that belongs to another Rooks installation without --force
  rooks service uninstall [--force]          stops and removes it, ~/.rooks untouched; same refusal
  rooks service stop                         ends the daemon and its programs, keeps the service registered (Windows: the task is disabled); the app starts it again at its next launch
  rooks service start                        starts a stopped service again
  rooks service status [--json]              installed? running?
  rooks service repair                       Windows: seals the session witness again when the service waits for a logon that never comes

Bundled modules (writes rooks.config.json — effective on next daemon boot):
  rooks module list [--json]                 catalog, wanted state, actual state + reason
  rooks module enable <name> | disable <name>  toggles in rooks.config.json

Secrets broker (the daemon acts, you never hold the value):
  git config credential.helper "rooks git-credential"
                                             git then authenticates through the
                                             vault: no token in a remote URL,
                                             a command line or the environment

Licence:
  rooks license status                       shows your licence status, edition and expiry date
  rooks license deactivate                   release this machine (the seat transfers once its last token lease expires)
  rooks license install <file>               installs a licence file
  rooks license activate <key>               activates Rooks with your licence key

  rooks health [--json]                      day/night profile, Rooks cgroups memory
                                            and CPU, live missions, OOM

Remote daemon:
  rooks --daemon <url|name> <cmd> …       targets a daemon (URL or profile)
  rooks daemon add <name> <url> <token>   profile in ~/.rooks/cli-daemons.json (0600)
  rooks daemon list                       profiles (url only, never the token)

Daemon address: --daemon > ROOKS_API > rooks.config.json daemon.listen
                > desktop-bootstrap.json daemonPort > http://localhost:3000
                Files are read under ROOKS_HOME (default ~/.rooks).
Authentication: named profile token, otherwise ROOKS_API_TOKEN or daemon-token.
                daemon-token is only sent to the local listener, whether the
                target comes from --daemon <url> or ROOKS_API.
                For remote URLs, set ROOKS_API_TOKEN or use a named profile.
```

## Additional command usage from source

These blocks supplement the root help (for example pipeline flags). Some commands have no separate usage block. The generator reads them without invoking them.

### rooks spawn agent input... [--idempotency-key hash]

```text
usage: rooks spawn <agent> <input...> [--idempotency-key <hash>]
       [--model SLUG] [--backend NAME] [--title "Short name"]
       [--extra-skills skill1,skill2] [--extra-mcp mcp1,mcp2]
       [--allow "Bash(rooks:*),Read(/tmp/*)"]
```

### rooks send mission_id input...

```text
usage: rooks send <mission_id> <input...>
```

### rooks steer mission_id input... [--json]

```text
usage: rooks steer <mission_id> <input...> [--json]
```

### rooks status mission_id

```text
usage: rooks status <mission_id>
```

### rooks kill mission_id

```text
usage: rooks kill <mission_id>
```

### rooks stop agent name | rooks stop project slug [--json]

```text
usage: rooks stop agent <name> | rooks stop project <slug> [--json]
```

### rooks wait mission_id [--timeout=120] [--json]

```text
usage: rooks wait <mission_id> [--timeout=120] [--json]
```

### rooks skill get id [--file PATH]

```text
usage: rooks skill get <id> [--file PATH]
```

### rooks skill put id [--file PATH] [--create-only]  (or pipe content on stdin)

```text
usage: rooks skill put <id> [--file PATH] [--create-only]  (or pipe content on stdin)
```

### rooks skill rm id

```text
usage: rooks skill rm <id>
```

### rooks skill attach id --scope S [--target T] [--mode M] [--exclude]

```text
usage: rooks skill attach <id> --scope S [--target T] [--mode M] [--exclude]
  S: global|project|role|agent   M: include|import
```

### rooks skill detach attachment-id

```text
usage: rooks skill detach <attachment-id>
```

### rooks skill resolve agent

```text
usage: rooks skill resolve <agent>
```

### rooks skill reads agent [--json]

```text
usage: rooks skill reads <agent> [--json]
```

### rooks skill list|get|put|rm|attach|detach|attachments|resolve|reads …

```text
usage: rooks skill <list|get|put|rm|attach|detach|attachments|resolve|reads> …
```

### rooks mcp get id

```text
usage: rooks mcp get <id>
```

### rooks mcp put id [--file PATH]  (or pipe JSON on stdin)

```text
usage: rooks mcp put <id> [--file PATH]  (or pipe JSON on stdin)
```

### rooks mcp rm id

```text
usage: rooks mcp rm <id>
```

### rooks mcp list|get|put|rm …

```text
usage: rooks mcp <list|get|put|rm> …
```

### rooks agent create name [--prompt-file PATH] [--backend …] [--model …] …

```text
usage: rooks agent create <name> [--prompt-file PATH] [--backend …] [--model …] …
       (system prompt: pipe on stdin or pass --prompt-file)
```

### rooks agent update name [--prompt-file PATH] [--backend …] [--model …] …

```text
usage: rooks agent update <name> [--prompt-file PATH] [--backend …] [--model …] …
       (everything optional; supply only the fields to change)
```

### rooks agent set-scope name NONE|SESSION|AGENT|GLOBAL

```text
usage: rooks agent set-scope <name> <NONE|SESSION|AGENT|GLOBAL>
```

### rooks agent set-avatar name image-file | rooks agent set-avatar name --clear

```text
usage: rooks agent set-avatar <name> <image-file> | rooks agent set-avatar <name> --clear
```

### rooks agent rename old-name new-name

```text
usage: rooks agent rename <old-name> <new-name>
```

### rooks agent …

```text
usage: rooks agent <create|update|set-scope|set-avatar|rename|doc|trash|export|import|export-skill> <name> …
       (deletion: the app or the agent_delete tool, which move the agent to the trash)
```

### rooks mission summarize mission_id [--force]

```text
usage: rooks mission summarize <mission_id> [--force]
```

### rooks mission fork mission_id --to agent [--message "..."]

```text
usage: rooks mission fork <mission_id> --to <agent> [--message "..."]
```

### rooks mission search text… [--agent NAME] [--project SLUG]

```text
usage: rooks mission search <text…> [--agent NAME] [--project SLUG]
                            [--since 7d|ISO] [--until 7d|ISO] [--limit N] [--json]
```

### rooks mission egress mission_id [--limit N] [--before ID]

```text
usage: rooks mission egress <mission_id> [--limit N] [--before ID]
```

### rooks mission summarize|fork|search|reindex|permission-mode|egress …

```text
usage: rooks mission <summarize|fork|search|reindex|permission-mode|egress> …
```

### rooks task get id

```text
usage: rooks task get <id>
```

### rooks task create --title TEXT --agent NAME [--description D] [--priority 1-5]

```text
usage: rooks task create --title TEXT --agent NAME [--description D] [--priority 1-5]
       [--type code|review|merge|research|doc|chore] [--project SLUG] [--base BRANCH]
       [--pipeline full|code-self|code-group] [--group-id ID] [--plan-group NAME] [--todo ID]
       [--backend NAME] [--model SLUG] [--permission-mode default|acceptEdits|bypassPermissions]
       [--fallback-backend NAME|none] [--fallback-model SLUG]
       [--deps id1,id2] [--scheduled ISO] [--extra-skills s1,s2] [--extra-mcp m1,m2]
       [--allow "Bash(rooks:*),Read(/tmp/*)"]
```

### rooks task done id [--comment TEXT | --comment-file PATH | --comment-stdin] …

```text
usage: rooks task done <id> [--comment TEXT | --comment-file PATH | --comment-stdin] [--merged-sha SHA] [--summary TEXT]
```

### rooks task mark-merged id --sha SHA [--comment TEXT]

```text
usage: rooks task mark-merged <id> --sha SHA [--comment TEXT]
```

### rooks task mark-as-done [id] --comment TEXT | --comment-file PATH | --comment-stdin

```text
usage: rooks task mark-as-done [id] --comment TEXT | --comment-file PATH | --comment-stdin
       [--verdict pass|changes_requested] [--merged-sha SHA] [--summary TEXT]
```

### rooks task mark-as-failed [id] --reason TEXT

```text
usage: rooks task mark-as-failed [id] --reason TEXT
```

### rooks task block id --reason ...

```text
usage: rooks task block <id> --reason ...
```

### rooks task update id [--status ...] [--priority N] [--title ...] …

```text
usage: rooks task update <id> [--status ...] [--priority N] [--title ...] [--scheduled ISO | --clear-scheduled]
```

### rooks task delete id [--chain]

```text
usage: rooks task delete <id> [--chain]
```

### rooks task …

```text
usage: rooks task <list|get|create|done|block|mark-as-done|mark-as-failed|mark-merged|update|delete> …
```

### rooks series fallback set --scope orchestrator|code|review|merge|doc|chore|* 

```text
usage: rooks series fallback set --scope orchestrator|code|review|merge|doc|chore|* 
         --backend NAME [--model SLUG] [--group NAME] [--series ID] [--no-apply]
       --backend none  → this scope does not fall back (failure accepted)
       --group NAME    → rule of ONE group of volets of the plan (never with orchestrator)
       --no-apply      → record the rule only, do not move the pending tasks
```

### rooks series fallback clear --scope SCOPE [--group NAME] [--series ID]

```text
usage: rooks series fallback clear --scope SCOPE [--group NAME] [--series ID]
```

### rooks series fallback list|set|clear …

```text
usage: rooks series fallback <list|set|clear> …
```

### rooks series role set --scope code|review|merge|research|doc|chore

```text
usage: rooks series role set --scope code|review|merge|research|doc|chore
         [--backend NAME] [--model SLUG] [--group NAME] [--series ID]   (at least one of backend/model)
       --group NAME → choice of ONE group of volets of the plan (tasks created with --plan-group)
```

### rooks series role clear --scope SCOPE [--group NAME] [--series ID]

```text
usage: rooks series role clear --scope SCOPE [--group NAME] [--series ID]
```

### rooks series role list|set|clear …

```text
usage: rooks series role <list|set|clear> …
```

### rooks series fallback|role list|set|clear …

```text
usage: rooks series <fallback|role> <list|set|clear> …
```

### rooks worktree info task-id

```text
usage: rooks worktree info <task-id>
```

### rooks worktree create task-id [--base BRANCH]

```text
usage: rooks worktree create <task-id> [--base BRANCH]
```

### rooks worktree dispose task-id [--force]

```text
usage: rooks worktree dispose <task-id> [--force]
```

### rooks worktree info|create|dispose task-id …

```text
usage: rooks worktree <info|create|dispose> <task-id> …
```

### rooks project roles slug

```text
usage: rooks project roles <slug>
```

### rooks project set-role slug code|review|merge|research|doc|chore agent-name

```text
usage: rooks project set-role <slug> <code|review|merge|research|doc|chore> <agent-name>
       [--backend NAME] [--model SLUG] [--permission-mode default|acceptEdits|bypassPermissions]
       rooks project set-role <slug> <role> ""   (to clear)
```

### rooks workspace list [--json]

```text
usage: rooks workspace list [--json]
```

### rooks project list|roles|set-role|create|update|demo …

```text
usage: rooks project <list|roles|set-role|create|update|demo> …
```

### rooks msg send to_agent payload...

```text
usage: rooks msg send <to_agent> <payload...>
       [--kind msg|request|response] [--in-reply-to <msg_id>] [--to-mission <mid>]
```

### rooks msg pick message_id

```text
usage: rooks msg pick <message_id>
```

### rooks msg reply message_id payload...

```text
usage: rooks msg reply <message_id> <payload...>
```

### rooks msg send|recv|pick|reply …

```text
usage: rooks msg <send|recv|pick|reply> …
```

### rooks pipeline get id

```text
usage: rooks pipeline get <id>
```

### rooks pipeline create --name TEXT --file PATH [--description D]

```text
usage: rooks pipeline create --name TEXT --file PATH [--description D]
       (--file points to a JSON file with the pipeline definition: { steps: [...] })
```

### rooks pipeline run id [--input JSON | --input-file PATH]

```text
usage: rooks pipeline run <id> [--input JSON | --input-file PATH]
```

### rooks pipeline run-status run_id

```text
usage: rooks pipeline run-status <run_id>
```

### rooks pipeline delete id

```text
usage: rooks pipeline delete <id>
```

### rooks pipeline list|get|create|run|run-status|delete …

```text
usage: rooks pipeline <list|get|create|run|run-status|delete> …
```

### rooks routine create --name TEXT --agent NAME --cron EXPR --prompt TEXT

```text
usage: rooks routine create --name TEXT --agent NAME --cron EXPR --prompt TEXT
       [--type code|review|merge|research|doc|chore] [--project SLUG] [--enabled true|false]
```

### rooks routine update id [--name ...] [--cron ...] [--enabled true|false] ...

```text
usage: rooks routine update <id> [--name ...] [--cron ...] [--enabled true|false] ...
```

### rooks routine delete id

```text
usage: rooks routine delete <id>
```

### rooks routine list|create|update|delete …

```text
usage: rooks routine <list|create|update|delete> …
```

### rooks trigger test id|slug [--payload JSON] [--header Name:Value ...] [--execute]

```text
usage: rooks trigger test <id|slug> [--payload JSON] [--header Name:Value ...] [--execute]
```

### rooks trigger remove id|slug

```text
usage: rooks trigger remove <id|slug>
```

### rooks trigger list|create|test|remove|proposals|approve|reject …

```text
usage: rooks trigger <list|create|test|remove|proposals|approve|reject> …
```

### rooks project-todo add text... [--project SLUG] [--notes TEXT]

```text
usage: rooks project-todo add <text...> [--project SLUG] [--notes TEXT]
```

### rooks project-todo update id [text...] [--text TEXT] [--project SLUG] [--notes TEXT] …

```text
usage: rooks project-todo update <id> [<text...>] [--text TEXT] [--project SLUG] [--notes TEXT] [--status open|done]
```

### rooks project-todo done id [--undo]

```text
usage: rooks project-todo done <id> [--undo]
```

### rooks project-todo promote id --agent NAME [--type TYPE] [--priority N] [--base REF] …

```text
usage: rooks project-todo promote <id> --agent NAME [--type TYPE] [--priority N] [--base REF] [--pipeline P] [--project SLUG]
```

### rooks project-todo rm id

```text
usage: rooks project-todo rm <id>
```

### rooks project-todo list|add|update|done|promote|rm …

```text
usage: rooks project-todo <list|add|update|done|promote|rm> …
```

### rooks memory rule add text… [--scope agent|project|role|global] [--agent NAME] …

```text
usage: rooks memory rule add <text…> [--scope agent|project|role|global] [--agent NAME] [--project SLUG] [--role ROLE] [--kind pitfall|decision|preference] [--tier normal|core]
```

### rooks memory rule rm id

```text
usage: rooks memory rule rm <id>
```

### rooks memory rule add text… | list | rm id

```text
usage: rooks memory rule <add <text…> | list | rm <id>>
```

### rooks memory search query…

```text
usage: rooks memory search <query…>
```

### rooks memory show project|agent id [file]

```text
usage: rooks memory show <project|agent> <id> [file]
```

### rooks memory rule add|list|rm | search query… | overview | show project|agent id …

```text
usage: rooks memory <rule <add|list|rm> | search <query…> | overview | show <project|agent> <id> [file]>
```

### rooks browser recording get id

```text
usage: rooks browser recording get <id>
```

### rooks browser annotations get [id] [--batch id] [--status s] | resolve id --summary …

```text
usage: rooks browser annotations get [<id>] [--batch <id>] [--status <s>] | resolve <id> --summary <text> | dismiss <id> --reason <text>
```

### rooks browser status|start|stop|list [slug] [--json] | recording get id | …

```text
usage: rooks browser status|start|stop|list [<slug>] [--json] | recording get <id> | annotations get|resolve|dismiss
```

### rooks import archive.tar.gz [--to DIR] [--force] [--no-projects]

```text
usage: rooks import <archive.tar.gz> [--to DIR] [--force] [--no-projects]
```

### rooks docs search words... [--limit N] [--json]

```text
usage: rooks docs search <words...> [--limit N] [--json]
       rooks docs read [<route>] [--heading TEXT]
```

### rooks widgets preset-save name [--view PATH] [--project SLUG] [--replace]

```text
usage: rooks widgets preset-save <name> [--view PATH] [--project SLUG] [--replace]
```

### rooks widgets get|propose|preset-save [--view PATH] [--project SLUG]

```text
usage: rooks widgets <get|propose|preset-save> [--view PATH] [--project SLUG]
```

### rooks islands preset-save name [--view PATH] [--project SLUG] [--replace]

```text
usage: rooks islands preset-save <name> [--view PATH] [--project SLUG] [--replace]
```

### rooks islands arrangement-save name [--view PATH] [--project SLUG] …

```text
usage: rooks islands arrangement-save <name> [--view PATH] [--project SLUG] [--file LAYOUT.json] [--replace]
```

### rooks islands get|propose|preset-save|arrangements|arrangement-save [--view PATH] …

```text
usage: rooks islands <get|propose|preset-save|arrangements|arrangement-save> [--view PATH] [--project SLUG]
```

### rooks navigate go path [--param k=v]... [--note TEXT]

```text
usage: rooks navigate go <path> [--param k=v]... [--note TEXT]
```

### rooks navigate routes|go

```text
usage: rooks navigate <routes|go>
```

### rooks nav get|propose

```text
usage: rooks nav <get|propose>
```

### rooks ui-doc render file.html [--title TEXT] [--reply] | rooks ui-doc get id

```text
usage: rooks ui-doc render <file.html> [--title TEXT] [--reply] | rooks ui-doc get <id>
```

### rooks onboarding profile [set developer|automation|beginner]

```text
usage: rooks onboarding profile [set <developer|automation|beginner>]
```

### rooks setup avatar|soul|team --coder NAME --reviewer NAME|finish [--no-tour]

```text
usage: rooks setup <avatar|soul|team --coder NAME --reviewer NAME|finish [--no-tour]>
```

### rooks backup enable|status [--json]

```text
usage: rooks backup <enable|status> [--json]
```

### rooks plugin add spec [--yes]

```text
usage: rooks plugin add <spec> [--yes]
```

### rooks plugin remove id

```text
usage: rooks plugin remove <id>
```

### rooks plugin sign dir

```text
usage: rooks plugin sign <dir>
```

### rooks plugin verify id

```text
usage: rooks plugin verify <id>
```

### rooks auth claude-token set|clear|status

```text
usage: rooks auth claude-token set|clear|status
```

### rooks secret set NAME [--scope global|project:slug|agent:name] …

```text
usage: rooks secret set <NAME> [--scope global|project:<slug>|agent:<name>] [--mode inject|broker] --stdin
```

### rooks secret rm NAME

```text
usage: rooks secret rm <NAME>
```

### rooks user reset-password email-or-id

```text
usage: rooks user reset-password <email-or-id>
```

### rooks backend-account list|grant|revoke …

```text
usage: rooks backend-account list|grant|revoke …
```

### rooks user list|reset-password …

```text
usage: rooks user list|reset-password …
```

### rooks secret list|set|grant|revoke|rm|rekey|import-env …

```text
usage: rooks secret <list|set|grant|revoke|rm|rekey|import-env> …
```

### rooks license install file

```text
usage: rooks license install <file>
```

### rooks license activate key

```text
usage: rooks license activate <key>
```

### rooks license status|install file|activate key

```text
usage: rooks license status|install <file>|activate <key>
```

### rooks logs [--desktop|--prompts|--supervisor] [-n N]

```text
usage: rooks logs [--desktop|--prompts|--supervisor] [-n N]
```

### rooks trace backfill [--days N]

```text
usage: rooks trace backfill [--days N]
```

### rooks trace traceId|missionId [--json]

```text
usage: rooks trace <traceId|missionId> [--json]
```

### rooks daemon add name url token

```text
usage: rooks daemon add <name> <url> <token>
```

### rooks daemon list

```text
usage: rooks daemon list
       rooks daemon add <name> <url> <token>
```

### rooks --daemon url|name command …

```text
usage: rooks --daemon <url|name> <command> …
```
