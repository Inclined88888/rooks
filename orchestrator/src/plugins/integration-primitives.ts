import type { PluginIntegrationSchema, PluginJsonValue } from './integration-types.js';

export class PluginIntegrationError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'unloaded' | 'timeout' | 'aborted', message: string) {
    super(message);
    this.name = 'PluginIntegrationError';
  }
}

export function integrationId(pluginId: string, name: string, version: number): string {
  if (typeof pluginId !== 'string' || !/^[a-z0-9-]{3,40}$/.test(pluginId)) throw new PluginIntegrationError('invalid', 'Invalid plugin id');
  if (typeof name !== 'string' || name.length > 80 || !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test(name)) {
    throw new PluginIntegrationError('invalid', 'Invalid integration name');
  }
  if (!Number.isSafeInteger(version) || version < 1) throw new PluginIntegrationError('invalid', 'Invalid integration version');
  return `${pluginId}:${name}@${version}`;
}

export function parseIntegrationId(value: string): { pluginId: string; name: string; version: number } | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^([^:]+):([^@]+)@([1-9][0-9]*)$/.exec(value);
  if (!match) return undefined;
  const [, pluginId, name, rawVersion] = match;
  const version = Number(rawVersion);
  try {
    if (integrationId(pluginId!, name!, version) !== value) return undefined;
    return { pluginId: pluginId!, name: name!, version };
  } catch { return undefined; }
}

export function integrationTimeout(value = 30_000): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new PluginIntegrationError('invalid', 'Integration timeout must be between 1 and 300000 ms');
  }
  return value;
}

/** Strict, detached JSON snapshot. Never invoke a getter or a toJSON method. */
export function integrationJson(value: unknown): PluginJsonValue {
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const invalid = () => new PluginIntegrationError('invalid', 'Expected JSON within 256 KiB, 32 levels and 10000 values');
  const countString = (text: string) => {
    if (text.length > 256 * 1024) throw invalid();
    bytes += Buffer.byteLength(JSON.stringify(text));
  };
  function visit(input: unknown, depth: number): PluginJsonValue {
    if (++nodes > 10_000 || depth > 32) throw invalid();
    let output: PluginJsonValue;
    if (input === null || typeof input === 'boolean') { bytes += String(input).length; output = input; }
    else if (typeof input === 'number' && Number.isFinite(input)) { bytes += String(input).length; output = input; }
    else if (typeof input === 'string') { countString(input); output = input; }
    else if (typeof input === 'object' && input !== null) {
      if (ancestors.has(input)) throw invalid();
      const array = Array.isArray(input);
      if (!array && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw invalid();
      ancestors.add(input);
      const keys = Reflect.ownKeys(input);
      if (keys.length > 10_001 || (array && keys.length !== input.length + 1)) throw invalid();
      const entries: [string, PluginJsonValue][] = [];
      bytes += 2;
      for (const key of keys) {
        if (array && key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
        if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length)) throw invalid();
        if (!array) countString(key);
        bytes += (entries.length > 0 ? 1 : 0) + (array ? 0 : 1);
        entries.push([key, visit(descriptor.value, depth + 1)]);
      }
      ancestors.delete(input);
      output = array ? entries.map(([, item]) => item) : Object.fromEntries(entries);
    } else throw invalid();
    if (bytes > 256 * 1024) throw invalid();
    return output;
  }
  return visit(value, 0);
}

/** Validate both sides: parsers must not smuggle non-persistable values out. */
export function parseIntegrationValue(schema: PluginIntegrationSchema, value: unknown): PluginJsonValue {
  return integrationJson(schema.parse(integrationJson(value)));
}

/**
 * Bounds an async call, even when it ignores cancellation. Abort is cooperative:
 * no in-process primitive can interrupt synchronous JS or undo external effects.
 * A late result can own a resource (trigger setup); onLateResult releases it.
 */
export function callIntegration<T>(
  operation: (signal: AbortSignal) => T | Promise<T>,
  options: { timeoutMs?: number; signals?: readonly AbortSignal[]; onLateResult?: (value: T) => void | Promise<void>; onCleanupError?: (error: unknown) => void } = {},
): Promise<T> {
  const timeoutMs = integrationTimeout(options.timeoutMs);
  const controller = new AbortController();
  const signals = options.signals ?? [];
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listeners: Array<() => void> = [];
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      for (const remove of listeners) remove();
    };
    const cancel = (reason: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason);
      controller.abort(reason);
    };
    for (const signal of signals) {
      const abort = () => cancel(signal.reason ?? new PluginIntegrationError('aborted', 'Integration call aborted'));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      listeners.push(() => signal.removeEventListener('abort', abort));
    }
    timer = setTimeout(() => cancel(new PluginIntegrationError('timeout', 'Integration call timed out')), timeoutMs);
    // The microtask also catches synchronous throws. Recheck cancellation before invoking.
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return operation(controller.signal);
    }).then((value) => {
      if (settled) {
        if (options.onLateResult) {
          void Promise.resolve().then(() => options.onLateResult!(value)).catch((error: unknown) => {
            try {
              if (options.onCleanupError) options.onCleanupError(error);
              else console.error('[plugins] late integration cleanup failed', error);
            } catch (reportError) {
              console.error('[plugins] integration cleanup reporter failed', reportError);
            }
          });
        }
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}
