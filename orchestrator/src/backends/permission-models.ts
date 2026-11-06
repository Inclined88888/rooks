/**
 * The three ways a CLI can be made to respect Timon's permission policy
 * (`PermissionModel`), and what a dialect owes for each.
 *
 *   mcp-bridge — the CLI asks an injected MCP tool before every tool use that is
 *                not pre-approved: the dialect passes that tool's name
 *                (`CLAUDE_PERMISSION_PROMPT_TOOL`) and declares `timon_ask`.
 *                The answer is an Allow/Deny card and a classifier.
 *   sandbox    — nothing can be asked mid-turn; privileges are frozen at spawn.
 *                The dialect turns `permission_mode` into the CLI's own level
 *                (`sandboxLevelForPermissionMode` is the usual three).
 *   protocol   — the agent asks through its protocol (ACP
 *                `session/request_permission`); the session driver forwards it
 *                to `SessionHost.requestPermission`.
 *
 * A leaf of the backends module: the mapping is moved verbatim out of
 * le plugin `provider-codex` (`official-providers/provider-codex/lib/codex.js`).
 */

/** Map our agent.permission_mode → a sandbox level, as Codex's `--sandbox` has
 *  them. Only three levels (read-only / workspace-write / danger-full-access),
 *  so this is a coarser knob than Claude's permission system. Any dialect whose
 *  permission model is `sandbox` can reuse it. */
export function sandboxLevelForPermissionMode(permissionMode: string | undefined): string {
  switch (permissionMode) {
    case 'plan':
    case 'read-only':
      return 'read-only';
    case 'bypassPermissions':
    case 'danger-full-access':
      return 'danger-full-access';
    case 'auto':
    case 'acceptEdits':
    case 'default':
    case undefined:
    default:
      return 'workspace-write';
  }
}

/** What a dialect declaring `model` must be able to do — as sentences, for the
 *  registration check and the docs. `none` owes nothing: it is an admission. */
export const PERMISSION_MODEL_OBLIGATIONS: Readonly<Record<'mcp-bridge' | 'sandbox' | 'protocol' | 'none', string>> = {
  'mcp-bridge': 'pass the permission tool to the CLI at spawn and declare the `timon_ask` MCP server',
  sandbox: 'freeze the privileges at spawn from `permission_mode`; there is no card and no classifier',
  protocol: 'supply `openSession`: its driver forwards the agent\'s permission requests to `host.requestPermission`',
  none: 'nothing — the CLI runs everything unguarded, which the UI says plainly',
};
