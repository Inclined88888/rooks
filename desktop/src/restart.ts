import { isAbsolute } from 'node:path';
import { shellText } from './shell-i18n.js';

export const SETUP_RESTART_CHANNEL = 'timon:restart-after-setup';
export const SETUP_RESTART_STATUS_CHANNEL = 'timon:setup-restart-pending';
export const SETUP_HANDOVER_CHANNEL = 'timon:setup-handover';

/** A portable first run already saved into the embedded daemon. The banner is only for handing that daemon over to an installed service. */
export function setupRestartPending(state: { embedded: boolean; configuredAtLaunch: boolean; configuredNow: boolean; serviceInstalled: boolean }): boolean {
  return state.embedded && state.configuredNow && state.serviceInstalled && !state.configuredAtLaunch;
}

export function canRestartFromSetup(sender: {
  isWindow: boolean;
  isMainFrame: boolean;
  url: string;
}, uiOrigin: string): boolean {
  if (!sender.isWindow || !sender.isMainFrame) return false;
  try {
    const url = new URL(sender.url);
    // Navigation after setup must retain the action. Authority remains bound
    // to the trusted main frame and exact app origin, never a browser tab.
    return url.origin === new URL(uiOrigin).origin;
  } catch { return false; }
}

export function relaunchOptions(platform: string, env: NodeJS.ProcessEnv, argv: string[]): {
  execPath?: string;
  args: string[];
} {
  // The mounted Electron binary disappears when an AppImage exits. Relaunch
  // its original file, without re-evaluating the launching shell command.
  const appImage = platform === 'linux' ? env.APPIMAGE : undefined;
  if (appImage && !isAbsolute(appImage)) throw new Error('The AppImage path is not absolute.');
  return { ...(appImage ? { execPath: appImage } : {}), args: argv.slice(1) };
}

/** A double click must never schedule two replacements of the same shell. */
export function setupRestarter(actions: {
  validate: () => void;
  stopEmbedded: () => Promise<void>;
  relaunch: () => void | (() => void) | Promise<void | (() => void)>;
  quit: () => void;
  /** True when an installed service, not an embedded child, runs the daemon. */
  serviceOwnsDaemon?: () => boolean;
  restartService?: () => Promise<void>;
}): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    let cancel: void | (() => void);
    pending ??= Promise.resolve().then(async () => {
      actions.validate();
      // Relaunching the shell would leave that service untouched, and the page
      // would come back to the same step forever. Restart the service instead;
      // the page is already waiting for a new daemon to answer.
      if (actions.serviceOwnsDaemon?.() && actions.restartService) {
        await actions.restartService();
        pending = undefined;
        return;
      }
      await actions.stopEmbedded();
      cancel = await actions.relaunch();
      actions.quit();
    }).catch((error: unknown) => {
      cancel?.();
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

/**
 * Does the end of a first setup hand the embedded daemon's place to the
 * service the wizard just installed? Left running, the embedded daemon served
 * step 3 while the service crash-looped beside it on the same database, and
 * each of its boots failed the setup mission, whose token then got 401s.
 *
 * Never on a portable install (no supervisor, or Windows refused the task,
 * TODO #342), and never when the service would answer on other ports than
 * the ones the window uses: stopping the embedded daemon would gain nothing.
 */
export function serviceHandoverNeeded(state: {
  embedded: boolean;
  configuredAtLaunch: boolean;
  configuredNow: boolean;
  serviceInstalled: boolean;
  serviceRefused: boolean;
  supervisor: string;
  sameOrigins: boolean;
}): boolean {
  return state.embedded && !state.configuredAtLaunch && state.configuredNow && state.serviceInstalled
    && !state.serviceRefused && state.supervisor !== 'none' && state.sameOrigins;
}

/** Where the page asks to land once the service answers: a path of the interface, never a URL. */
export function handoverRoute(route: unknown, origin: string): string | null {
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || route.includes('\\')) return null;
  try {
    const url = new URL(route, origin);
    return url.origin === new URL(origin).origin ? `${url.pathname}${url.search}` : null;
  } catch { return null; }
}

export type HandoverOutcome = 'not-needed' | 'handed-over' | 'kept-embedded';

/**
 * The embedded daemon gives its place to the installed service, in the running
 * shell. Not a relaunch (`setupRestarter`): a relaunched shell whose service
 * does not answer ends on a dead window, while this one can start its embedded
 * daemon again and keep the setup going.
 *
 * The pages move to the waiting page BEFORE the daemon stops: a page still on
 * the interface when its port closes retries, then reports a failure.
 */
export function serviceHandover(actions: {
  needed: () => boolean;
  showRestarting: (route: string) => void;
  stopEmbedded: () => Promise<void>;
  /** Starts the service now rather than at its supervisor's next attempt; `false` when it cannot start. */
  kickService: () => Promise<boolean>;
  /** The service answers as this home's daemon within the budget. */
  waitService: () => Promise<boolean>;
  /** The service answers: the pages load the interface again. */
  resume: () => void;
  /** It does not: the embedded daemon serves again, and the pages follow it. */
  resumeEmbedded: () => Promise<void>;
  reportKept: (why: string | null) => void;
}): (route: string) => Promise<HandoverOutcome> {
  let pending: Promise<HandoverOutcome> | undefined;
  return (route) => {
    pending ??= (async (): Promise<HandoverOutcome> => {
      if (!actions.needed()) return 'not-needed';
      actions.showRestarting(route);
      try {
        await actions.stopEmbedded();
      } catch (error) {
        // Still the embedded daemon's: the pages go back to it.
        actions.resume();
        throw error;
      }
      let why: string | null = null;
      let answered = false;
      try {
        answered = await actions.kickService() && await actions.waitService();
      } catch (error) { why = (error as Error).message; }
      if (answered) {
        actions.resume();
        return 'handed-over';
      }
      await actions.resumeEmbedded();
      actions.reportKept(why);
      return 'kept-embedded';
    })().finally(() => { pending = undefined; });
    return pending;
  };
}

/** Said when the service did not take over: the setup goes on, on the embedded daemon. */
export function handoverKeptMessage(locale: string, home: string, why: string | null): { message: string; detail: string } {
  const t = shellText(locale);
  const reason = why ? `\n\n${why}` : '';
  return { message: t('service.handoverKept'), detail: `${t('service.handoverKeptDetail', { home })}${reason}` };
}
