/**
 * The origin mark of a rule a plugin wrote: `memory_rules.source` =
 * `plugin:<id>`, the same shape as the agents a plugin creates
 * (`plugins/agent-origin.ts`). The prefix is RESERVED: `addMemoryRule` refuses
 * it from any payload, so only `ctx.memory` can set it, and a rule cannot be
 * forged into a plugin's ownership.
 */
export const PLUGIN_RULE_SOURCE_PREFIX = 'plugin:';

export function pluginRuleOrigin(pluginId: string): string {
  return `${PLUGIN_RULE_SOURCE_PREFIX}${pluginId}`;
}

export function isPluginRuleSource(source: string): boolean {
  return source.trim().toLowerCase().startsWith(PLUGIN_RULE_SOURCE_PREFIX);
}
