
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginSecrets

> **PluginSecrets** = `object`

## Methods

### get()

> **get**(`name`): `Promise`\<`string` \| `undefined`\>

#### Parameters

##### name

`string`

#### Returns

`Promise`\<`string` \| `undefined`\>

***

### grant()

> **grant**(`name`, `scope`): `Promise`\<[`PluginSecretInfo`](PluginSecretInfo.md)\>

#### Parameters

##### name

`string`

##### scope

`string`

#### Returns

`Promise`\<[`PluginSecretInfo`](PluginSecretInfo.md)\>

***

### httpCall()

> **httpCall**(`request`): `Promise`\<`BrokerHttpResult`\>

#### Parameters

##### request

[`PluginHttpCallInput`](PluginHttpCallInput.md)

#### Returns

`Promise`\<`BrokerHttpResult`\>

***

### list()

> **list**(): `Promise`\<[`PluginSecretInfo`](PluginSecretInfo.md)[]\>

#### Returns

`Promise`\<[`PluginSecretInfo`](PluginSecretInfo.md)[]\>

***

### revoke()

> **revoke**(`name`, `scope`): `Promise`\<[`PluginSecretInfo`](PluginSecretInfo.md)\>

#### Parameters

##### name

`string`

##### scope

`string`

#### Returns

`Promise`\<[`PluginSecretInfo`](PluginSecretInfo.md)\>

***

### set()

> **set**(`input`): `Promise`\<[`PluginSecretInfo`](PluginSecretInfo.md)\>

#### Parameters

##### input

[`PluginSecretInput`](PluginSecretInput.md)

#### Returns

`Promise`\<[`PluginSecretInfo`](PluginSecretInfo.md)\>
