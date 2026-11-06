
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: ProviderLoginDriver

> **ProviderLoginDriver** = `object`

## Properties

### inPlace?

> `readonly` `optional` **inPlace?**: (`platform`) => `boolean`

#### Parameters

##### platform

`NodeJS.Platform`

#### Returns

`boolean`

***

### promptKind

> `readonly` **promptKind**: [`ProviderLoginPrompt`](ProviderLoginPrompt.md)\[`"kind"`\]

***

### ttlMs?

> `readonly` `optional` **ttlMs?**: `number`

## Methods

### args()

> **args**(`expectedLabel`): `string`[]

#### Parameters

##### expectedLabel

`string` \| `null`

#### Returns

`string`[]

***

### env()

> **env**(`dir`, `base`): `Record`\<`string`, `string`\>

#### Parameters

##### dir

`string`

##### base

`Readonly`\<`Record`\<`string`, `string`\>\>

#### Returns

`Record`\<`string`, `string`\>

***

### identity()

> **identity**(`dir`, `run`): `Promise`\<[`ProviderLoginIdentity`](ProviderLoginIdentity.md) \| `null`\>

#### Parameters

##### dir

`string`

##### run

[`ProviderLoginRun`](ProviderLoginRun.md)

#### Returns

`Promise`\<[`ProviderLoginIdentity`](ProviderLoginIdentity.md) \| `null`\>

***

### install()

> **install**(`staging`, `dest`): `void`

#### Parameters

##### staging

`string`

##### dest

`string`

#### Returns

`void`

***

### parse()

> **parse**(`output`): [`ProviderLoginPrompt`](ProviderLoginPrompt.md) \| `null`

#### Parameters

##### output

`string`

#### Returns

[`ProviderLoginPrompt`](ProviderLoginPrompt.md) \| `null`

***

### signOut()

> **signOut**(`dir`, `run`): `Promise`\<`void`\>

#### Parameters

##### dir

`string`

##### run

[`ProviderLoginRun`](ProviderLoginRun.md)

#### Returns

`Promise`\<`void`\>
