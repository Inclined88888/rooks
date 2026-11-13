/**
 * Names of the forms MCP server — `bin/permission-mcp.mjs` — and of its tools.
 *
 * The server carries every tool that opens a form in the UI and blocks until
 * the human answers. It was called `rooks_permission`, with the tools
 * `ask_user` and `ask_series_plan`: an agent asked to "open a Kanban
 * permission request" was drawn to `ask_user` by the word "permission", and
 * "series" is not a word a user says. Hence `rooks_ask`, `question` and
 * `kanban_plan`.
 *
 * TWO THINGS DID NOT MOVE, on purpose:
 *  - the script's path and `PERMISSION_MCP_PATH`: a config written before the
 *    rename still points at a file that exists;
 *  - the identifier of a form CARD, `FORM_CARD_TOOL`. It is persisted in the
 *    events of every past mission and read back by the UI; the shim keeps
 *    posting it whatever name the model called. It is NOT derived from the
 *    tool's public name, and the public name `question` is never mapped onto
 *    it at the daemon's entry: a backend's own tool can be called `question`
 *    (opencode has one), and its permission request must stay an Allow/Deny
 *    card rather than be read as a malformed form.
 *
 * The shim is a standalone script and cannot import this module: the names are
 * written there a second time, and `ask-mcp.test.ts` holds the two together.
 */

/** The MCP server's name, as every dialect registers it. */
export const ASK_MCP_SERVER = 'rooks_ask';

/** Its name before the rename. Still recognised wherever a server name is
 *  matched, never registered: the same tools twice would be a duplicate the
 *  model sees. */
export const LEGACY_ASK_MCP_SERVER = 'rooks_permission';

/** A one-off decision: questions with buttons. */
export const ASK_TOOL_QUESTION = 'question';
/** The Kanban planner: how a chantier runs, and with which models. */
export const ASK_TOOL_KANBAN_PLAN = 'kanban_plan';
/** The Allow/Deny round trip. Called by the harness, never by the model. */
export const ASK_TOOL_REQUEST = 'request';

/** Former tool name → current one. The shim answers both, lists the current. */
export const LEGACY_ASK_TOOLS: Readonly<Record<string, string>> = {
  ask_user: ASK_TOOL_QUESTION,
  ask_series_plan: ASK_TOOL_KANBAN_PLAN,
};

/** What a form card is called in the daemon, the database and the UI. */
export const FORM_CARD_TOOL = 'ask_user';

/** Every identifier a form card is posted under: the question card and the
 *  planner's, which keeps its pre-rename name just as `FORM_CARD_TOOL` does.
 *  Not the public names `question` / `kanban_plan` (see above). */
const FORM_CARD_TOOLS: ReadonlySet<string> = new Set([FORM_CARD_TOOL, 'ask_series_plan']);

/** Whether a permission request is a form card: something only a human answers,
 *  never an Allow/Deny a policy can settle on their behalf. */
export function isFormCardTool(toolName: string): boolean {
  return FORM_CARD_TOOLS.has(toolName);
}

/**
 * Set to `1` in the server's environment by every dialect whose harness does
 * NOT call `request` itself: the tool then stays out of `tools/list`. A model
 * that reads "ask the UI for permission" next to the forms picks it to "open a
 * permission request", and no harness is there to give it a meaning.
 *
 * The default is the other way — `request` listed — because the script is read
 * from the install directory at every spawn: a daemon not restarted yet runs
 * the new script with the old environment, and claude's
 * `--permission-prompt-tool` must still find its tool.
 */
export const ASK_MCP_FORMS_ONLY_ENV = 'ROOKS_ASK_FORMS_ONLY';

/** Archive-era server names (upstream body). Still matched, never registered. */
export const ARCHIVE_ASK_MCP_SERVERS = Object.freeze(['rooks_ask', 'rooks_permission'] as const);

/** Whether `name` is the forms server, under its current, legacy, or archive name. */
export function isAskMcpServer(name: string): boolean {
  return name === ASK_MCP_SERVER || name === LEGACY_ASK_MCP_SERVER
    || (ARCHIVE_ASK_MCP_SERVERS as readonly string[]).includes(name);
}

/** `mcp__<server>__<tool>`, the form claude gives an MCP tool's name. */
function claudeToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** The permission-prompt tool, as `--permission-prompt-tool` wants it. */
export const CLAUDE_PERMISSION_PROMPT_TOOL = claudeToolName(ASK_MCP_SERVER, ASK_TOOL_REQUEST);

/**
 * The form tools in claude's naming, current names first then the former ones.
 *
 * Both are pre-allowed: an agent configuration or a resumed session written
 * before the rename may still name the former ones, and a form is already a
 * question to the human — gating it would put an Allow/Deny card in front of
 * the form itself.
 */
export function claudeAskToolNames(): string[] {
  return [
    claudeToolName(ASK_MCP_SERVER, ASK_TOOL_QUESTION),
    claudeToolName(ASK_MCP_SERVER, ASK_TOOL_KANBAN_PLAN),
    ...Object.keys(LEGACY_ASK_TOOLS).map((tool) => claudeToolName(LEGACY_ASK_MCP_SERVER, tool)),
  ];
}
