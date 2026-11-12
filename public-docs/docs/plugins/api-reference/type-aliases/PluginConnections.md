
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginConnections

> **PluginConnections** = `object`

## Methods

### create()

> **create**(`input`): `Promise`\<[`PluginMessagingConnection`](PluginMessagingConnection.md)\>

#### Parameters

##### input

[`PluginConnectionInput`](PluginConnectionInput.md)

#### Returns

`Promise`\<[`PluginMessagingConnection`](PluginMessagingConnection.md)\>

***

### forUser()

> **forUser**(`ownerUserId`): `Promise`\<[`PluginUserConnection`](PluginUserConnection.md)[]\>

#### Parameters

##### ownerUserId

`string`

#### Returns

`Promise`\<[`PluginUserConnection`](PluginUserConnection.md)[]\>

***

### get()

> **get**(`id`): `Promise`\<[`PluginMessagingConnection`](PluginMessagingConnection.md) \| `undefined`\>

#### Parameters

##### id

`string`

#### Returns

`Promise`\<[`PluginMessagingConnection`](PluginMessagingConnection.md) \| `undefined`\>

***

### inboundPath()

> **inboundPath**(`id`): `Promise`\<`string`\>

#### Parameters

##### id

`string`

#### Returns

`Promise`\<`string`\>

***

### list()

> **list**(): `Promise`\<[`PluginMessagingConnection`](PluginMessagingConnection.md)[]\>

#### Returns

`Promise`\<[`PluginMessagingConnection`](PluginMessagingConnection.md)[]\>

***

### receipts()

> **receipts**(`connectionId`, `options?`): `Promise`\<[`PluginConnectionReceipts`](PluginConnectionReceipts.md)\>

#### Parameters

##### connectionId

`string`

##### options?

[`PluginConnectionReceiptsOptions`](PluginConnectionReceiptsOptions.md)

#### Returns

`Promise`\<[`PluginConnectionReceipts`](PluginConnectionReceipts.md)\>

***

### registerType()

> **registerType**(`definition`): () => `void`

#### Parameters

##### definition

[`PluginConnectionTypeDefinition`](PluginConnectionTypeDefinition.md)

#### Returns

() => `void`

***

### update()

> **update**(`id`, `patch`): `Promise`\<[`PluginMessagingConnection`](PluginMessagingConnection.md)\>

#### Parameters

##### id

`string`

##### patch

[`PluginConnectionPatch`](PluginConnectionPatch.md)

#### Returns

`Promise`\<[`PluginMessagingConnection`](PluginMessagingConnection.md)\>

***

### userSecret()

> **userSecret**(`ownerUserId`, `connectionId`, `name`): `Promise`\<`string` \| `undefined`\>

#### Parameters

##### ownerUserId

`string`

##### connectionId

`string`

##### name

`string`

#### Returns

`Promise`\<`string` \| `undefined`\>
