/**
 * The chat's Skills card: the agent's skills, switched on and off from the
 * right rail (TODO #357).
 *
 * Browser-only on purpose: the skills catalogue and the agent's list stay
 * routes of the core `@timon/agents`, which the agent editor, the `/skills`
 * page and the CLI read too. What this module owns is the card itself, so it
 * can be switched off and granted on its own (`widget:skills-widget`) —
 * `dependsOn` keeps it off whenever those routes are.
 */
export const clientOnly = true;
