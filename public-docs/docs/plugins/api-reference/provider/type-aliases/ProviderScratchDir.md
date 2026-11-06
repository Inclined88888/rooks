
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: ProviderScratchDir

> **ProviderScratchDir** = `object`

## Properties

### path

> `readonly` **path**: `string`

## Methods

### has()

> **has**(`name`): `boolean`

#### Parameters

##### name

`string`

#### Returns

`boolean`

***

### link()

> **link**(`source`, `name`): [`ScratchLinkMethod`](ScratchLinkMethod.md)

#### Parameters

##### source

`string`

##### name

`string`

#### Returns

[`ScratchLinkMethod`](ScratchLinkMethod.md)

***

### remove()

> **remove**(`name`): `void`

#### Parameters

##### name

`string`

#### Returns

`void`

***

### resolve()

> **resolve**(`name`): `string`

#### Parameters

##### name

`string`

#### Returns

`string`

***

### writeFile()

> **writeFile**(`name`, `content`, `options?`): `string`

#### Parameters

##### name

`string`

##### content

`string` \| `Uint8Array`\<`ArrayBufferLike`\>

##### options?

[`ScratchWriteOptions`](ScratchWriteOptions.md)

#### Returns

`string`
