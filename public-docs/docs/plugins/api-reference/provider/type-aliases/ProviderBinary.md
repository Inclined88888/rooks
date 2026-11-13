
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: ProviderBinary

> **ProviderBinary** = `object`

## Methods

### converse()

> **converse**(`name`, `args`, `options?`): `Promise`\<[`ProviderConversation`](ProviderConversation.md)\>

#### Parameters

##### name

`string`

##### args

readonly `string`[]

##### options?

[`ProviderConverseOptions`](ProviderConverseOptions.md)

#### Returns

`Promise`\<[`ProviderConversation`](ProviderConversation.md)\>

***

### probe()

> **probe**(`name`, `args`, `options?`): `Promise`\<[`ProviderProbeResult`](ProviderProbeResult.md)\>

#### Parameters

##### name

`string`

##### args

readonly `string`[]

##### options?

[`ProviderProbeOptions`](ProviderProbeOptions.md)

#### Returns

`Promise`\<[`ProviderProbeResult`](ProviderProbeResult.md)\>

***

### resolve()

> **resolve**(`name`): `Promise`\<`string` \| `null`\>

#### Parameters

##### name

`string`

#### Returns

`Promise`\<`string` \| `null`\>

***

### serve()

> **serve**(`name`, `args`, `options?`): `Promise`\<[`ProviderServer`](ProviderServer.md)\>

#### Parameters

##### name

`string`

##### args

readonly `string`[]

##### options?

[`ProviderServeOptions`](ProviderServeOptions.md)

#### Returns

`Promise`\<[`ProviderServer`](ProviderServer.md)\>

***

### version()

> **version**(`name`): `Promise`\<`string` \| `null`\>

#### Parameters

##### name

`string`

#### Returns

`Promise`\<`string` \| `null`\>
