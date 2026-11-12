import { t } from '@/lib/i18n';
import { settingsPath } from '@/lib/settings-path';

/**
 * Terminal failures of the desktop's local dictation engine. `not-allowed`
 * and `audio-capture` (a refused or missing microphone) are Web Speech's own
 * codes and keep their meaning; these are ours. `erreurDicteeFatale` and the
 * voice mode treat every one as final, so no surface relaunches into a
 * failure that will repeat (TIM-0061: "Listening…" stuck, nothing written).
 */
export const LOCAL_FATAL_ERRORS = [
  'engine-unavailable',
  'init-failed',
  'engine-crashed',
  /** The model is not downloaded and the consent card is now open. */
  'model-consent',
  /** The model is not downloaded and nothing could show the card. */
  'model-missing',
  /** The OS refuses the microphone to the app (macOS privacy, Windows privacy). */
  'microphone-denied',
  /** The microphone went away mid-capture. */
  'microphone-lost',
  /** Another surface took the engine (one session at a time). */
  'busy',
  /** The engine's consent card is now open (TODO #484 C3). */
  'engine-consent',
  /** The user did not allow this engine, or nothing could ask. */
  'engine-not-allowed',
  /** Its plugin does not say where the voice goes: never used. */
  'engine-undeclared',
] as const;
export type LocalFatalError = typeof LOCAL_FATAL_ERRORS[number];

export function isLocalDictationError(code: string): code is LocalFatalError {
  return (LOCAL_FATAL_ERRORS as readonly string[]).includes(code);
}

/** What to tell the user; null when the consent card already says it. */
export function localDictationErrorMessage(code: LocalFatalError): string | null {
  switch (code) {
    case 'model-consent':
    case 'engine-consent':
      return null;
    case 'engine-not-allowed':
      return t('dictation.errors.engineNotAllowed', { settingsPath: settingsPath('interface', 'voice') });
    case 'engine-undeclared':
      return t('dictation.errors.engineUndeclared');
    case 'model-missing':
      return t('dictation.errors.modelMissing', { settingsPath: settingsPath('interface', 'voice') });
    case 'microphone-denied':
      return t('dictation.errors.microphoneDenied');
    case 'microphone-lost':
      return t('dictation.errors.microphoneLost');
    case 'busy':
      return t('dictation.errors.busy');
    case 'engine-crashed':
      return t('dictation.errors.engineCrashed');
    case 'engine-unavailable':
      return t('dictation.errors.engineUnavailable');
    case 'init-failed':
      return t('dictation.errors.initFailed', { settingsPath: settingsPath('interface', 'voice') });
  }
}
