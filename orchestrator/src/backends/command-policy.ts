/**
 * What a mission's agent may NOT run, and which of Rooks's own CLI commands it
 * needs, as data a provider turns into its CLI's rule syntax
 * (`ctx.provider.mcp().commandPolicy`, docs/PROVIDERS-SDK.md S1).
 *
 * These are decisions of the PRODUCT, not of a provider (AGENTS.md rules 1 and 3):
 * a mission runs UNDER the orchestrator, so restarting it kills its own mission;
 * the frozen archive of the ancestor must not be started again. A provider
 * written as a plugin must enforce them as the product's own do, and must not
 * have to know why. grok writes them as `Bash(rm -rf /*)`, copilot as
 * `shell(rm -rf /)`: each keeps its syntax and reads the content from here
 * (`command-policy.test.ts` holds both to this list).
 *
 * A `*` ending a command matches any continuation of it.
 */
export const COMMAND_POLICY = Object.freeze({
  /** Programs refused whatever their arguments: privilege and machine-level operations. */
  denyPrograms: Object.freeze(['sudo', 'mkfs', 'shutdown', 'reboot']),
  /** Command lines refused. */
  denyCommands: Object.freeze([
    // Recursive destruction outside the project's perimeter.
    'rm -rf /',
    'rm -rf /*',
    'rm -rf ~',
    'rm -rf ~*',
    'rm -rf $HOME*',
    // A task runs UNDER the orchestrator: restarting it kills its own mission
    // mid-flight (AGENTS.md rule 1). That is ops, never agent work.
    'systemctl --user restart rooks-orchestrator*',
    'systemctl --user stop rooks-orchestrator*',
    // The ancestor's unit, for the opposite reason: stopped and disabled but still
    // `loaded`, an explicit start would bring it back and let it write into
    // the archive's home, frozen because it holds data no other copy has
    // (AGENTS.md rule 3). public-name-ok: the archive guard refuses it by name
    'systemctl --user restart pkos-orchestrator*',
    'systemctl --user stop pkos-orchestrator*',
    'systemctl --user start pkos-orchestrator*',
  ]),
  /** `rooks <command>` refused: the service, an approved update and the web app all restart under the mission. */
  denyNovaCommands: Object.freeze(['service', 'update', 'daemon', 'app restart']),
  /**
   * The Rooks CLI commands a mission needs, as `<command> <subcommand>` after `rooks`.
   * Named one by one because `rooks:*` also covers the CLI's host operations
   * (`service install|uninstall`, `update approve`, `plugin add`, `auth`, `secret`,
   * `user`, `backup`, `import`…), which a mission never runs and some of which kill it.
   */
  novaCliCommands: Object.freeze([
    'task list', 'task get', 'task create', 'task update', 'task done', 'task block',
    'task mark-as-done', 'task mark-as-failed',
    'notify report', 'notify alert',
    'msg send', 'msg recv', 'msg pick', 'msg reply',
    'spawn', 'wait', 'status', 'send', 'list',
    'worktree info',
    'memory rule add', 'memory rule list',
    'series fallback list', 'series role list',
    'project list', 'project roles',
    'project-todo list', 'project-todo add',
    'workflow node done',
  ]),
});
