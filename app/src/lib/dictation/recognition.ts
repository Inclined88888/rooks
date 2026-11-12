import { useSyncExternalStore } from 'react';

import { desktopBridge } from '@/lib/desktop';
import { getLocale, t, type Locale } from '@/lib/i18n';
import { regionalTag } from '@/lib/intl';
import { pluginsSynced } from '@/lib/plugin-host/loader';
import { settingsPath } from '@/lib/settings-path';
import { webSpeechSansMoteur } from '@/lib/stt-dictee';

import { startMicrophoneCapture } from './audio-capture';
import { AUTO_CHOICE, dictationChoice, resetDictationChoice, subscribeDictationChoice, type DictationChoice } from './choice';
import { admitEngine, type ConsentRequest } from './consent';
import type { DictationAvailability } from './contract';
import { engineDestination, isProductEngine } from './destination';
import { EngineRecognition, type RecognitionLike } from './engine-recognition';
import { dictationEngine, dictationEngines, knownAvailability, subscribeDictationEngines } from './engines';
import { systemMicrophone } from './microphone';

/**
 * The dictation engine adapter: which recognizer a surface gets.
 *
 *  - a browser: Web Speech, as before; a registered engine when the browser
 *    has none;
 *  - the desktop app: Web Speech has no service behind it there (TIM-0061),
 *    so a registered engine (`dictation.engine`, TODO #484) — the desktop's
 *    own, `local`, comes first; greyed out when none can run (a desktop older
 *    than local dictation, an OS the engine does not ship for, an install
 *    without its addon);
 *  - the user's choice (Settings → Voice, TODO #492) above both: the chosen
 *    recognizer, or `unavailable-choice` when it cannot run — never another
 *    one, which could send the voice somewhere the user did not pick.
 */
export type EngineRoute = `engine:${string}`;
export type DictationRoute = 'web-speech' | EngineRoute | 'unavailable-desktop' | 'unavailable-browser' | 'unavailable-choice';

export type RouteEnv = {
  userAgent: string;
  desktopBridge: boolean;
  /**
   * Registered engines, in order; `availability` null while unknown.
   * `pluginId` is what a chosen engine is matched on with its id.
   */
  engines: ReadonlyArray<{ id: string; pluginId?: string; availability: DictationAvailability['state'] | null }>;
  webSpeech: boolean;
  /** Absent = `auto`. */
  choice?: DictationChoice;
};

/** Web Speech with a service behind it: not the desktop's (TIM-0061). */
function webSpeechUsable(env: RouteEnv): boolean {
  return env.webSpeech && !webSpeechSansMoteur(env);
}

export function dictationRoute(env: RouteEnv): DictationRoute {
  const choice = env.choice ?? AUTO_CHOICE;
  if (choice.kind === 'web-speech') return webSpeechUsable(env) ? 'web-speech' : 'unavailable-choice';
  if (choice.kind === 'engine') {
    const chosen = env.engines.find((engine) => engine.id === choice.engineId && engine.pluginId === choice.pluginId);
    // Unknown availability counts as usable here too: the start answers it.
    return chosen && chosen.availability !== 'unavailable' ? `engine:${chosen.id}` : 'unavailable-choice';
  }
  // Unknown yet counts as usable: the first click must not be refused for a
  // state still in flight; the engine answers the start itself.
  const usable = env.engines.find((engine) => engine.availability !== 'unavailable');
  const engineRoute: EngineRoute | null = usable ? `engine:${usable.id}` : null;
  if (webSpeechSansMoteur(env)) return engineRoute ?? 'unavailable-desktop';
  if (env.webSpeech) return 'web-speech';
  return engineRoute ?? 'unavailable-browser';
}

/** The engine id of an engine route, else null. */
export function routeEngineId(route: DictationRoute): string | null {
  return route.startsWith('engine:') ? route.slice('engine:'.length) : null;
}

type SpeechRecognitionCtor = new () => RecognitionLike;

function webSpeechCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function currentDictationRoute(): DictationRoute {
  if (typeof window === 'undefined') return 'web-speech';
  return dictationRoute({
    userAgent: navigator.userAgent,
    desktopBridge: desktopBridge() !== null,
    engines: dictationEngines().map(({ pluginId, engine }) => ({ id: engine.id, pluginId, availability: knownAvailability(engine)?.state ?? null })),
    webSpeech: webSpeechCtor() !== null,
    choice: dictationChoice(),
  });
}

/** Whether this window can offer Web Speech as a choice. */
export function webSpeechOffered(): boolean {
  if (typeof window === 'undefined') return false;
  return webSpeechUsable({ userAgent: navigator.userAgent, desktopBridge: desktopBridge() !== null, engines: [], webSpeech: webSpeechCtor() !== null });
}

/** The name a choice is shown under. */
export function choiceLabel(choice: DictationChoice): string {
  switch (choice.kind) {
    case 'auto': return t('dictation.choice.auto');
    case 'web-speech': return t('dictation.choice.webSpeech');
    case 'engine': return choice.label;
  }
}

/**
 * A chosen engine whose plugin is gone for good: once the plugins are synced,
 * a third-party plugin that no longer declares the engine (uninstalled, or an
 * update that dropped it). One that still declares it but is not registered
 * (switched off, its permission taken back, its bundle failing) is only
 * unavailable: it may come back, and the choice waits for it. The product's
 * engines and Web Speech are never reset — they depend on this window, not
 * on an install.
 */
export function choiceGone(choice: DictationChoice, synced: boolean): boolean {
  if (choice.kind !== 'engine' || !synced || isProductEngine(choice.pluginId)) return false;
  return engineDestination(choice.pluginId, choice.engineId).kind === 'undeclared';
}

export type ChoiceFailure =
  /** The choice was reset to `auto`; this start does not happen, the next follows `auto`. */
  | { kind: 'reset'; label: string; message: string }
  | { kind: 'unavailable'; label: string; message: string };

/**
 * What a surface tells the user when the route is `unavailable-choice`, after
 * resetting a choice whose engine is gone. Nothing starts on that click
 * either way: a reset is said before `auto` ever hears a word.
 */
export function choiceFailure(synced: boolean = pluginsSynced()): ChoiceFailure {
  const choice = dictationChoice();
  const label = choiceLabel(choice);
  if (choiceGone(choice, synced)) {
    resetDictationChoice(label);
    return { kind: 'reset', label, message: t('dictation.choice.reset', { engine: label }) };
  }
  return { kind: 'unavailable', label, message: t('dictation.choice.unavailable', { engine: label, settingsPath: settingsPath('interface', 'voice') }) };
}

/**
 * A recognizer for the route, or null when the route has none (its engine went
 * away meanwhile). `present` shows the consent card: a component, which the
 * surface hands in so that `lib/` never imports from `components/`.
 */
export function createRecognition(
  route: DictationRoute,
  present: (request: ConsentRequest) => boolean,
): RecognitionLike | null {
  if (route === 'web-speech') {
    const Ctor = webSpeechCtor();
    return Ctor ? new Ctor() : null;
  }
  const id = routeEngineId(route);
  const registered = id ? dictationEngine(id) : null;
  if (!registered) return null;
  const { pluginId, engine } = registered;
  return new EngineRecognition({
    engine,
    capture: startMicrophoneCapture,
    microphone: systemMicrophone,
    // Read at each start: a consent given or withdrawn meanwhile, or a plugin
    // update that changed where the voice goes, applies to the next dictation.
    admit: () => admitEngine({ pluginId, engineId: engine.id, engineLabel: engine.label }, present),
  });
}

/**
 * The surface's `lang`, from the UI locale (it was `fr-FR` for everyone). Web
 * Speech takes it as is; an engine gets its subtag when it knows the language
 * (`engineLanguage`) — the desktop then picks the model that fits it.
 */
export function dictationLang(locale: Locale = getLocale()): string {
  return regionalTag(locale);
}

function subscribeRoute(listener: () => void): () => void {
  const offEngines = subscribeDictationEngines(listener);
  const offChoice = subscribeDictationChoice(listener);
  return () => { offEngines(); offChoice(); };
}

/** The route, repainted when engines register, leave, say what they can do, or the user chooses. */
export function useDictationRoute(): DictationRoute {
  return useSyncExternalStore(subscribeRoute, currentDictationRoute, () => 'web-speech');
}
