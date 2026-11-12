/**
 * Codex event → Claude-vocabulary normalization.
 * Schema lifted from codex-rs/exec/src/exec_events.rs (codex 0.130).
 */
function mapCodexEvent(raw) {
    if (!raw || typeof raw !== 'object')
        return [];
    const ev = raw;
    switch (ev.type) {
        case 'thread.started': {
            const e = raw;
            // Synthesize a Claude-shaped system:init event. We leave mcp_servers
            // and tools empty — Codex MCP tools come through item.completed
            // (mcp_tool_call) instead of an upfront catalog, so the existing
            // refreshToolsCacheFromInit pipeline doesn't have data to chew on.
            return [{
                    type: 'system',
                    payload: {
                        type: 'system',
                        subtype: 'init',
                        session_id: e.thread_id,
                        backend: 'codex',
                        mcp_servers: [],
                        tools: [],
                    },
                }];
        }
        case 'turn.started':
            return [];
        case 'turn.completed': {
            const e = raw;
            return [{
                    type: 'result',
                    payload: {
                        type: 'result',
                        subtype: 'success',
                        is_error: false,
                        total_cost_usd: 0,
                        usage: {
                            input_tokens: e.usage?.input_tokens ?? 0,
                            output_tokens: e.usage?.output_tokens ?? 0,
                            cache_read_input_tokens: e.usage?.cached_input_tokens ?? 0,
                        },
                    },
                }];
        }
        case 'turn.failed': {
            const e = raw;
            return [{
                    type: 'result',
                    payload: {
                        type: 'result',
                        subtype: 'error',
                        is_error: true,
                        error: e.error?.message ?? 'turn failed',
                        total_cost_usd: 0,
                    },
                }];
        }
        case 'error': {
            const e = raw;
            // Codex retries a dropped stream itself (5 times by default) and
            // reports each attempt as an `error` line. `codex exec --json`
            // drops the `willRetry` flag the app-server carries, so the text
            // is all there is. That attempt is not the end of the turn: a
            // `result` here told the agent that asked "turn failed" while
            // codex was still reconnecting.
            const retry = codexRetry(e.message);
            if (retry)
                return [retry];
            return [{
                    type: 'result',
                    payload: {
                        type: 'result',
                        subtype: 'error',
                        is_error: true,
                        error: e.message,
                        total_cost_usd: 0,
                    },
                }];
        }
        case 'item.completed': {
            const e = raw;
            // A completed item without its item is a malformed line, not a crash.
            if (!e.item || typeof e.item !== 'object')
                return [];
            return mapCodexItem(e.item);
        }
        case 'item.started':
        case 'item.updated':
            // Drop the in-progress chatter — the UI re-renders on item.completed.
            //
            // No partial streaming on the codex side: verified empirically on
            // codex-cli 0.147.0, a `codex exec --json 'say hello'` emits NO
            // `item.started` / `item.updated` — the stream goes from `turn.started`
            // straight to `item.completed`. So there is nothing to map to
            // `assistant_delta` as long as the CLI exposes no partials in exec mode.
            // The day it does: first check whether `item.text` is cumulative
            // (→ 'replace' mode) or incremental (→ 'append').
            return [];
        default:
            return [];
    }
}
/** `Reconnecting... 2/5 (cause)` or `Reconnecting... waiting for network`. */
const RECONNECTING = /^Reconnecting\.\.\.\s*(?:(\d+)\/(\d+))?\s*([\s\S]*)$/;
function codexRetry(message) {
    const m = RECONNECTING.exec(String(message ?? '').trim());
    if (!m)
        return null;
    let cause = m[3].trim();
    if (cause.startsWith('(') && cause.endsWith(')'))
        cause = cause.slice(1, -1).trim();
    return {
        type: 'provider_retry',
        payload: {
            type: 'provider_retry',
            attempt: m[1] ? Number(m[1]) : null,
            max: m[2] ? Number(m[2]) : null,
            cause: cause || 'reconnecting',
            delay_ms: null,
            kind: retryKind(cause),
        },
    };
}
/** Same reading as the daemon's `providerRetryKind`, on words alone: codex gives no status. */
function retryKind(cause) {
    if (/overloaded/i.test(cause))
        return 'overloaded';
    if (/rate[ _-]?limit|too many requests|\b429\b/i.test(cause))
        return 'rate_limit';
    if (/\b5\d\d\b|server[ _-]?error|internal error|bad gateway|service unavailable/i.test(cause))
        return 'server';
    return 'transport';
}
function mapCodexItem(item) {
    switch (item.type) {
        case 'agent_message':
            return [{
                    type: 'assistant',
                    payload: {
                        type: 'assistant',
                        message: {
                            id: item.id,
                            role: 'assistant',
                            content: [{ type: 'text', text: String(item.text ?? '') }],
                        },
                    },
                }];
        case 'reasoning':
            return [{
                    type: 'assistant',
                    payload: {
                        type: 'assistant',
                        message: {
                            id: item.id,
                            role: 'assistant',
                            content: [{
                                    type: 'thinking',
                                    thinking: String(item.text ?? ''),
                                }],
                        },
                    },
                }];
        case 'command_execution': {
            const cmd = String(item.command ?? '');
            const out = String(item.aggregated_output ?? '');
            const exit = item.exit_code ?? null;
            const failed = item.status === 'failed' || (exit !== null && exit !== 0);
            return [
                {
                    type: 'assistant',
                    payload: {
                        type: 'assistant',
                        message: {
                            id: item.id,
                            role: 'assistant',
                            content: [{
                                    type: 'tool_use',
                                    id: item.id,
                                    name: 'bash',
                                    input: { command: cmd },
                                }],
                        },
                    },
                },
                {
                    type: 'user',
                    payload: {
                        type: 'user',
                        message: {
                            role: 'user',
                            content: [{
                                    type: 'tool_result',
                                    tool_use_id: item.id,
                                    content: out,
                                    is_error: failed,
                                }],
                        },
                    },
                },
            ];
        }
        case 'mcp_tool_call': {
            const server = String(item.server ?? '');
            const tool = String(item.tool ?? '');
            const toolName = `mcp__${server.replace(/[^A-Za-z0-9]+/g, '_')}__${tool}`;
            const result = item.result;
            const err = item.error;
            const events = [{
                    type: 'assistant',
                    payload: {
                        type: 'assistant',
                        message: {
                            id: item.id,
                            role: 'assistant',
                            content: [{
                                    type: 'tool_use',
                                    id: item.id,
                                    name: toolName,
                                    input: item.arguments ?? {},
                                }],
                        },
                    },
                }];
            events.push({
                type: 'user',
                payload: {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: [{
                                type: 'tool_result',
                                tool_use_id: item.id,
                                content: err?.message ?? JSON.stringify(result?.content ?? ''),
                                is_error: !!err,
                            }],
                    },
                },
            });
            return events;
        }
        case 'file_change': {
            const changes = item.changes;
            const summary = (changes ?? [])
                .map((c) => `${c.kind}: ${c.path}`).join('\n');
            const failed = item.status === 'failed';
            // `item.completed` = patch already applied (or already failed) by the
            // time of the event: unlike `command_execution`, this case used to emit
            // only the `tool_use` with no paired `tool_result`. On the UI side, a
            // ToolUse with no `result` is classified as "in flight" indefinitely
            // (RunningToolBar) — so every apply_patch stayed on screen with a timer
            // climbing forever while the file had already been written (observed
            // 2026-08-17).
            return [
                {
                    type: 'assistant',
                    payload: {
                        type: 'assistant',
                        message: {
                            id: item.id,
                            role: 'assistant',
                            content: [{
                                    type: 'tool_use',
                                    id: item.id,
                                    name: 'apply_patch',
                                    input: { changes: changes ?? [], summary },
                                }],
                        },
                    },
                },
                {
                    type: 'user',
                    payload: {
                        type: 'user',
                        message: {
                            role: 'user',
                            content: [{
                                    type: 'tool_result',
                                    tool_use_id: item.id,
                                    content: summary,
                                    is_error: failed,
                                }],
                        },
                    },
                },
            ];
        }
        case 'web_search':
            // Synthetic `tool_result` — same reason as `file_change` above: without
            // it, the tool stays "in flight" forever on the UI side.
            return [
                {
                    type: 'assistant',
                    payload: {
                        type: 'assistant',
                        message: {
                            id: item.id,
                            role: 'assistant',
                            content: [{
                                    type: 'tool_use',
                                    id: item.id,
                                    name: 'web_search',
                                    input: { query: String(item.query ?? '') },
                                }],
                        },
                    },
                },
                {
                    type: 'user',
                    payload: {
                        type: 'user',
                        message: {
                            role: 'user',
                            content: [{
                                    type: 'tool_result',
                                    tool_use_id: item.id,
                                    content: '',
                                    is_error: false,
                                }],
                        },
                    },
                },
            ];
        case 'todo_list':
            // Same again — with no `tool_result`, the tool stayed "in flight"
            // forever.
            return [
                {
                    type: 'assistant',
                    payload: {
                        type: 'assistant',
                        message: {
                            id: item.id,
                            role: 'assistant',
                            content: [{
                                    type: 'tool_use',
                                    id: item.id,
                                    name: 'todo_list',
                                    input: item,
                                }],
                        },
                    },
                },
                {
                    type: 'user',
                    payload: {
                        type: 'user',
                        message: {
                            role: 'user',
                            content: [{
                                    type: 'tool_result',
                                    tool_use_id: item.id,
                                    content: '',
                                    is_error: false,
                                }],
                        },
                    },
                },
            ];
        case 'error':
            // Third-party providers are not in the CLI's embedded catalog. The CLI
            // carries on with its fallback values and then answers normally:
            // surfacing that internal warning as an assistant bubble is misleading.
            if (/^Model metadata for `[^`]+` not found\. Defaulting to fallback metadata;/.test(String(item.message ?? ''))) {
                return [];
            }
            return [{
                    type: 'assistant',
                    payload: {
                        type: 'assistant',
                        message: {
                            id: item.id,
                            role: 'assistant',
                            content: [{
                                    type: 'text',
                                    text: `[error] ${String(item.message ?? '')}`,
                                }],
                        },
                    },
                }];
        default:
            return [];
    }
}
// Re-export for tests / debugging.
export { mapCodexEvent };
