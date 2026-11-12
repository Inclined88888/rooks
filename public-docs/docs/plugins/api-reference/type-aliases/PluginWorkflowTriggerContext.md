
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginWorkflowTriggerContext

> **PluginWorkflowTriggerContext** = [`PluginIntegrationCallContext`](PluginIntegrationCallContext.md) & `object`

## Type Declaration

### config

> `readonly` **config**: [`PluginJsonValue`](PluginJsonValue.md)

### nodeId

> `readonly` **nodeId**: `string`

### workflowId

> `readonly` **workflowId**: `string`

### emit()

> **emit**(`event`): `Promise`\<`void`\>

#### Parameters

##### event

[`PluginBusinessEventInput`](PluginBusinessEventInput.md)

#### Returns

`Promise`\<`void`\>
