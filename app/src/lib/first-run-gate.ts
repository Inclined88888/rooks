/**
 * Sending a fresh install through onboarding, wherever it lands (step 5.9.2).
 * The destination is the onboarding v2 (`FIRST_RUN_PATH`); `/setup` stays
 * allowed, as the repair screen.
 *
 * Step 5.7.4 built a blocking `/setup` screen and nobody ever saw it. On the
 * first real launch of the package the user created their account, landed on the home
 * page, and that was that: the daemon still answered `firstRun: true`, no
 * `timon.config.json` was ever written, and the service whose installation is
 * supposed to be mandatory was never installed. The screen was blocking; the
 * route to it did not exist.
 *
 * The gate therefore lives where every page goes through — the client host on
 * the root layout, which already holds `capabilities` and needs no extra call.
 * This module is the decision alone, so the flow can be tested rather than
 * clicked.
 */

/**
 * Pages reachable while the machine is unconfigured.
 *
 * `/login` because onboarding needs an account first — bouncing an anonymous
 * visitor to `/setup` would strand them on a screen that cannot talk to the
 * daemon. `/setup` because that is the destination. `/onboarding` because it is
 * the flow itself: a step that is still a stand-in hands over to an older
 * screen (docs/ONBOARDING.md).
 */
export const FIRST_RUN_ALLOWED = ['/login', '/onboarding', '/setup'];

/**
 * The former first-run wizard. Out of the normal flow since the onboarding
 * v2 installs the service in the background (docs/ONBOARDING-PREPARATION.md),
 * still reachable to repair an install: the preparation card links to it.
 */
export const SETUP_PATH = '/setup';

/**
 * Where an unconfigured install is sent: the onboarding, past the account it
 * already has — the AI step. The same address as `stepHref('llm')`
 * (`components/onboarding/onboarding-flow.ts`, held by its test).
 */
export const FIRST_RUN_PATH = '/onboarding?step=llm';

/**
 * Where a configured install whose main agent has not welcomed its person yet
 * is sent: the TIMs page, where the main agent speaks first (its welcome,
 * `plugins-client/bots/bots-welcome.tsx`). The page sends an agent not named
 * yet back to the onboarding's agent step. The same address as
 * `SETUP_LANDING` (`app/setup/agent/setup-landing.ts`, held by the test).
 */
export const WELCOME_PATH = '/bots';

/**
 * The same conversation, on the repair screen: where the welcome happens when
 * the TIMs page is not reachable (its module switched off, a surface the
 * account's role does not grant).
 */
export const MAIN_AGENT_REPAIR_PATH = '/setup/agent';

/** Step 5, the last gate: the daemon must restart before the cockpit opens. */
export const RESTART_PATH = '/setup/restart';

/**
 * Does this page take its light/dark from the onboarding rather than from an account?
 *
 * The onboarding surfaces — the account form, then every `/setup` step — are
 * shown BEFORE a preference exists. They open dark for everyone, whatever the
 * OS (the maintainer, 05/11/2026: the brand is shown dark, people switch if they want);
 * the onboarding's switch picks the other one, and the account takes that
 * choice when it is created. Everywhere else the account's choice wins.
 *
 * The same list as `FIRST_RUN_ALLOWED`, deliberately: login and `/setup` are one
 * continuous first-run surface (cf. `onboarding-backdrop.tsx`), and a scheme
 * that changed between them would be the "changed skin" bug again.
 */
export function schemeFollowsSystem(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  return FIRST_RUN_ALLOWED.some((allowed) => path === allowed || path.startsWith(`${allowed}/`));
}

/** The scheme of the first-run surfaces before anyone picks one: dark, for everyone. */
export const FIRST_RUN_DEFAULT_SCHEME = 'light' as const;

/**
 * Where the light/dark picked on the onboarding's switch waits for the account
 * it becomes the scheme of. Session storage: it outlives the full navigations
 * of the flow (a stand-in step, the desktop handover) but not the tab, so an
 * abandoned onboarding leaves nothing behind for the next one. Read by the
 * pre-paint script of `app/layout.tsx` too.
 */
export const FIRST_RUN_SCHEME_KEY = 'timon-onboarding-scheme';

/** The scheme picked on the onboarding's switch, or `null`: then the OS decides. */
export function chosenFirstRunScheme(): 'light' | 'dark' | null {
  try {
    const value = window.sessionStorage.getItem(FIRST_RUN_SCHEME_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

export function storeFirstRunScheme(scheme: 'light' | 'dark'): void {
  try {
    window.sessionStorage.setItem(FIRST_RUN_SCHEME_KEY, scheme);
  } catch {
    /* private mode: the choice holds for this page only */
  }
}

/** The scheme the first-run surfaces paint: the one picked on the switch, else dark. */
export function firstRunScheme(): 'light' | 'dark' | undefined {
  if (typeof window === 'undefined') return undefined;
  return chosenFirstRunScheme() ?? FIRST_RUN_DEFAULT_SCHEME;
}

/** Where this navigation must go instead, or `null` to let it through. */
export function firstRunTarget(state: {
  pathname: string;
  /** `capabilities.firstRun`: no `timon.config.json` on the daemon's machine. */
  firstRun: boolean | undefined;
  teamOnboarding?: boolean;
  /** `capabilities.mainAgentOnboarding`: the main agent's welcome has not
   *  ended (`setup_finish`), so the team screen is not yet the destination. */
  mainAgentOnboarding?: boolean;
  /**
   * Can this viewer open the TIMs page (`setupLanding(caps) === '/bots'`)?
   * `false` sends the welcome to the repair screen instead; `undefined`
   * (capabilities not read) counts as yes, the page being the product's own.
   */
  welcomeAvailable?: boolean;
  /**
   * `capabilities.restartOnboarding`: the daemon is still the process that
   * wrote `timon.config.json`, so it runs on the configuration the wizard
   * replaced. Step 5 — the LAST one, checked after the team: it is the ending
   * of the wizard, not a detour inside it.
   */
  restartOnboarding?: boolean;
  /**
   * May this viewer see `/setup` at all? `ModulePageGate` paints a forbidden
   * screen for a restricted viewer, and we redirect with `replace` — sending
   * someone there who cannot render it would trap them on a dead page with no
   * history to go back through. Trapping a user is worse than the bug this
   * gate fixes, so a restricted viewer is left alone and the machine stays
   * unconfigured until its owner comes back.
   */
  canConfigure?: boolean;
}): string | null {
  // `undefined` = capabilities not loaded yet. Redirecting on a guess would
  // flash `/setup` on every configured install at every cold start.
  if (state.teamOnboarding === true && state.firstRun === false && state.canConfigure !== false) {
    const path = state.pathname.replace(/\/+$/, '') || '/';
    if (path === '/login' || path.startsWith('/login/')) return null;
    // The onboarding leads to the same steps on its own.
    if (path === '/onboarding' || path.startsWith('/onboarding/')) return null;
    // The welcome before step 4: until the main agent ends it, every page
    // leads back to its conversation, on the TIMs page — or on the repair
    // screen, which hosts the same conversation, when that page is out of reach.
    if (state.mainAgentOnboarding === true) {
      if (path === MAIN_AGENT_REPAIR_PATH || path.startsWith(`${MAIN_AGENT_REPAIR_PATH}/`)) return null;
      if (state.welcomeAvailable === false) return MAIN_AGENT_REPAIR_PATH;
      return path === WELCOME_PATH ? null : WELCOME_PATH;
    }
    return path === '/setup/team' ? null : '/setup/team';
  }
  // The restart is no longer a step anyone is held on. On the desktop, the shell
  // already moved onto the service before step 3 (`handOverToService`); a
  // browser or a portable install still gets the top bar's banner
  // (`SetupRestartBanner`), and `/setup/restart` stays reachable.
  if (state.firstRun !== true) return null;
  if (state.canConfigure === false) return null;
  const path = state.pathname.replace(/\/+$/, '') || '/';
  if (FIRST_RUN_ALLOWED.some((allowed) => path === allowed || path.startsWith(`${allowed}/`))) {
    return null;
  }
  return FIRST_RUN_PATH;
}
