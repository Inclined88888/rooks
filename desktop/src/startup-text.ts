/**
 * The words of the dialogs that report a failed start (daemon missing,
 * crashing, silent, port taken, interface missing, service not updated).
 *
 * They may open before the session has a `timon-locale` cookie, or with the
 * daemon dead: the caller then passes the OS's language (`uiLocale()` falls
 * back on `getPreferredSystemLanguages()`). And they must open even when the
 * locale files cannot be read — a broken or missing `resources/locales` is
 * precisely the kind of install that ends in one of them — so a key the
 * files do not give reads from the English copy below instead of showing
 * its own name.
 */
import { SOURCE_LOCALE, translate, type Dictionary, type MessageVars } from './i18n-core.js';
import { shellText } from './shell-i18n.js';

/**
 * Copy of `desktop.startup` in `app/src/locales/en/desktop.json`, the last
 * resort; `startup-text.test.ts` holds both identical.
 */
export const STARTUP_ENGLISH: Dictionary = {
  desktop: {
    startup: {
      failed: 'Startup failed.',
      restartFailed: 'Could not restart Timon.',
      restartFailedDetail:
        'Your data remains in {home}.\n\n{reason}\n\nQuit and reopen Timon with the same data directory.',
      missing: 'The bundled daemon is missing.',
      missingDetail:
        'Expected at {path}. This build is incomplete — reinstall {app}, or start a daemon yourself and set daemon.supervisor in timon.config.json.',
      reopenTray:
        'reopen the window from the {app} icon in the notification area{when, select, moment { in a moment} minute { in a minute} other {}}',
      reopenRelaunch:
        'quit {app} and launch it again{when, select, moment { in a moment} minute { in a minute} other {}}',
      giveUp: '{url} did not answer within {seconds}s.',
      uiMissing: 'The interface did not come up.',
      uiMissingDetail:
        '{giveUp}\n\nThe daemon may be running without its web app: quit and reopen Timon. If it persists, copy the diagnostic and send it to support.',
      crashing: 'The daemon keeps crashing.',
      crashingDetail: '{why}\n\nThe bundled daemon could not start. Your data remains in {home}.',
      slow: 'The daemon did not answer in time.',
      slowDetail:
        'Started in portable mode but {origin} stayed silent for {seconds}s. It may still be migrating its database — {reopen}.',
      portTaken: 'Another service is using {origin}.',
      portTakenDetail:
        'Something answers on that address but does not identify itself as this {app} data directory.\n\nSet daemon.listen.port (and app.listen.port) to free ports in {config}, then {reopen}.',
      silent: 'The {app} daemon does not answer.',
      silentDetail:
        'Expected at {origin}, supervised by {supervisor}; nothing answered within {seconds} s. It may still be starting (a first launch after an update checks the installation and the providers), or it may have failed: {reopen}, and if it stays silent, read its log.\n\n{logHint} Your data has been preserved.',
      logSupervisor: 'Check the daemon supervisor configured for this installation.',
      logFile: 'Inspect its log in {path}.',
      logMissingWindows:
        'It has not written a log yet: check that the {task} task exists and is enabled in Task Scheduler.',
      logMissingMac:
        'It has not written a log yet: check that the {service} service is loaded (launchctl list).',
      logJournal: 'Inspect its logs with journalctl --user -u {unit}.',
      upgradeFailed: 'The background service could not be updated to version {version}.',
      upgradeFallbackDetail:
        'Timon runs its built-in daemon for this session and will try again at the next launch. Your agents, missions and projects in {home} were not modified.\n\n{reason}',
      upgradeKeptDetail:
        'Timon keeps using the background service it already had and will try again at the next launch. Your agents, missions and projects in {home} were not modified.\n\n{reason}',
    },
  },
};

const LAST_RESORT = [{ tag: SOURCE_LOCALE, dictionary: STARTUP_ENGLISH }];

export type StartupText = (key: string, vars?: MessageVars) => string;

/** `t('startup.<key>', vars)` in `locale`, English from the files, then the built-in English. */
export function startupText(locale: string | null | undefined): StartupText {
  const t = shellText(locale);
  return (key, vars) => {
    const text = t(key, vars);
    return text !== key ? text : translate(LAST_RESORT, `desktop.${key}`, vars) ?? key;
  };
}
