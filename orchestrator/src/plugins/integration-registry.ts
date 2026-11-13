import { callIntegration, integrationId, integrationTimeout, PluginIntegrationError } from './integration-primitives.js';
import type {
  PluginBusinessEventDefinition, PluginConnectionField, PluginConnectionSecretField, PluginConnectionTypeDefinition, PluginIntegrationDefinition, PluginIntegrationSchema,
  PluginTransportDefinition, PluginWorkflowExecutorDefinition, PluginWorkflowTriggerDefinition,
} from './integration-types.js';

function schemaSnapshot(schema: PluginIntegrationSchema): PluginIntegrationSchema {
  if (!schema || typeof schema.parse !== 'function') throw new PluginIntegrationError('invalid', 'A parse function is required');
  return Object.freeze({ parse: schema.parse.bind(schema) });
}

function requireFunction(value: unknown, name: string): void {
  if (typeof value !== 'function') throw new PluginIntegrationError('invalid', `${name} must be a function`);
}

/** Host-only lease. Plugins will receive a disposer through the permission facade. */
export type IntegrationRegistration<T> = {
  readonly id: string;
  readonly pluginId: string;
  readonly definition: Readonly<T>;
  readonly signal: AbortSignal;
  invoke<R>(operation: (definition: Readonly<T>, signal: AbortSignal) => R | Promise<R>, options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    onLateResult?: (value: R) => void | Promise<void>;
    onCleanupError?: (error: unknown) => void;
  }): Promise<R>;
  dispose(): void;
};

/** Each instance is a separate capability; an event cannot replace an executor. */
export class IntegrationRegistry<T extends PluginIntegrationDefinition> {
  readonly #entries = new Map<string, IntegrationRegistration<T>>();
  readonly #listeners = new Set<() => void>();

  constructor(private readonly normalize: (definition: T) => T) {}

  register(pluginId: string, definition: T): IntegrationRegistration<T> {
    if (!definition || typeof definition !== 'object') throw new PluginIntegrationError('invalid', 'Integration definition is required');
    const id = integrationId(pluginId, definition.name, definition.version);
    if (this.#entries.has(id)) throw new PluginIntegrationError('conflict', `Integration ${id} is already registered`);
    const snapshot = Object.freeze(this.normalize(definition));
    const controller = new AbortController();
    const defaultTimeout = integrationTimeout('timeoutMs' in snapshot ? snapshot.timeoutMs as number | undefined : undefined);
    const registration: IntegrationRegistration<T> = Object.freeze({
      id, pluginId, definition: snapshot, signal: controller.signal,
      invoke: <R>(operation: (definition: Readonly<T>, signal: AbortSignal) => R | Promise<R>, options: {
        signal?: AbortSignal; timeoutMs?: number; onLateResult?: (value: R) => void | Promise<void>; onCleanupError?: (error: unknown) => void;
      } = {}) => callIntegration((signal) => operation(snapshot, signal), {
        timeoutMs: options.timeoutMs === undefined ? defaultTimeout : Math.min(defaultTimeout, integrationTimeout(options.timeoutMs)),
        signals: options.signal ? [controller.signal, options.signal] : [controller.signal],
        onLateResult: options.onLateResult,
        onCleanupError: options.onCleanupError,
      }),
      dispose: () => {
        // A disposer retained across reloads must never remove the replacement.
        if (this.#entries.get(id) !== registration) return;
        this.#entries.delete(id);
        controller.abort(new PluginIntegrationError('unloaded', `Integration ${id} was unloaded`));
        this.changed();
      },
    });
    this.#entries.set(id, registration);
    this.changed();
    return registration;
  }

  get(id: string): IntegrationRegistration<T> | undefined { return this.#entries.get(id); }
  list(): readonly IntegrationRegistration<T>[] { return [...this.#entries.values()]; }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  private changed(): void {
    for (const listener of this.#listeners) {
      try { listener(); }
      catch (error) { console.error('[plugins] integration registry listener failed', error); }
    }
  }
}

/** One scope per load generation. Bind dispose to the plugin's Cordis effect. */
export class PluginIntegrationScope {
  readonly #resources = new Set<() => void>();
  #disposed = false;

  constructor(readonly pluginId: string) {
    integrationId(pluginId, 'scope', 1);
  }

  register<T extends PluginIntegrationDefinition>(registry: IntegrationRegistry<T>, definition: T): IntegrationRegistration<T> {
    if (this.#disposed) throw new PluginIntegrationError('unloaded', `Plugin ${this.pluginId} was unloaded`);
    const registration = registry.register(this.pluginId, definition);
    const dispose = () => {
      this.#resources.delete(dispose);
      registration.dispose();
    };
    this.#resources.add(dispose);
    return Object.freeze({ ...registration, dispose });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const dispose of [...this.#resources].reverse()) dispose();
  }
}

/** Instantiated by the host in S2/S3. Importing the SDK does not create global state. */
export function createIntegrationRegistries() {
  return {
    events: new IntegrationRegistry<PluginBusinessEventDefinition>((definition) => ({
      name: definition.name, version: definition.version, payloadSchema: schemaSnapshot(definition.payloadSchema),
    })),
    triggers: new IntegrationRegistry<PluginWorkflowTriggerDefinition>((definition) => {
      requireFunction(definition.start, 'start');
      return {
        name: definition.name, version: definition.version, configSchema: schemaSnapshot(definition.configSchema),
        timeoutMs: integrationTimeout(definition.timeoutMs), start: definition.start.bind(definition),
      };
    }),
    executors: new IntegrationRegistry<PluginWorkflowExecutorDefinition>((definition) => {
      requireFunction(definition.execute, 'execute');
      const ports = definition.outputPorts;
      if (!Array.isArray(ports) || ports.length < 1 || ports.length > 32 || new Set(ports).size !== ports.length
        || ports.some((port) => typeof port !== 'string' || port.length > 80 || !/^[a-z][a-z0-9-]*$/.test(port))) {
        throw new PluginIntegrationError('invalid', 'Executor requires 1 to 32 distinct named output ports');
      }
      return {
        name: definition.name, version: definition.version, configSchema: schemaSnapshot(definition.configSchema),
        timeoutMs: integrationTimeout(definition.timeoutMs), outputPorts: Object.freeze([...ports]),
        execute: definition.execute.bind(definition),
      };
    }),
    transports: new IntegrationRegistry<PluginTransportDefinition>((definition) => {
      requireFunction(definition.receive, 'receive');
      requireFunction(definition.send, 'send');
      return {
        name: definition.name, version: definition.version, configSchema: schemaSnapshot(definition.configSchema),
        timeoutMs: integrationTimeout(definition.timeoutMs),
        receive: definition.receive.bind(definition), send: definition.send.bind(definition),
      };
    }),
    connectionTypes: new IntegrationRegistry<PluginConnectionTypeDefinition>(normalizeConnectionType),
  };
}

const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
function text(value: unknown, max: number, name: string, optional = false): string | undefined {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new PluginIntegrationError('invalid', `${name} must be a non-empty string of at most ${max} characters`);
  return value;
}
function fieldList<T extends { required?: boolean }>(value: unknown, key: 'key' | 'name', max: number): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new PluginIntegrationError('invalid', `At most ${max} connection fields`);
  const seen = new Set<string>();
  return value.map((entry: Record<string, unknown>) => {
    const id = entry?.[key];
    if (typeof id !== 'string' || !FIELD_KEY.test(id) || seen.has(id)) throw new PluginIntegrationError('invalid', 'Invalid or duplicate connection field');
    seen.add(id);
    if (entry.required !== undefined && typeof entry.required !== 'boolean') throw new PluginIntegrationError('invalid', 'Invalid required flag');
    return Object.freeze({
      [key]: id, label: text(entry.label, 80, 'label'), required: entry.required === true,
      ...(key === 'key' && entry.placeholder !== undefined ? { placeholder: text(entry.placeholder, 200, 'placeholder') } : {}),
    }) as unknown as T;
  });
}
function normalizeConnectionType(definition: PluginConnectionTypeDefinition): PluginConnectionTypeDefinition {
  if (definition.test !== undefined) requireFunction(definition.test, 'test');
  return {
    name: definition.name, version: definition.version, configSchema: schemaSnapshot(definition.configSchema),
    label: text(definition.label, 80, 'label')!, description: text(definition.description, 500, 'description', true),
    fields: Object.freeze(fieldList<PluginConnectionField>(definition.fields, 'key', 16)),
    secrets: Object.freeze(fieldList<PluginConnectionSecretField>(definition.secrets, 'name', 8)),
    timeoutMs: integrationTimeout(definition.timeoutMs),
    ...(definition.test ? { test: definition.test.bind(definition) } : {}),
  };
}
