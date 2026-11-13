/**
 * The chat's Files card: the agent's folder in the left rail (TODO #356).
 *
 * Browser-only on purpose: `/api/agents/:name/files` stays a route of the core
 * `@rooks/agents`, which the agent editor and the CLI read too. What this
 * module owns is the card itself, so it can be switched off and granted on
 * its own (`widget:files-widget`) — `dependsOn` keeps it off whenever that route is.
 */
export const clientOnly = true;
