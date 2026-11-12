import { integrationRegistries, grantIntegrationPermissions, integrationRequestIdentity } from './integration-host.js';
import { integrationService } from './integration-runtime.js';
import { PluginIntegrationScope } from './integration-registry.js';
import { viewerAllows } from '../users/surfaces.js';
import { userConnectionService } from './user-connections.js';
import type { PluginPermission } from './manifest.js';
import type {
  PluginBusinessEventDefinition, PluginBusinessEventInput, PluginConnectionInput, PluginConnectionPatch, PluginConnectionTypeDefinition, PluginUserConnection,
  PluginConnectionReceipts, PluginMessagingConnection, PluginTransportDefinition, PluginWorkflowExecutorDefinition, PluginWorkflowTriggerDefinition,
} from './integration-types.js';

/** Internal binding owned by one plugin load; never returned to the plugin. */
export type PluginIntegrationSession = {
  dispose(): void;
  registerEvent(definition: PluginBusinessEventDefinition): () => void;
  publishEvent(owner: string, type: string, input: PluginBusinessEventInput, connectionId?: string): Promise<string[]>;
  registerTrigger(definition: PluginWorkflowTriggerDefinition): () => void;
  registerExecutor(definition: PluginWorkflowExecutorDefinition): () => void;
  registerTransport(definition: PluginTransportDefinition): () => void;
  createConnection(owner: string, input: PluginConnectionInput): Promise<PluginMessagingConnection>;
  getConnection(owner: string, id: string): PluginMessagingConnection | undefined;
  listConnections(owner: string): PluginMessagingConnection[];
  connectionReceipts(owner: string, id: string, options: unknown): PluginConnectionReceipts;
  updateConnection(owner: string, id: string, patch: PluginConnectionPatch): Promise<PluginMessagingConnection>;
  registerConnectionType(definition: PluginConnectionTypeDefinition): () => void;
  listUserConnections(owner: string): PluginUserConnection[];
  userConnectionSecret(owner: string, id: string, name: string): string | undefined;
};

export function openIntegrationSession(pluginId: string, permissions: readonly PluginPermission[]): PluginIntegrationSession {
  const revoke = grantIntegrationPermissions(pluginId, permissions);
  const scope = new PluginIntegrationScope(pluginId);
  const grants = new Set(permissions);
  let disposed = false;
  const assert = (permission: PluginPermission) => {
    if (disposed) throw new Error('Plugin integration session was unloaded');
    if (!grants.has(permission)) throw new Error(`Plugin ${pluginId} lacks ${permission}`);
  };
  return {
    dispose() { if (disposed) return; disposed = true; revoke(); scope.dispose(); },
    registerEvent(definition) { assert('events:register'); return scope.register(integrationRegistries.events, definition).dispose; },
    async publishEvent(owner, type, input, connectionId) {
      assert('events:publish'); integrationRequestIdentity(pluginId, owner);
      const connection = connectionId === undefined ? undefined : integrationService().get(pluginId, owner, connectionId);
      if (connectionId !== undefined && !connection?.enabled) throw new Error('Connection unavailable for this owner');
      const { publishPluginBusinessEvent } = await import('../workflows/plugin-triggers.js');
      const authorize = () => {
        assert('events:publish');
        const identity = integrationRequestIdentity(pluginId, owner);
        if (owner !== `plugin:${pluginId}` && !viewerAllows(identity.viewer, 'events:publish')) throw new Error('Owner lacks events:publish');
        if (connectionId !== undefined && !integrationService().get(pluginId, owner, connectionId)?.enabled) throw new Error('Connection unavailable for this owner');
      };
      return publishPluginBusinessEvent(pluginId, type, owner, input, connectionId, authorize);
    },
    registerTrigger(definition) { assert('workflows:triggers:register'); return scope.register(integrationRegistries.triggers, definition).dispose; },
    registerExecutor(definition) { assert('workflows:executors:register'); return scope.register(integrationRegistries.executors, definition).dispose; },
    registerTransport(definition) { assert('transports:register'); return scope.register(integrationRegistries.transports, definition).dispose; },
    async createConnection(owner, input) { assert('connections:write'); return integrationService().create(pluginId, owner, input); },
    getConnection(owner, id) { assert('connections:read'); return integrationService().get(pluginId, owner, id); },
    listConnections(owner) { assert('connections:read'); return integrationService().list(pluginId, owner); },
    connectionReceipts(owner, id, options) { assert('connections:read'); return integrationService().receipts(pluginId, owner, id, options); },
    async updateConnection(owner, id, patch) { assert('connections:write'); return integrationService().update(pluginId, owner, id, patch); },
    registerConnectionType(definition) { assert('connections:register'); return scope.register(integrationRegistries.connectionTypes, definition).dispose; },
    listUserConnections(owner) { assert('connections:users:read'); return userConnectionService().forUser(pluginId, owner); },
    userConnectionSecret(owner, id, name) { assert('connections:users:read'); return userConnectionService().secret(pluginId, owner, id, name); },
  };
}
