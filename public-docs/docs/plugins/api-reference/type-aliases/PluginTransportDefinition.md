
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginTransportDefinition

> **PluginTransportDefinition** = [`PluginIntegrationDefinition`](PluginIntegrationDefinition.md) & `object`

## Type Declaration

### configSchema

> **configSchema**: [`PluginIntegrationSchema`](PluginIntegrationSchema.md)

### timeoutMs?

> `optional` **timeoutMs?**: `number`

### receive()

> **receive**(`context`, `request`): [`PluginInboundMessage`](PluginInboundMessage.md) \| `Promise`\<[`PluginInboundMessage`](PluginInboundMessage.md) \| `null`\> \| `null`

#### Parameters

##### context

[`PluginTransportContext`](PluginTransportContext.md)

##### request

[`PluginTransportRequest`](PluginTransportRequest.md)

#### Returns

[`PluginInboundMessage`](PluginInboundMessage.md) \| `Promise`\<[`PluginInboundMessage`](PluginInboundMessage.md) \| `null`\> \| `null`

### send()

> **send**(`context`, `reply`): [`PluginTransportDelivery`](PluginTransportDelivery.md) \| `Promise`\<[`PluginTransportDelivery`](PluginTransportDelivery.md)\>

#### Parameters

##### context

[`PluginTransportContext`](PluginTransportContext.md)

##### reply

[`PluginTransportReply`](PluginTransportReply.md)

#### Returns

[`PluginTransportDelivery`](PluginTransportDelivery.md) \| `Promise`\<[`PluginTransportDelivery`](PluginTransportDelivery.md)\>
