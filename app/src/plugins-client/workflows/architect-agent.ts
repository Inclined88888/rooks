/** The pilot of this workflow: the agent it is assigned to. A reply naming any other agent is refused. */
export async function resolveArchitectAgent(workflow: { id: string; agent_name: string | null }, signal?: AbortSignal): Promise<string> {
  if (!workflow.agent_name) throw new Error('workflow has no assigned agent');
  const response = await fetch(`/api/ui/workflows/${encodeURIComponent(workflow.id)}/chat-agent`, { method: 'POST', signal });
  const body = await response.json() as { agent?: unknown };
  if (!response.ok || body.agent !== workflow.agent_name) throw new Error('workflow agent unavailable');
  return body.agent;
}
