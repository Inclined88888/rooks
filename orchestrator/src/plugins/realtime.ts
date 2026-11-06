import { z } from 'zod';
import { bus } from '../bus.js';
import { redactDeep } from '../secrets/redact.js';

import type { PluginRealtimeOptions } from './contract/realtime.js';
export type { PluginRealtimeOptions, PluginRealtime } from './contract/realtime.js';

const envelopeSchema = z.object({
  // Bundled ids also use scoped module names; neither form permits SSE framing.
  pluginId: z.string().regex(/^(?:[a-z0-9-]{3,40}|@timon\/[a-z0-9][a-z0-9-]*)$/),
  topic: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  options: z.object({ ownerUserId: z.string().min(1).refine((id) => id.trim().length > 0) }),
});
const MAX_PAYLOAD_BYTES = 16 * 1024;

/** One transport for bundled and third-party plugins, addressed to one account. */
export function publishPluginRealtime(
  pluginId: string,
  topic: string,
  payload: unknown,
  options: PluginRealtimeOptions,
): void {
  const validated = envelopeSchema.parse({ pluginId, topic, options });
  let serialized: string;
  try {
    serialized = JSON.stringify(payload, (_key, value: unknown) => {
      if (typeof value === 'undefined' || typeof value === 'function'
        || typeof value === 'symbol' || typeof value === 'bigint'
        || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new Error('Non-JSON value');
      }
      return value;
    });
  } catch {
    throw new Error('Plugin realtime payload must be JSON-serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error('Plugin realtime payload exceeds 16 KiB');
  }
  // Normalize before masking so toJSON cannot reveal a secret after redaction.
  const redacted: unknown = redactDeep(JSON.parse(serialized));
  bus.publish({
    kind: 'plugin_realtime',
    pluginId: validated.pluginId,
    topic: validated.topic,
    ownerUserId: validated.options.ownerUserId,
    payload: redacted,
  });
}
