/**
 * Approval mode of MCP tool calls, to declare on EVERY MCP server
 * written into the per-mission `config.toml` of a codex agent.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * codex-cli 0.147 subjects MCP tool calls to an approval, just like
 * a shell command. Yet `codex exec` (the only mode ROOKS uses)
 * is non-interactive: it has NO channel to ask the question, so the
 * request is cancelled the very same second. The agent receives
 * `user cancelled MCP tool call` in 0.0 s, without any human having cancelled
 * anything — the message is misleading to the point of sending the diagnosis towards the ROOKS
 * UI while nothing of ROOKS is at fault.
 *
 * Reproduced outside ROOKS on codex-cli 0.147, with a trivial MCP server (a
 * single `ping` tool returning a constant) and a throwaway CODEX_HOME:
 *
 *   [mcp_servers.probe]                    → result: Err("user cancelled MCP tool call")
 *   command = "node", args = ["echo-mcp.mjs"]
 *
 *   [mcp_servers.probe]                    → result: Ok(content: "PONG-42")
 *   command = "node", args = ["echo-mcp.mjs"]
 *   default_tools_approval_mode = "approve"
 *
 * Consequence on the ROOKS side: no codex agent could call
 * `ask_user`, `kanban_add`, `mission_spawn`, grepai, or any opt-in MCP any more —
 * that is exactly the tools the ROOKS preamble ORDERS it
 * to use. A codex orchestrator was unable to ask the user for a decision
 * or to create a task.
 *
 * ── Why `approve` and not `prompt`/`writes` ─────────────────────────────────
 * The accepted values are `auto` | `prompt` | `writes` | `approve`. The
 * first three all lead to an approval request in at least one
 * case, and under `codex exec` an approval request IS NOT a question:
 * it is an immediate refusal. The real security decision for a codex agent is
 * made elsewhere and upstream — `--sandbox` freezes its rights at spawn
 * (see `sandboxModeForCodex`) and the MCP servers written here are either those of
 * ROOKS itself, or those the human explicitly enabled on the agent.
 *
 * Key unknown to earlier codex versions: it is silently ignored (ROOKS does not
 * pass `--strict-config`), so setting the line does not break an older
 * CLI.
 */
export const CODEX_MCP_APPROVAL_TOML = 'default_tools_approval_mode = "approve"';
