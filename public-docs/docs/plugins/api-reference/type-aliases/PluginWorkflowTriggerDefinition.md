
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginWorkflowTriggerDefinition

> **PluginWorkflowTriggerDefinition** = [`PluginIntegrationDefinition`](PluginIntegrationDefinition.md) & `object`

## Type Declaration

### configSchema

> **configSchema**: [`PluginIntegrationSchema`](PluginIntegrationSchema.md)

### timeoutMs?

> `optional` **timeoutMs?**: `number`

### start()

> **start**(`context`): [`PluginIntegrationDisposer`](PluginIntegrationDisposer.md) \| `Promise`\<[`PluginIntegrationDisposer`](PluginIntegrationDisposer.md)\>

#### Parameters

##### context

[`PluginWorkflowTriggerContext`](PluginWorkflowTriggerContext.md)

#### Returns

[`PluginIntegrationDisposer`](PluginIntegrationDisposer.md) \| `Promise`\<[`PluginIntegrationDisposer`](PluginIntegrationDisposer.md)\>
