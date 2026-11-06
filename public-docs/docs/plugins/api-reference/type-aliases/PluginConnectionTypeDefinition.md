
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginConnectionTypeDefinition

> **PluginConnectionTypeDefinition** = [`PluginIntegrationDefinition`](PluginIntegrationDefinition.md) & `object`

## Type Declaration

### configSchema

> **configSchema**: [`PluginIntegrationSchema`](PluginIntegrationSchema.md)

### description?

> `optional` **description?**: `string`

### fields?

> `optional` **fields?**: readonly [`PluginConnectionField`](PluginConnectionField.md)[]

### label

> **label**: `string`

### secrets?

> `optional` **secrets?**: readonly [`PluginConnectionSecretField`](PluginConnectionSecretField.md)[]

### timeoutMs?

> `optional` **timeoutMs?**: `number`

### test()?

> `optional` **test**(`context`): [`PluginConnectionTestResult`](PluginConnectionTestResult.md) \| `Promise`\<[`PluginConnectionTestResult`](PluginConnectionTestResult.md)\>

#### Parameters

##### context

[`PluginConnectionTestContext`](PluginConnectionTestContext.md)

#### Returns

[`PluginConnectionTestResult`](PluginConnectionTestResult.md) \| `Promise`\<[`PluginConnectionTestResult`](PluginConnectionTestResult.md)\>
