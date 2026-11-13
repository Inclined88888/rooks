
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: LineSessionOptions

> **LineSessionOptions** = `object`

## Properties

### codec

> `readonly` **codec**: [`LinesCodec`](LinesCodec.md)

***

### host

> `readonly` **host**: `Pick`\<[`SessionHost`](SessionHost.md), `"emit"`\>

***

### initialStdin

> `readonly` **initialStdin**: `string` \| `null`

***

### io

> `readonly` **io**: [`SessionStdio`](SessionStdio.md)

***

### transport

> `readonly` **transport**: `"stdio-persistent"` \| `"process-per-turn"`

## Methods

### onActivity()?

> `optional` **onActivity**(): `void`

#### Returns

`void`

***

### onCodecError()?

> `optional` **onCodecError**(`error`, `line`): `void`

#### Parameters

##### error

`unknown`

##### line

`string`

#### Returns

`void`

***

### onOverflow()?

> `optional` **onOverflow**(): `void`

#### Returns

`void`
