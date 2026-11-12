/**
 * "copilot" dialect — the official GitHub Copilot CLI (`@github/copilot`), one
 * shot per turn.
 *
 * The CLI carries the user's own Copilot subscription, personal or corporate:
 * `copilot login` runs the device flow, keeps the token in the OS keychain (or
 * in `~/.copilot/config.json` when there is none), refreshes it and honours the
 * organisation's SSO. Rooks writes no token handling of its own — that is the
 * whole reason this backend is a dialect over the public CLI rather than a
 * profile over the `copilot_internal` API, which is an undocumented endpoint
 * where the tester, on a company account, would take the sanction
 * (`docs/BACKENDS-OUVERTS.md` § 5).
 *
 * ── What was verified against the binary (copilot 1.0.89) ─────────────────
 *
 *  1. Piped stdin is the prompt when `-p` is absent, `--output-format json`
 *     then emits JSONL. The runner closes stdin after writing (one-shot
 *     backend), so no argv ceiling applies to the message.
 *  2. `COPILOT_CUSTOM_INSTRUCTIONS_DIRS=<dir>` loads
 *     `<dir>/instructions/*.instructions.md` (checked with `copilot instruction
 *     list --json`); a bare `<dir>/copilot-instructions.md` is NOT picked up.
 *     That is the system prompt's channel: it never travels through argv and is
 *     re-read on every resumed turn.
 *  3. `--resume=<id>` on an unknown id exits 1 before any JSONL, with
 *     "No session, task, or name matched '<id>'" on stderr.
 *  4. Authentication and organisation-policy refusals are plain text on stderr
 *     ("Access denied by policy settings"), exit 1, no JSONL.
 *  5. An organisation may forbid third-party MCP servers ("Third-party MCP
 *     servers are disabled by your organization's Copilot policy", a
 *     `session.warning`). The Rooks MCP servers are then absent; the agent
 *     still has the `rooks` CLI through its shell.
 *
 * ── What comes from the documented schema, not from a live turn ────────────
 *
 * The event shapes (`assistant.message`, `tool.execution_complete`,
 * `session.error`, the final top-level `result`) follow the Copilot SDK's
 * session-events reference: no account with a Copilot seat was available to
 * capture a real turn. `__fixtures__/copilot.jsonl` is assembled from that
 * reference. Every field is read defensively, and a line we do not recognise is
 * dropped rather than guessed at.
 *
 * The session id only appears in that final `result` — nothing earlier in the
 * stream names it. The dialect therefore announces its `system:init` there,
 * which is enough: the orchestrator records the id whenever it arrives, and the
 * chat keeps the LAST init it sees.
 */
import { randomUUID } from 'node:crypto';
import { createCopilotModels } from './models.js';
import { createCopilotUsage } from './usage.js';
import { manifestBackend } from './manifest.js';
/** What the core reads about this provider (C1, C2): the manifest's entry, the one place it is
 *  written (`manifest.js`; why its values are what they are: `profile.js`). */
const COPILOT = manifestBackend('copilot');
/**
 * Hard guardrails, applied whatever the mode: a `--deny-tool` wins over every
 * allow rule, `--allow-all-tools` included. They matter most in
 * `bypassPermissions`, the one mode that allows everything; in the other modes
 * the allowlist already leaves these commands out. `shell(<stem>:*)` matches
 * the stem followed by a space, a bare `shell(<command>)` that command.
 */
const COPILOT_DENY_RULES = [
    'shell(sudo:*)',
    'shell(mkfs:*)',
    'shell(shutdown:*)',
    'shell(reboot:*)',
    'shell(rm -rf /)',
    'shell(rm -rf ~)',
    // A task runs UNDER the orchestrator: restarting it kills its own mission
    // mid-flight (AGENTS.md rule 1).
    'shell(systemctl --user restart rooks-orchestrator)',
    'shell(systemctl --user stop rooks-orchestrator)',
    // The same through Rooks's own CLI: the service (install, uninstall,
    // restart), an approved update and the web app all restart under the mission.
    ...['service', 'update', 'daemon', 'app restart'].flatMap((cmd) => [`shell(rooks ${cmd})`, `shell(rooks ${cmd}:*)`]),
];
/**
 * The allow / deny rules of a launch, in the CLI's syntax. They depend on the product's command
 * policy (`ctx.provider.mcp().commandPolicy`: the Rooks CLI commands a mission needs) and on the
 * name of the forms server, both handed over by the daemon at each launch.
 *
 * @param {{ novaCliCommands: readonly string[] }} policy
 * @param {string} formsServer
 */
export function copilotRules(policy, formsServer) {
    /** MCP servers a read-only agent may still call: the Rooks bridge (Kanban,
     *  questions to the human) and the project's semantic index. */
    const READ_ONLY_MCP = ['rooks', formsServer, 'grepai'];
    /**
     * The Rooks CLI commands a mission needs, as `<command> <subcommand>` after
     * `rooks`: the Kanban closure and follow-up, messaging, delegation, the
     * worktree's info, memory rules, reads of the series plan and project roles,
     * the TO DO notebook and a workflow node's closure. It is the
     * channel left when an organisation forbids third-party MCP servers.
     *
     * Named one by one because `rooks:*` also covers the CLI's host operations —
     * `service install|uninstall`, `update approve`, `plugin add`, `auth`,
     * `secret`, `user`, `backup`, `import`… — which a mission never runs and some
     * of which kill it. What is not listed here is refused, even when the agent
     * holds a `Bash(rooks:*)` grant (see `novaGrantRules`).
     */
    const ROOKS_CLI_COMMANDS = policy.novaCliCommands;
    /** A Rooks command both bare and followed by arguments: `:*` alone requires
     *  the space after the stem, and some of these run without any argument. */
    function novaCommandRules(command) {
        return [`shell(rooks ${command})`, `shell(rooks ${command}:*)`];
    }
    /**
     * Commands a workspace agent runs without a grant: the Rooks CLI commands
     * above, git named subcommand by subcommand, and commands that only read.
     *
     * What stays out is what would turn the list back into a generic shell: shells
     * and interpreters (`bash`, `sh`, `node`, `python`…), command runners (`env`,
     * `xargs`, `find -exec`, `npx`), read commands that can start a program
     * (`rg --pre`, `sort --compress-program`, `git grep -O`), editors of arbitrary
     * files (`sed -i`, `tee`), the network (`curl`, `wget`, `git push`/`fetch`) and
     * git's own escape hatches (`git -c`, `git config`, aliases). `git stash` too:
     * its stack is shared by every worktree of the repository. The CLI
     * checks every simple command of a pipeline or a `&&` chain against these
     * rules, so `git status && bash -c …` is refused on `bash`.
     */
    const WORKSPACE_SHELL_ALLOW = [
        ...ROOKS_CLI_COMMANDS.flatMap(novaCommandRules),
        ...['status', 'diff', 'log', 'show', 'add', 'commit', 'branch', 'rev-parse',
            'merge-base', 'ls-files', 'blame', 'restore']
            .map((sub) => `shell(git ${sub})`),
        ...['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'diff', 'uniq', 'cut', 'tr',
            'date', 'echo', 'basename', 'dirname', 'realpath', 'file', 'stat']
            .map((cmd) => `shell(${cmd}:*)`),
    ];
    /**
     * Stems a claude-format grant never opens on copilot: each one runs whatever
     * it is given, so `Bash(bash:*)` or `Bash(env:*)` would hand back the generic
     * shell the allowlist exists to withhold.
     */
    const SHELL_EQUIVALENT_STEMS = new Set([
        'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd', 'cmd.exe',
        'env', 'command', 'exec', 'eval', 'xargs', 'nohup', 'nice', 'timeout', 'script',
        'sudo', 'su', 'doas', 'node', 'python', 'python3', 'perl', 'ruby', 'php', 'deno', 'bun',
    ]);
    /** Package runners: granted with a subcommand (`npx tsc`, `npm run`) they run
     *  that tool or the project's scripts; granted bare, any package at all. */
    const BARE_RUNNER_STEMS = new Set(['npx', 'npm', 'pnpm', 'yarn', 'bunx']);
    /**
     * What a bare `Bash(git:*)` grant — the `rooks-worktree` skill's, on every task
     * — opens on copilot: git's working commands, named. `git:*` itself would also
     * match `git -c alias.x='!sh -c …' x`, a generic shell under git's name.
     */
    const GIT_GRANT_SUBCOMMANDS = [
        'status', 'diff', 'log', 'show', 'add', 'commit', 'branch', 'rev-parse', 'merge-base',
        'ls-files', 'blame', 'restore', 'rm', 'mv', 'merge', 'checkout', 'switch', 'rebase',
        'cherry-pick', 'reset', 'tag', 'worktree', 'stash', 'fetch', 'pull', 'push',
    ];
    /**
     * A claude-format grant on the Rooks CLI (`words` after `rooks`), narrowed to
     * `ROOKS_CLI_COMMANDS`. A broad grant (`Bash(rooks:*)`, the `rooks-task`
     * skill's, or `Bash(rooks task:*)`) opens the listed commands it covers; a
     * narrower one inside a listed command (`Bash(rooks workflow node done *)`)
     * carries over as is; anything else (`Bash(rooks service:*)`) opens nothing.
     */
    function novaGrantRules(words, prefix) {
        const grant = words.join(' ');
        const covers = (outer, inner) => inner === outer || inner.startsWith(`${outer} `);
        if (ROOKS_CLI_COMMANDS.some((command) => covers(command, grant))) {
            return [prefix ? `shell(rooks ${grant}:*)` : `shell(rooks ${grant})`];
        }
        if (!prefix)
            return [];
        return ROOKS_CLI_COMMANDS
            .filter((command) => !grant || covers(grant, command))
            .flatMap(novaCommandRules);
    }
    /**
     * The agent's own shell grants — `allowed_tools` in claude's format, fed by the
     * agent config, its skills and the task type (`Bash(git:*)`, `Bash(npm run:*)`,
     * `Bash(rooks:*)`…) — in the CLI's syntax. Only `Bash(<command>…)` carries over,
     * and a `rooks` or bare `git` grant only as far as its named commands:
     * `Read`/`Edit`/`Write` are the mode's business, MCP tools are allowed per
     * server, and a bare `Bash` or `Bash(*)` is a generic shell, which no
     * sandboxed mode grants.
     */
    function shellGrantsFromAllowedTools(allowed) {
        const out = [];
        for (const raw of allowed ?? []) {
            const m = /^Bash\((.+)\)$/.exec(raw.trim());
            if (!m)
                continue;
            let body = m[1].trim();
            let prefix = false;
            if (body.endsWith(':*')) {
                body = body.slice(0, -2);
                prefix = true;
            }
            else if (body.endsWith(' *')) {
                body = body.slice(0, -2);
                prefix = true;
            }
            // A wildcard anywhere else, or a shell operator, is not a command name.
            if (!body.trim() || /[*?`$;&|<>(){}\\'"]/.test(body))
                continue;
            const words = body.trim().split(/\s+/);
            const stem = words[0].toLowerCase();
            if (SHELL_EQUIVALENT_STEMS.has(stem))
                continue;
            // An option before the subcommand (`git -c …`, `npm --prefix …`) is how
            // these tools are pointed at something else.
            if (words.length > 1 && words[1].startsWith('-'))
                continue;
            if (words.length === 1 && prefix && BARE_RUNNER_STEMS.has(stem))
                continue;
            if (stem === 'rooks') {
                out.push(...novaGrantRules(words.slice(1), prefix));
                continue;
            }
            if (words.length === 1 && prefix && stem === 'git') {
                for (const sub of GIT_GRANT_SUBCOMMANDS)
                    out.push(`shell(git ${sub})`);
                continue;
            }
            const command = words.join(' ');
            out.push(prefix ? `shell(${command}:*)` : `shell(${command})`);
        }
        return out;
    }
    /**
     * `agent.permission_mode` → the CLI's allow/deny flags, frozen at spawn.
     *
     * In prompt mode the CLI never asks: a tool no rule allows is refused on the
     * spot. Three profiles, in step with codex's sandbox levels:
     *
     *  - `plan`, `read-only`: read files and call the Rooks bridge; no write, no
     *    shell, no URL, no Copilot memory.
     *  - `bypassPermissions`, `danger-full-access`: NOT sandboxed — every tool and
     *    every URL, the deny rules as the only line. Opted into explicitly, like
     *    codex's `danger-full-access`.
     *  - every other mode (`auto`, `default`, `acceptEdits`, none): the workspace.
     *    Reads, writes — the CLI keeps file tools to the working directory, the
     *    temporary directory and `--add-dir`, since `--allow-all-paths` is never
     *    passed —, the mission's MCP servers, `WORKSPACE_SHELL_ALLOW` and the
     *    agent's own grants. No URL rule: web fetches and commands naming a URL
     *    are refused.
     */
    function permissionArgs(permissionMode, mcpServers, allowedTools) {
        const args = [];
        if (permissionMode === 'plan' || permissionMode === 'read-only') {
            args.push('--allow-tool=read');
            for (const server of READ_ONLY_MCP)
                args.push(`--allow-tool=${server}`);
            args.push('--deny-tool=write', '--deny-tool=shell', '--deny-tool=url', '--deny-tool=memory');
        }
        else if (permissionMode === 'bypassPermissions' || permissionMode === 'danger-full-access') {
            args.push('--allow-all-tools', '--allow-all-urls');
        }
        else {
            args.push('--allow-tool=read', '--allow-tool=write');
            for (const server of mcpServers)
                args.push(`--allow-tool=${server}`);
            const shell = new Set([...WORKSPACE_SHELL_ALLOW, ...shellGrantsFromAllowedTools(allowedTools)]);
            for (const rule of shell)
                args.push(`--allow-tool=${rule}`);
        }
        for (const rule of COPILOT_DENY_RULES)
            args.push(`--deny-tool=${rule}`);
        return args;
    }
    /**
     * A `readOnlyTools` launch: every MCP server of the mission (the daemon handed it Rooks's own
     * only, the built-in browser included) and no file tool at all — not even `read`, which reaches
     * the working directory and could copy a secret into what the mission writes (TODO #471).
     */
    function readOnlyToolArgs(mcpServers) {
        const args = [];
        for (const server of mcpServers)
            args.push(`--allow-tool=${server}`);
        args.push('--deny-tool=read', '--deny-tool=write', '--deny-tool=shell', '--deny-tool=url', '--deny-tool=memory');
        for (const rule of COPILOT_DENY_RULES)
            args.push(`--deny-tool=${rule}`);
        return args;
    }
    return { permissionArgs, readOnlyToolArgs, shellGrantsFromAllowedTools };
}

/**
 * The session's MCP servers, in the shape of `--additional-mcp-config`, from the plan the daemon
 * composed for this mission (`ctx.provider.mcp`): the CLI additionally wants `tools` on every entry
 * and names a local server `local`. The agent's own servers come first, then Rooks's, the project's
 * index and the browser — the order the CLI's allow rules were always written in.
 *
 * `ROOKS_API_TOKEN` is the mission's own token, and `nova_ask` has no fallback without it. The plan
 * carries it as a reference; it is written as `${ROOKS_API_TOKEN}`, which the CLI expands from its
 * own environment when it starts the server (documented for the `env` field): the file on disk names
 * the variable, never the value.
 *
 * @param {import('@rooks/sdk/provider').ProviderMcpPlan} plan
 */
function mcpConfigFrom(plan) {
    const tokenRef = plan.identityEnv.ROOKS_API_TOKEN;
    const envOf = (env) => Object.fromEntries(Object.entries(env).map(([key, value]) => [key, tokenRef !== undefined && value === tokenRef ? '${ROOKS_API_TOKEN}' : value]));
    const servers = {};
    const ordered = [...plan.servers.filter((s) => s.role === 'user'), ...plan.servers.filter((s) => s.role !== 'user')];
    for (const server of ordered) {
        if (server.type === 'http') {
            servers[server.name] = { type: 'http', url: server.url, ...(Object.keys(server.headers).length ? { headers: { ...server.headers } } : {}), tools: ['*'] };
            continue;
        }
        servers[server.name] = {
            type: 'local',
            command: server.command,
            args: [...server.args],
            // The project's semantic index never carried an environment.
            ...(server.role === 'grepai' ? {} : { env: envOf(server.env) }),
            tools: ['*'],
        };
    }
    return { mcpServers: servers };
}
/** MIME → extension, so that the CLI does not have to guess the format. */
const IMAGE_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};
/**
 * @param {import('@rooks/sdk/provider').ProviderScratchDir} scratch
 * @param {Array<{ media_type: string, data: string }> | undefined} images
 * @returns {string[]}
 */
function writeTurnImages(scratch, images) {
    if (!images || images.length === 0)
        return [];
    return images.map((img) => {
        const ext = IMAGE_EXT[img.media_type?.toLowerCase()] ?? 'png';
        return scratch.writeFile(`images/${randomUUID()}.${ext}`, Buffer.from(img.data, 'base64'));
    });
}
/**
 * The system prompt as a custom-instructions file. `applyTo: "**"` makes it
 * apply to every request, whatever file the agent is looking at: without it, an
 * `.instructions.md` file is a path-scoped instruction.
 */
function instructionsFile(systemPrompt) {
    return `---\napplyTo: "**"\n---\n${systemPrompt}\n`;
}
function asRecord(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
}
function str(v) {
    return typeof v === 'string' ? v : null;
}
function assistantEvent(id, content) {
    return {
        type: 'assistant',
        payload: { type: 'assistant', message: { id, role: 'assistant', content } },
    };
}
/** Text of a tool result: the concise form the model saw, else the detailed
 *  one, else the error. */
function toolResultText(data) {
    const result = asRecord(data.result);
    const error = asRecord(data.error);
    return str(result?.content) ?? str(result?.detailedContent) ?? str(error?.message) ?? '';
}
/**
 * What the CLI prints, under `--no-ask-user`, for a tool use no allow rule
 * covers: "Permission denied because no interactive user response was
 * available. Retry in an interactive session so the user can approve it…".
 * Under Rooks there is no such session to retry in (TIM-0063).
 */
const NO_INTERACTIVE_APPROVAL = /no interactive user response was available/i;
/**
 * The refusal as the chat shows it. The tool call printed just above names the
 * command, so this says only why and how to open it. The CLI's own sentence
 * stays at the end, for whoever searches for it.
 */
export const ALLOWLIST_REFUSAL_TEXT = "Refused: this is outside what the agent may do on Copilot. Copilot has no Allow/Deny card in Rooks, "
    + "so a command or path outside the agent's allowlist is refused on the spot and retrying it asks nobody. "
    + "To allow a command, add it to the agent's allowed tools (for example `Bash(npm test:*)`), "
    + "or switch the agent to bypassPermissions.";
function readableToolResult(text) {
    return NO_INTERACTIVE_APPROVAL.test(text) ? `${ALLOWLIST_REFUSAL_TEXT}\n\nCopilot CLI: ${text}` : text;
}
/**
 * The CLI's JSON lines as Rooks's normalised vocabulary. Built from the daemon's event factories
 * (`ctx.provider.runtime.events`), so the delta event is the daemon's own.
 *
 * @param {import('@rooks/sdk/provider').ProviderRuntime['events']} events
 */
export function createEventMapper(events) {
    function mapCopilotEvent(raw) {
        const ev = asRecord(raw);
        const type = str(ev?.type);
        if (!ev || !type)
            return [];
        // A sub-agent's own messages and tool calls: the parent's `task` tool already
        // reports what it did. Replaying its inner stream would interleave a second
        // conversation into the mission's transcript.
        if (str(ev.agentId))
            return [];
        const data = asRecord(ev.data) ?? {};
        switch (type) {
            case 'assistant.message_delta': {
                const text = str(data.deltaContent);
                return text ? [events.assistantDeltaEvent(text)] : [];
            }
            case 'assistant.reasoning': {
                const text = str(data.content);
                return text ? [assistantEvent(str(data.reasoningId) ?? randomUUID(), [{ type: 'thinking', thinking: text }])] : [];
            }
            case 'assistant.message': {
                const content = [];
                const text = str(data.content);
                if (text)
                    content.push({ type: 'text', text });
                const requests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
                for (const r of requests) {
                    const req = asRecord(r);
                    const id = str(req?.toolCallId);
                    const name = str(req?.name);
                    if (req && id && name)
                        content.push({ type: 'tool_use', id, name, input: asRecord(req.arguments) ?? {} });
                }
                return content.length ? [assistantEvent(str(data.messageId) ?? randomUUID(), content)] : [];
            }
            case 'tool.execution_complete': {
                const id = str(data.toolCallId);
                if (!id)
                    return [];
                return [{
                        type: 'user',
                        payload: {
                            type: 'user',
                            message: {
                                role: 'user',
                                content: [{
                                        type: 'tool_result',
                                        tool_use_id: id,
                                        content: readableToolResult(toolResultText(data)),
                                        is_error: data.success !== true,
                                    }],
                            },
                        },
                    }];
            }
            case 'session.error': {
                // The CLI's own classification, kept alongside: `statusCode` is the one
                // `rate-limit.ts` concludes on, the message its textual net.
                const status = typeof data.statusCode === 'number' && Number.isInteger(data.statusCode) ? data.statusCode : undefined;
                return [{
                        type: 'result',
                        payload: {
                            type: 'result',
                            subtype: 'error',
                            is_error: true,
                            error: str(data.message) ?? 'copilot session error',
                            ...(str(data.errorType) ? { error_type: data.errorType } : {}),
                            ...(status !== undefined ? { api_error_status: status } : {}),
                            total_cost_usd: 0,
                        },
                    }];
            }
            case 'result': {
                // Top level, not under `data`: `{ sessionId, exitCode, usage }`.
                const sessionId = str(ev.sessionId) ?? str(data.sessionId);
                const exitCode = typeof ev.exitCode === 'number' ? ev.exitCode : null;
                const usage = asRecord(ev.usage) ?? {};
                const events = [];
                if (sessionId) {
                    events.push({
                        type: 'system',
                        payload: { type: 'system', subtype: 'init', session_id: sessionId, mcp_servers: [], tools: [] },
                    });
                }
                // A failed run already produced its `result` from `session.error`; a
                // second one would count the turn twice (turn_complete, breaker).
                if (exitCode === null || exitCode === 0) {
                    events.push({
                        type: 'result',
                        payload: {
                            type: 'result',
                            subtype: 'success',
                            is_error: false,
                            total_cost_usd: 0,
                            ...(typeof usage.sessionDurationMs === 'number' ? { duration_ms: usage.sessionDurationMs } : {}),
                            ...(typeof usage.totalApiDurationMs === 'number' ? { duration_api_ms: usage.totalApiDurationMs } : {}),
                            ...(typeof usage.premiumRequests === 'number' ? { premium_requests: usage.premiumRequests } : {}),
                        },
                    });
                }
                return events;
            }
            default:
                // Deltas of reasoning, intents, MCP status, usage snapshots, turn
                // boundaries: plumbing the persisted messages already sum up.
                return [];
        }
    }
    return mapCopilotEvent;
}

/**
 * The GitHub Copilot provider, written against `ctx.provider` only.
 *
 * @param {import('@rooks/sdk/provider').ProviderServices} services `ctx.provider`
 * @returns {import('@rooks/sdk/provider').NativeProviderDefinition}
 */
export function createCopilotProvider(services) {
    const { runtime } = services;
    const mapCopilotEvent = createEventMapper(runtime.events);
    const { discover } = createCopilotModels(services);
    const { getCopilotUsage } = createCopilotUsage(services);

    return {
        id: 'copilot',
        // One process per turn, the system prompt in a custom-instructions folder, the message on stdin.
        transport: { kind: 'process-per-turn' },
        codec: {
            kind: 'lines',
            parseLine(line) {
                let parsed;
                try {
                    parsed = JSON.parse(line);
                }
                catch {
                    return [];
                }
                return mapCopilotEvent(parsed);
            },
            extractSessionId: runtime.events.extractInitSessionId,
            writeUserInput() {
                // One shot: the following turns re-spawn through `launch`.
            },
        },
        /* No `maxPromptBytes`: the message goes through stdin. */
        async launch(opts, profile) {
            // The scratch folder is the mission's: the system prompt, the MCP configuration and the turn's images.
            // The SESSION is not here — it lives in the host's `~/.copilot`, next to the login. Moving
            // `COPILOT_HOME` per mission would move the login with it, and the CLI rewrites that state as it
            // refreshes the token, so a link to it would not survive.
            const scratch = await services.scratch.mission(opts);
            // Rewritten on every turn: an edited system prompt applies to the next one.
            scratch.writeFile('instructions/rooks.instructions.md', instructionsFile(opts.systemPrompt));
            // `permissionPrompt` stays off: the CLI has no permission-prompt tool, the forms server only serves its forms.
            const plan = await services.mcp(opts);
            const mcpConfig = mcpConfigFrom(plan);
            const mcpFile = scratch.writeFile('mcp-config.json', JSON.stringify(mcpConfig));
            const formsServer = plan.servers.find((server) => server.role === 'forms')?.name ?? 'nova_ask';
            const rules = copilotRules(plan.commandPolicy, formsServer);

            const args = [
                '--output-format', 'json',
                '--no-ask-user',
                // A mission must never be interrupted by an update decided in the
                // background.
                '--no-auto-update',
                '--no-color',
                '--additional-mcp-config', `@${mcpFile}`,
                // The agent's tools are the ones Rooks declares, like on every other
                // backend; the GitHub server would otherwise come on top.
                '--disable-builtin-mcps',
                ...(opts.readOnlyTools
                    ? rules.readOnlyToolArgs(Object.keys(mcpConfig.mcpServers))
                    : rules.permissionArgs(opts.cfg.permission_mode, Object.keys(mcpConfig.mcpServers), opts.cfg.allowed_tools)),
            ];
            if (opts.cfg.model)
                args.push('--model', opts.cfg.model);
            if (opts.cfg.reasoningEffort)
                args.push('--reasoning-effort', opts.cfg.reasoningEffort);
            if (opts.memoryDir)
                args.push('--add-dir', opts.memoryDir);
            for (const image of writeTurnImages(scratch, opts.images))
                args.push('--attachment', image);
            // Always with its value: a bare `--resume` opens an interactive picker.
            // Not `--session-id`, which would silently start a NEW session under the
            // same id when the old one is gone; `--resume` fails instead, and
            // `session.notFound` replays the turn fresh.
            if (opts.resumeSession)
                args.push('--resume', opts.resumeSession);
            return {
                cmd: profile.cmd,
                args,
                cwd: opts.cfg.cwd,
                env: { COPILOT_CUSTOM_INSTRUCTIONS_DIRS: scratch.path, ...profile.env },
                initialStdin: opts.message,
            };
        },
        session: {
            // `~/.copilot/session-state/<id>` belongs to the CLI and outlives every
            // process: `--resume=<id>` finds it from any mission.
            store: 'global',
            resumable: true,
            notFound(stderr) {
                return /No session, task, or name matched/i.test(stderr);
            },
        },
        // Rights are frozen at spawn by allowlists (`--allow-tool` / `--deny-tool`);
        // prompt mode has no approval round trip (see permissionArgs). `mcp-bridge` would promise
        // an Allow/Deny card this CLI cannot route.
        permission: { model: 'sandbox' },
        // `session.error` carries a category and an HTTP status, never a reopening
        // time — the same promise as grok's.
        limits: { reporting: 'textual' },
        mcp: { rooks: true },
        // Which models a Copilot seat reaches is decided by the organisation's policy: asked of the CLI itself.
        models: { discover },
        /**
         * Premium requests of the signed-in seat, asked of the CLI's headless server
         * (`usage.js`). The profile's env names where the login lives (`COPILOT_HOME`,
         * `GH_HOST`), so the probe is spawned with it.
         */
        usage: {
            // `options.force`: a person's ↻ (`UsageProbeOptions`), which skips the cache and a cached failure.
            async probe(profile, options) {
                // Under an account's name, the host's login would be another seat's.
                if (profile && services.account.of(profile))
                    return null;
                return getCopilotUsage(profile?.env ?? {}, { force: options?.force === true });
            },
        },
        declares: {
            binary: COPILOT.binary,
            credentialDirs: COPILOT.credentialDirs,
            spans: 'stream-json',
            hostedConnectors: false,
            // The CLI's refusal tells the model to "retry in an interactive session",
            // which does not exist under Rooks: retrying the same command fails again,
            // and a task gets marked failed over a read it could have done otherwise.
            permissionsHint: "- **Copilot refusals**: \"Permission denied because no interactive user response was available\" "
                + "means the command is not on your allowlist; nobody can approve it and retrying it fails again. "
                + "Use your file tools or an allowed command (`git`, `rooks`, `ls`, `cat`, `grep`, `head`…) instead; "
                + "if nothing allowed can do it, close the task naming the refused command.",
        },
    };
}
