/**
 * What to tell a user whose ACP agent wants a sign-in.
 *
 * `initialize` lists the agent's `authMethods` and `session/new` answers
 * `auth_required` (-32000) until one is done — but a method is a name, not a
 * command, and ROOKS cannot run a login for the user (opencode's is a browser
 * flow, Hermes' a terminal wizard). So the message names the step the agent's
 * OWN CLI offers. The commands are data the agent's provider declares, by the
 * method ids it observed; an agent that declared none keeps the generic message
 * built from the method names alone.
 */

/**
 * What an agent's provider writes for a sign-in (`AcpAgentSpec.signIn`): the
 * command its own CLI offers, by the method ids it announces, and one for when
 * none of them is known.
 */
export type AcpSignIn = {
  /** By `authMethods[].id`, the most precise reading. */
  readonly byMethod?: Readonly<Record<string, string>>;
  /** When none of the announced ids is known. */
  readonly fallback: string;
};

function idOf(method: unknown): string | null {
  if (method === null || typeof method !== 'object') return null;
  const id = (method as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * The instruction that answers an `auth_required`, or null for an agent whose
 * provider declared none. `methods` is the raw `authMethods` of `initialize`;
 * nothing the agent wrote is echoed back — only ids are compared.
 */
export function signInAdvice(signIn: AcpSignIn | undefined, methods: unknown): string | null {
  if (!signIn) return null;
  for (const method of Array.isArray(methods) ? methods : []) {
    const id = idOf(method);
    const known = id !== null ? signIn.byMethod?.[id] : undefined;
    if (known) return known;
  }
  return signIn.fallback;
}
