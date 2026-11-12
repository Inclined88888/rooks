/**
 * The OS's answer about the microphone, asked by the product before it opens
 * one — never by an engine (TODO #484 §3.4: the microphone stays with the
 * host). Only the desktop app can ask: `request` shows the macOS prompt
 * there. A browser asks through `getUserMedia` itself, so `unknown`.
 */

export type MicrophoneStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

const STATUSES: readonly string[] = ['granted', 'denied', 'restricted', 'not-determined', 'unknown'];

export async function systemMicrophone(request: boolean): Promise<MicrophoneStatus> {
  if (typeof window === 'undefined') return 'unknown';
  const speech: unknown = window.rooksDesktop?.speech;
  const ask = speech !== null && typeof speech === 'object' ? (speech as { microphone?: unknown }).microphone : undefined;
  if (typeof ask !== 'function') return 'unknown';
  try {
    const answer: unknown = await (ask as (request?: boolean) => Promise<unknown>)(request);
    const status = answer !== null && typeof answer === 'object' ? (answer as { status?: unknown }).status : undefined;
    return typeof status === 'string' && STATUSES.includes(status) ? status as MicrophoneStatus : 'unknown';
  } catch {
    return 'unknown';
  }
}
