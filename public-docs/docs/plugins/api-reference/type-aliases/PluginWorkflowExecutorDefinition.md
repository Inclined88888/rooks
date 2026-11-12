
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginWorkflowExecutorDefinition

> **PluginWorkflowExecutorDefinition** = [`PluginIntegrationDefinition`](PluginIntegrationDefinition.md) & `object`

## Type Declaration

### configSchema

> **configSchema**: [`PluginIntegrationSchema`](PluginIntegrationSchema.md)

### outputPorts

> **outputPorts**: readonly `string`[]

### timeoutMs?

> `optional` **timeoutMs?**: `number`

### execute()

> **execute**(`context`): [`PluginWorkflowExecutorResult`](PluginWorkflowExecutorResult.md) \| `Promise`\<[`PluginWorkflowExecutorResult`](PluginWorkflowExecutorResult.md)\>

#### Parameters

##### context

[`PluginWorkflowExecutorContext`](PluginWorkflowExecutorContext.md)

#### Returns

[`PluginWorkflowExecutorResult`](PluginWorkflowExecutorResult.md) \| `Promise`\<[`PluginWorkflowExecutorResult`](PluginWorkflowExecutorResult.md)\>
