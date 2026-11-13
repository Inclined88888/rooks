/**
 * Catalogue of the bundled modules — the list, and nothing else.
 *
 * In a file of its own rather than in `boot.ts` because
 * `/api/capabilities` (served by `@rooks/http`) must read it: having it in
 * `boot.ts` would create the cycle `@rooks/http` → boot → `@rooks/http`.
 */
import type { ModuleDescriptor } from './registry.js';

/**
 * Catalogue of the bundled modules, in the order of §3.4 of the plan.
 *
 * This order is purely documentary: Cordis mounts the entries in parallel
 * and the real order comes from the `inject`s. Keeping it aligned with the plan simply
 * makes the list readable next to it.
 */
export const CATALOG: readonly ModuleDescriptor[] = [
  { id: '@rooks/db', name: './plugins-bundled/db/index.js', tier: 'core' },
  { id: '@rooks/settings', name: './plugins-bundled/settings/index.js', tier: 'core' },
  { id: '@rooks/http', name: './plugins-bundled/http/index.js', tier: 'core' },
  // The person's own account, sessions and login: not negotiable (the maintainer, 05/11/2026).
  { id: '@rooks/users', name: './plugins-bundled/users/index.js', tier: 'core' },
  { id: '@rooks/plugins', name: './plugins-bundled/plugins/index.js', tier: 'core' },
  { id: '@rooks/secrets-vault', name: './plugins-bundled/secrets-vault/index.js', tier: 'opt' },
  { id: '@rooks/ui-layout', name: './plugins-bundled/ui-layout/client.js', tier: 'std', clientOnly: true },
  { id: '@rooks/ui-theme', name: './plugins-bundled/ui-theme/client.js', tier: 'std', clientOnly: true },
  { id: '@rooks/backends', name: './plugins-bundled/backends/index.js', tier: 'core' },
  { id: '@rooks/agents', name: './plugins-bundled/agents/index.js', tier: 'core' },
  { id: '@rooks/missions', name: './plugins-bundled/missions/index.js', tier: 'core' },
  // HTML documents shown in a conversation (MCPUI, docs/ADR-MCPUI.md).
  { id: '@rooks/ui-documents', name: './plugins-bundled/ui-documents/index.js', tier: 'std', dependsOn: ['@rooks/missions'] },
  { id: '@rooks/company', name: './plugins-bundled/company/client.js', tier: 'std', clientOnly: true, dependsOn: ['@rooks/agents'] },
  { id: '@rooks/agents-projects', name: './plugins-bundled/agents-projects/client.js', tier: 'std', clientOnly: true, dependsOn: ['@rooks/projects'] },
  { id: '@rooks/bots', name: './plugins-bundled/bots/client.js', tier: 'std', clientOnly: true, dependsOn: ['@rooks/agents'] },
  // The chat's Files card (TODO #356). Its route stays in the core agents module.
  { id: '@rooks/files-widget', name: './plugins-bundled/files-widget/client.js', tier: 'std', clientOnly: true, dependsOn: ['@rooks/agents'] },
  // The chat's Skills and MCP cards (TODO #357). Their routes stay in the core agents module.
  { id: '@rooks/skills-widget', name: './plugins-bundled/skills-widget/client.js', tier: 'std', clientOnly: true, dependsOn: ['@rooks/agents'] },
  { id: '@rooks/mcp-widget', name: './plugins-bundled/mcp-widget/client.js', tier: 'std', clientOnly: true, dependsOn: ['@rooks/agents'] },
  // The Apps catalogue: remote MCP servers of their publishers, connected in one click (TODO #832).
  // MCP storage, OAuth and launch stay in the core agents module.
  { id: '@rooks/mcp-apps', name: './plugins-bundled/mcp-apps/index.js', tier: 'std', dependsOn: ['@rooks/agents'] },
  { id: '@rooks/projects', name: './plugins-bundled/projects/index.js', tier: 'std' },
  { id: '@rooks/notifications', name: './plugins-bundled/notifications/index.js', tier: 'std' },
  { id: '@rooks/web-push', name: './plugins-bundled/web-push/index.js', tier: 'opt', dependsOn: ['@rooks/notifications'] },
  { id: '@rooks/memory', name: './plugins-bundled/memory/index.js', tier: 'opt' },
  // Runs without git: only the code, review and merge tasks of a git project
  // need it (`task-git.ts`,
  // TODO #275). `requires: ['git']` instead would switch the board off.
  { id: '@rooks/kanban', name: './plugins-bundled/kanban/index.js', tier: 'std', recommends: { git: 'code, review and merge tasks of a git project are refused' } },
  { id: '@rooks/git', name: './plugins-bundled/git/index.js', tier: 'std', requires: ['git'] },
  { id: '@rooks/kanban-code', name: './plugins-bundled/kanban-code/index.js', tier: 'dev', requires: ['git'], licensed: true, dependsOn: ['@rooks/kanban', '@rooks/git'] },
  { id: '@rooks/todo-outcomes', name: './plugins-bundled/todo-outcomes/index.js', tier: 'opt', dependsOn: ['@rooks/kanban'] },
  { id: '@rooks/triggers', name: './plugins-bundled/triggers/index.js', tier: 'std', dependsOn: ['@rooks/kanban'] },
  { id: '@rooks/routines', name: './plugins-bundled/routines/index.js', tier: 'std', dependsOn: ['@rooks/kanban'] },
  { id: '@rooks/workflows', name: './plugins-bundled/workflows/index.js', tier: 'std' },
  { id: '@rooks/dreams', name: './plugins-bundled/dreams/index.js', tier: 'std', licensed: true, dependsOn: ['@rooks/memory'] },
  { id: '@rooks/agent-chat', name: './plugins-bundled/agent-chat/client.js', tier: 'std', clientOnly: true },
  { id: '@rooks/resources-guard', name: './plugins-bundled/resources-guard/index.js', tier: 'std', requires: ['systemd'] },
  { id: '@rooks/vault', name: './plugins-bundled/vault/index.js', tier: 'opt' },
  { id: '@rooks/grepai', name: './plugins-bundled/grepai/index.js', tier: 'dev', requires: ['grepai', 'systemd'] },
  { id: '@rooks/docker-supervision', name: './plugins-bundled/docker-supervision/index.js', tier: 'dev', requires: ['containers'] },
  { id: '@rooks/browser-embedded', name: './plugins-bundled/browser-embedded/index.js', tier: 'opt', requires: [] },
  // Recording a flow in the built-in browser and turning it into a skill (TODO #461).
  { id: '@rooks/browser-recording', name: './plugins-bundled/browser-recording/index.js', tier: 'opt', dependsOn: ['@rooks/browser-embedded'] },
  // Pointing at an element of the built-in browser and sending it to an agent (TODO #468).
  { id: '@rooks/browser-annotations', name: './plugins-bundled/browser-annotations/index.js', tier: 'opt', dependsOn: ['@rooks/browser-embedded'] },
  { id: '@rooks/terminal-native', name: './plugins-bundled/terminal-native/index.js', tier: 'opt', requires: ['gui'] },
  { id: '@rooks/terminal-web', name: './plugins-bundled/terminal-web/index.js', tier: 'opt' },
  { id: '@rooks/orchestrator-self', name: './plugins-bundled/orchestrator-self/index.js', tier: 'opt', requires: ['systemd'] },
  { id: '@rooks/web-app', name: './plugins-bundled/web-app/index.js', tier: 'std' },
  { id: '@rooks/telegram', name: './plugins-bundled/telegram/index.js', tier: 'opt' },
  { id: '@rooks/whatsapp', name: './plugins-bundled/whatsapp/index.js', tier: 'opt' },

  { id: '@rooks/tts', name: './plugins-bundled/tts/index.js', tier: 'opt' },
  { id: '@rooks/gpt-live', name: './plugins-bundled/gpt-live/index.js', tier: 'opt' },
  { id: '@rooks/video-factory', name: './plugins-bundled/video-factory/index.js', tier: 'opt' },
  // Whether a newer Rooks is published (docs/AUTO-UPDATE.md); ROOKS_UPDATES_CHECK turns the request off.
  { id: '@rooks/updates', name: './plugins-bundled/updates/index.js', tier: 'std' },
  // Anonymous product analytics (docs/TELEMETRY.md); its own setting turns the sending off.
  { id: '@rooks/telemetry', name: './plugins-bundled/telemetry/index.js', tier: 'std' },
  // The fleet of machines (TODO #329): keeps device tokens to other daemons in
  // the vault, so it is off until the user switches it on. Paid licences only
  // (the maintainer, 25/10/2026): never part of the Free composition.
  { id: '@rooks/machines', name: './plugins-bundled/machines/index.js', tier: 'opt', offByDefault: true, licensed: true, dependsOn: ['@rooks/users', '@rooks/secrets-vault'] },
];
