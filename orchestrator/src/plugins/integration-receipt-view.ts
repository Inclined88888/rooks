/**
 * What a messaging receipt shows whoever diagnoses it. Shared by the receipt
 * routes and the plugin facade so the masking policy exists once.
 */
import { z } from 'zod';
import { redactDeep, redactNullable } from '../secrets/redact.js';
import type { IntegrationReceipt, TroubledReceipt } from './integration-store.js';
import type { PluginIntegrationReceipt } from './integration-types.js';

const PREVIEW_CHARS = 200;
export const RECEIPT_STATUSES = ['failed', 'retrying'] as const;
export const RECEIPT_LIST_LIMIT = { max: 200, default: 50 } as const;

/** `ctx.connections.receipts` options: plugin input, so no coercion and no unknown key. */
export const receiptListOptions = z.object({
  status: z.enum(RECEIPT_STATUSES).optional(),
  limit: z.number().int().min(1).max(RECEIPT_LIST_LIMIT.max).default(RECEIPT_LIST_LIMIT.default),
}).strict();

function preview(row: IntegrationReceipt): string {
  try {
    const text = (JSON.parse(row.message) as { text?: unknown }).text;
    return typeof text === 'string' ? String(redactDeep(text)).slice(0, PREVIEW_CHARS) : '';
  } catch { return ''; }
}
export function receiptView(row: TroubledReceipt): PluginIntegrationReceipt {
  return {
    id: row.id,
    externalId: String(redactDeep(row.external_id)),
    stage: row.stage,
    status: row.failed_at > 0 ? 'failed' : 'retrying',
    attempts: row.attempts,
    // Scrubbed when written, but a value entered in the vault since was not known then.
    lastError: redactNullable(row.last_error),
    missionId: row.mission_id,
    preview: preview(row),
    createdAt: row.created_at,
    nextAt: row.failed_at > 0 ? null : row.next_at,
    failedAt: row.failed_at > 0 ? row.failed_at : null,
  };
}
