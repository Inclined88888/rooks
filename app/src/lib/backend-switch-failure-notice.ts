/**
 * The sentence rendered in the thread when a backend switch never started its
 * turn (persisted `backend_switch_failed` event, orchestrator/src/agent.ts).
 *
 * Pure, like `spawn-failure-notice.ts`: it takes the place of the card that
 * would have announced a context nobody received, and says where the
 * conversation stayed.
 */
import { t } from './i18n';

/** Payload of the `backend_switch_failed` event. */
export type BackendSwitchFailedPayload = {
  backend?: unknown;
  previous_backend?: unknown;
  model?: unknown;
  reason?: unknown;
};

const REASON_CHARS = 400;

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function backendSwitchFailureNotice(payload: BackendSwitchFailedPayload): string {
  const backend = text(payload.backend) || '?';
  const model = text(payload.model);
  const raw = text(payload.reason).replace(/\.$/, '');
  return t('chatPage.backendSwitchFailed', {
    from: text(payload.previous_backend) || '?',
    target: model ? `${backend} · ${model}` : backend,
    reason: raw.length > REASON_CHARS ? `${raw.slice(0, REASON_CHARS)}…` : raw || '?',
  });
}
