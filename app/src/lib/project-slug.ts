/**
 * The project a conversation's tool panels speak about: the agent's project,
 * else the prefix of a `<project>.<role>` name. The chat page and the
 * composer derive it the same way, so their Git reads share one store key.
 */
export function projectSlugOf(project: string | null | undefined, agentName: string): string | null {
  return project ?? (agentName.includes('.') ? agentName.split('.')[0]!.toLowerCase() : null);
}
