/**
 * Extract a leading @tag (e.g. "@dev fix this") and resolve it to an agent
 * via the channel's routing table. Falls back to the channel's default agent.
 */
export function routeMessage(
  text: string,
  defaultAgent: string,
  routing?: Record<string, string>,
): { agent: string; cleanedText: string } {
  const match = text.match(/^\s*(@[\w-]+)\s+([\s\S]*)$/);
  if (!match) return { agent: defaultAgent, cleanedText: text };
  const tag = match[1]!;
  const rest = match[2]!;
  const target = routing?.[tag];
  if (!target) return { agent: defaultAgent, cleanedText: text };
  return { agent: target, cleanedText: rest };
}
