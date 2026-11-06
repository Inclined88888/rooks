// @ts-check
/**
 * The permission policy of a Pi mission, as the bridge extension enforces it (`timon-bridge.js`,
 * `permissionVerdict`): what Timon's `permission_mode` and the agent's grants mean in Pi's terms.
 * Computed here, daemon side, and sent with the bridge's configuration, so the bridge holds data,
 * never a decision of the product of its own.
 *
 * The scale is the one every backend follows:
 *  - `plan` / `read-only` → `read-only`: reads pass, Timon's pre-approved tools and `timon` CLI
 *    commands pass, everything else is refused without a card (no edit, no other command);
 *  - `default`, or no mode → `ask`: reads pass, everything else goes to the Allow/Deny card unless the
 *    agent was granted it (`allowed_tools`);
 *  - `acceptEdits` / `auto` → `edits`: as `ask`, and edits inside the working directory pass;
 *  - `bypassPermissions` / `danger-full-access` → `bypass`: nothing is asked.
 * In every mode, the product's deny rules (`commandPolicy`) and the agent's `disallowed_tools` refuse.
 * A tool's MCP `readOnlyHint` makes it a read only when Timon itself serves it (`hintServers`): a
 * server the user added, or another extension's tool, would otherwise skip the card by saying so.
 *
 * Grants and refusals are written in Claude Code's syntax (`Edit`, `Bash(git:*)`, `mcp__srv__tool`),
 * which the dispatcher uses for every backend. What has no faithful translation is left out: a grant
 * then costs a card, never an allowance nobody wrote.
 *
 * @typedef {import('./timon-bridge.js').BridgePolicy} BridgePolicy
 * @typedef {import('./timon-bridge.js').PermissionMode} PermissionMode
 * @typedef {import('@timon-ai/sdk/provider').ProviderAgentConfig} ProviderAgentConfig
 * The part of `ctx.provider.mcp()`'s plan the policy reads.
 * @typedef {{
 *   servers: ReadonlyArray<{ readonly name: string, readonly role: string }>,
 *   preApprovedTools: readonly string[],
 *   commandPolicy: {
 *     denyPrograms: readonly string[],
 *     denyCommands: readonly string[],
 *     denyTimonCommands: readonly string[],
 *     timonCliCommands: readonly string[],
 *   },
 * }} PolicyPlan
 */

/** @param {string | undefined} mode @returns {PermissionMode} */
export function piPermissionMode(mode) {
  switch (mode) {
    case 'plan':
    case 'read-only':
      return 'read-only';
    case 'acceptEdits':
    case 'auto':
      return 'edits';
    case 'bypassPermissions':
    case 'danger-full-access':
      return 'bypass';
    default:
      // `default`, nothing, or a mode this version does not know: the card decides.
      return 'ask';
  }
}

/** Claude Code's tool names → Pi's. Reads are absent: Pi's read tools pass in every mode. */
const EDIT_NAMES = Object.freeze(/** @type {Record<string, string[]>} */ ({
  Edit: ['edit'],
  MultiEdit: ['edit'],
  Write: ['write'],
}));
const READ_NAMES = Object.freeze(/** @type {Record<string, string[]>} */ ({
  Read: ['read'],
  Grep: ['grep'],
  Glob: ['find'],
  LS: ['ls'],
}));
const SHELL_NAMES = new Set(['Bash', 'PowerShell']);
const PI_SHELL = Object.freeze(['bash', 'powershell']);

/**
 * One rule in Claude Code's syntax: the tool it names and its specifier, if any.
 * @param {string} rule
 * @returns {{ tool: string, spec: string | null } | null}
 */
function parseRule(rule) {
  const match = /^([A-Za-z][A-Za-z0-9_-]*)(?:\((.*)\))?$/.exec(rule.trim());
  return match ? { tool: /** @type {string} */ (match[1]), spec: match[2]?.trim() ?? null } : null;
}

/** `mcp__srv__tool` as is, `mcp__srv` (a whole server) as `mcp__srv__*`. @param {string} name */
function mcpRule(name) {
  if (name.endsWith('__*')) return name;
  return name.slice('mcp__'.length).includes('__') ? name : `${name}__*`;
}

/**
 * A `Bash(…)` specifier as a command rule: `git:*` and `git *` are `git` followed by anything,
 * anything else without a wildcard is that command exactly. Null when it holds a wildcard
 * elsewhere, which words cannot express.
 * @param {string} spec
 */
function commandRule(spec) {
  const words = spec.endsWith(':*') ? spec.slice(0, -2) : spec.endsWith(' *') ? spec.slice(0, -2) : null;
  if (words !== null) return words.trim() && !words.includes('*') ? `${words.trim()}:*` : null;
  return spec && !spec.includes('*') ? spec : null;
}

/**
 * The agent's grants (`allowed_tools`), in Pi's terms.
 * @param {readonly string[] | undefined} rules
 * @returns {{ tools: string[], commands: string[] }}
 */
export function piGrants(rules) {
  /** @type {Set<string>} */
  const tools = new Set();
  /** @type {Set<string>} */
  const commands = new Set();
  for (const raw of rules ?? []) {
    if (typeof raw !== 'string') continue;
    const rule = raw.trim();
    if (rule.startsWith('mcp__')) { tools.add(mcpRule(rule)); continue; }
    const parsed = parseRule(rule);
    if (!parsed) continue;
    if (SHELL_NAMES.has(parsed.tool)) {
      if (parsed.spec === null || parsed.spec === '*' || parsed.spec === ':*') for (const t of PI_SHELL) tools.add(t);
      else {
        const command = commandRule(parsed.spec);
        if (command) commands.add(command);
      }
    } else if (parsed.spec === null && EDIT_NAMES[parsed.tool]) {
      // `Edit(src/**)` names paths Pi's rules cannot express: left to the card.
      for (const t of EDIT_NAMES[parsed.tool] ?? []) tools.add(t);
    }
  }
  return { tools: [...tools], commands: [...commands] };
}

/**
 * The agent's refusals (`disallowed_tools`), in Pi's terms. A refused command becomes a deny rule
 * of text, which the bridge checks in every command a line runs.
 * @param {readonly string[] | undefined} rules
 * @returns {{ tools: string[], commands: string[] }}
 */
export function piRefusals(rules) {
  /** @type {Set<string>} */
  const tools = new Set();
  /** @type {Set<string>} */
  const commands = new Set();
  for (const raw of rules ?? []) {
    if (typeof raw !== 'string') continue;
    const rule = raw.trim();
    if (rule.startsWith('mcp__')) { tools.add(mcpRule(rule)); continue; }
    const parsed = parseRule(rule);
    if (!parsed) continue;
    if (SHELL_NAMES.has(parsed.tool)) {
      if (parsed.spec === null || parsed.spec === '*' || parsed.spec === ':*') for (const t of PI_SHELL) tools.add(t);
      else {
        const prefix = parsed.spec.endsWith(':*') ? parsed.spec.slice(0, -2) : parsed.spec.endsWith(' *') ? parsed.spec.slice(0, -2) : null;
        // A prefix refuses that command and what follows it; a wildcard elsewhere is cut there, wider.
        const text = (prefix ?? parsed.spec).split('*')[0]?.trim() ?? '';
        if (text) commands.add(prefix !== null || parsed.spec.includes('*') ? text : parsed.spec);
      }
    } else if (parsed.spec === null) {
      for (const t of EDIT_NAMES[parsed.tool] ?? READ_NAMES[parsed.tool] ?? []) tools.add(t);
    }
  }
  return { tools: [...tools], commands: [...commands] };
}

/**
 * The policy of one mission.
 * @param {Pick<ProviderAgentConfig, 'permission_mode' | 'allowed_tools' | 'disallowed_tools'>} cfg
 * @param {PolicyPlan} plan
 * @returns {BridgePolicy}
 */
export function piPermissionPolicy(cfg, plan) {
  const grants = piGrants(cfg.allowed_tools);
  const refusals = piRefusals(cfg.disallowed_tools);
  const { commandPolicy } = plan;
  return {
    mode: piPermissionMode(cfg.permission_mode),
    allowTools: [...plan.preApprovedTools],
    // Every server of the plan but the agent's own (`role: 'user'`): Timon's, the forms, grepai, the browser.
    hintServers: plan.servers.filter((server) => server.role !== 'user').map((server) => server.name),
    allowCommands: commandPolicy.timonCliCommands.map((command) => `timon ${command}:*`),
    grantTools: grants.tools,
    grantCommands: grants.commands,
    denyTools: refusals.tools,
    denyPrograms: [...commandPolicy.denyPrograms],
    denyCommands: [
      ...commandPolicy.denyCommands,
      ...commandPolicy.denyTimonCommands.map((command) => `timon ${command}`),
      ...refusals.commands,
    ],
  };
}
