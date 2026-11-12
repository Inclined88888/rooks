/**
 * Identity of the card a fresh install opens on: the main agent's chat, in
 * the cockpit centre.
 *
 * It lives in a module of its own because three unrelated places need the
 * same string and none of them may import the others: the widget starters
 * (`components/widget-host/widget-defaults.ts`, a pure module the tests run
 * headless), the agent-chat instance store (`plugins-client/agent-chat`,
 * client-only) and, on the daemon side, the row seeded at the end of
 * onboarding (`orchestrator/src/onboarding-main-agent.ts`, which carries its
 * own copy — the two packages are independent, like `brand.ts`).
 *
 * `main` and not a UUID: the starter placement has to name the widget before
 * the instance exists, so the id of the seeded card is a constant.
 */
export const MAIN_AGENT_CARD_ID = 'main';

/** What the widget host persists that card's placement under. */
export const MAIN_AGENT_WIDGET_ID = `plugin:@rooks/agent-chat:${MAIN_AGENT_CARD_ID}`;
