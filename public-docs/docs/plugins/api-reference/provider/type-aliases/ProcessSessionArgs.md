
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: ProcessSessionArgs

> **ProcessSessionArgs** = `Omit`\<[`SessionOpenArgs`](SessionOpenArgs.md), `"profileId"` \| `"launch"`\> & `object`

## Type Declaration

### initialStdin?

> `readonly` `optional` **initialStdin?**: `string` \| `null`

### onActivity()?

> `optional` **onActivity**(): `void`

#### Returns

`void`

### onCodecError()?

> `optional` **onCodecError**(`error`, `line`): `void`

#### Parameters

##### error

`unknown`

##### line

`string`

#### Returns

`void`

### onOverflow()?

> `optional` **onOverflow**(): `void`

#### Returns

`void`
