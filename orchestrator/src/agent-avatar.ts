/**
 * An agent's profile picture: what `PUT /api/agents/:name/avatar` accepts and
 * what it does with it, shared with the plugin facade (`ctx.agents.setAvatar`).
 */
import { z } from 'zod';
import { getAgent, patchAgentConfig } from './agent.js';
import { deleteAgentIconByUrl, saveAgentIcon } from './uploads.js';
import type { AgentAvatarInput as ContractAgentAvatarInput } from './plugins/contract/agents.js';
import type { Assert, Equals } from './type-equality.js';

/** Base64 of the 2 MB image cap (`uploads.ts`), with a little headroom for a
 *  `data:` prefix: the decoded size is checked again on save. */
const AVATAR_PAYLOAD_MAX_CHARS = 2_900_000;

/** What `PUT /api/agents/:name/avatar` accepts: inline image bytes, or the
 *  explicit order to remove the picture. A path or a URL is deliberately not
 *  an option — the daemon never reads a file, or fetches an address, on the
 *  word of whoever calls it. */
export const agentAvatarSchema = z.union([
  z.object({ clear: z.literal(true) }).strict(),
  z.object({ dataUrl: z.string().max(AVATAR_PAYLOAD_MAX_CHARS) }).strict(),
  z.object({
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    data: z.string().max(AVATAR_PAYLOAD_MAX_CHARS),
  }).strict(),
]);


export type AgentAvatarInput = z.infer<typeof agentAvatarSchema>;
/** The public contract spells the schema out; compilation fails if they part. */
type _AgentAvatarInputMatchesContract = Assert<Equals<AgentAvatarInput, ContractAgentAvatarInput>>;

/**
 * Sets or removes the picture; `null` when the agent does not exist.
 * `icon_url` is the new picture, `null` once removed.
 */
export function applyAgentAvatar(name: string, input: AgentAvatarInput): { name: string; icon_url: string | null } | null {
  const current = getAgent(name);
  if (!current) return null;
  const next = 'clear' in input ? null : saveAgentIcon(input).url;
  patchAgentConfig(current.name, { icon_url: next ?? undefined });
  // Only a picture we stored is ours to delete; a pasted URL or a project
  // logo is left alone. Done after the config write so a failed save keeps
  // the old picture on screen.
  deleteAgentIconByUrl(current.icon_url);
  return { name: current.name, icon_url: next };
}
